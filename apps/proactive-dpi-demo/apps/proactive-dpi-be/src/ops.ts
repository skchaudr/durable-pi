// One Durable Pi harness for the whole demo. The root conversation is the Ops desk.
// Every incident gets its own ownerless conversation, opened in the same commit as its record.
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import {
  Harness,
  configure,
  createRegistry,
  type Conversation,
  type ConversationId,
  type ModelRef,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { agentDbPath, repoDir, worktreesDir } from "../../../shared/paths.ts";
import { lockFile } from "../../../shared/lock.ts";
import type { Deploy, Incident } from "../../../shared/types.ts";
import { config } from "./config.ts";
import { inprocRunner, recordNote, remoteRunner, type AgentRunner, type Remote } from "./agents.ts";
import { Codemode, Deploys, Incidents, closeCodemodeSandbox, createExtensions, logLine } from "./extensions.ts";
import { curatedModels } from "./model-catalog.ts";
import { ensureWorktree } from "./repo.ts";
import type { Voice } from "./voice.ts";
import type { WatchStore } from "./watch-store.ts";
import type { Trigger } from "./watcher.ts";

const PROVIDER = "cliproxy";

/** A catalog entry as a chat model on CLIProxyAPI's OpenAI-compatible endpoint (as the dpi backend's operator models). */
function cliproxyModel(c: (typeof curatedModels)[number]): Model<"openai-completions"> {
  const reasoning = "reasoning" in c && c.reasoning;
  return {
    id: c.id,
    name: c.name,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl: config.cliproxyUrl,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" } } : {}),
    input: [...c.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: c.contextWindow,
    maxTokens: c.maxTokens,
  };
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];

export class Ops extends EventEmitter {
  private openFingerprints = new Set<string>();
  private readonly runner: AgentRunner;
  private sentDeploys = new Map<number, string>();
  private publishing = false;
  private republish = false;

  private constructor(
    readonly harness: Harness,
    readonly root: Conversation,
    readonly models: ReturnType<typeof createModels>,
    private readonly extensions: ReturnType<typeof createExtensions>,
    private readonly store: WatchStore,
    private readonly voice: Voice,
    private readonly unlock: () => void,
  ) {
    super();
    this.runner = config.remote
      ? remoteRunner(config.agentBackend as Remote["backend"], config.remote)
      : inprocRunner((id) => this.conversation(id));
  }

  static async open(store: WatchStore, voice: Voice) {
    const models = createModels();
    // The agent runs on CLIProxyAPI, the endpoint the dpi backend uses, so turns go to already-paid subscriptions.
    models.setProvider(
      createProvider({
        id: PROVIDER,
        name: "CLIProxyAPI",
        baseUrl: config.cliproxyUrl,
        auth: { apiKey: envApiKeyAuth("CLIProxyAPI API key", ["CLIPROXY_API_KEY"]) },
        models: curatedModels.map(cliproxyModel),
        api: openAICompletionsApi(),
      }),
    );
    if (!models.getModel(PROVIDER, config.model))
      throw Error(`${config.model} is not in model-catalog.ts (CLIProxyAPI ids, e.g. ${curatedModels[0].id})`);
    let ops: Ops | undefined;
    const extensions = createExtensions({
      store,
      incidentChanged: (incident, announce) => ops?.incidentChanged(incident, announce),
    });
    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(extensions.OpsTools);
    registry.install(extensions.Desk);
    registry.install(extensions.IncidentAgent);

    const unlock = lockFile(`${agentDbPath}.lock`);
    try {
      // The agent's shell gets the basics only. API keys stay in this process.
      const shellEnv = Object.fromEntries(
        ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"].flatMap((k) =>
          process.env[k] ? [[k, process.env[k]]] : [],
        ),
      );
      const harness = await Harness.open(
        await openNodeSqliteStorage(agentDbPath),
        {
          models,
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? repoDir, shellEnv }),
          settings: {
            progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
            // Tool calls run in the order the agent writes them, so its timeline reads in order.
            toolExecution: "sequential",
          },
          onReport: (e) => console.error("[durable]", e),
        },
        ctx,
      );
      const root = await harness.root(ctx, {
        agent: {
          model: { provider: PROVIDER, modelId: config.model },
          thinkingLevel: config.thinking,
          extensions: [extensions.OpsTools, extensions.Desk, Codemode],
          cwd: repoDir,
        },
      });
      ops = new Ops(harness, root, models, extensions, store, voice, unlock);
      harness.subscribeCommits(() => setTimeout(() => void ops?.publishDeploys(), 20));
      harness.resume();
      await ops.recover();
      return ops;
    } catch (e) {
      unlock();
      throw e;
    }
  }

  async incidents(): Promise<Incident[]> {
    const doc = await this.harness.snapshot(Incidents, ctx);
    return Object.values(doc?.items ?? {}).sort((a, b) => b.openedAt - a.openedAt) as Incident[];
  }

  /** Every deploy request, each with where its incident's agent runs. */
  async deploys(): Promise<Deploy[]> {
    const [doc, incidents] = await Promise.all([this.harness.snapshot(Deploys, ctx), this.incidents()]);
    const remote = new Map(incidents.map((i) => [i.id, i.remote]));
    return Object.values(doc?.items ?? {}).map((d) => ({ ...d, remote: remote.get(d.incidentId) }) as Deploy);
  }

  /** Emits a `deploy` event for each deploy that changed since the last commit looked at. Runs one at a time. */
  private async publishDeploys() {
    if (this.publishing) return void (this.republish = true);
    this.publishing = true;
    do {
      this.republish = false;
      try {
        for (const d of await this.deploys()) {
          const json = JSON.stringify(d);
          if (this.sentDeploys.get(d.id) === json) continue;
          this.sentDeploys.set(d.id, json);
          this.emit("deploy", d);
        }
      } catch {} // the harness is closing
    } while (this.republish);
    this.publishing = false;
  }

  /** After a restart: every incident has its worktree and its brief, exactly once. */
  private async recover() {
    for (const incident of await this.incidents()) {
      this.openFingerprints.add(incident.fingerprint);
      ensureWorktree(incident.branch, incident.worktree);
      void this.kickoff(incident);
    }
  }

  async openIncident(trigger: Trigger) {
    if (this.openFingerprints.has(trigger.fingerprint)) return;
    const rows = this.store.rows(trigger.logIds.slice(-12));
    const first = rows[0];
    const latest = rows.at(-1)!;
    const errorType = latest.errorType ?? (latest.status ? `HTTP ${latest.status}` : "anomaly");
    const title = `${latest.service}${latest.route ? ` ${latest.method} ${latest.route}` : ""}: ${errorType} ${trigger.decision === "incident" ? "failures" : "warnings"}`;
    const { incident, created } = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(Incidents);
      const existing = Object.values(doc.items).find((i) => i.fingerprint === trigger.fingerprint);
      if (existing) return { incident: JSON.parse(JSON.stringify(existing)) as Incident, created: false };
      doc.seq += 1;
      const id = `INC-${String(doc.seq).padStart(4, "0")}`;
      const slug = id.toLowerCase();
      const worktree = join(worktreesDir, slug);
      const branch = `incident/${slug}`;
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, {
        model: { provider: PROVIDER, modelId: config.model },
        thinkingLevel: config.thinking,
        extensions: [CodingTools, this.extensions.OpsTools, this.extensions.IncidentAgent, Codemode],
        cwd: worktree,
        instructions: `You own ${id}: ${title}. Your worktree is ${worktree}, on branch ${branch}.`,
      });
      const now = Date.now();
      const commit = latest.entry.labels?.commit_sha ?? null;
      const incident: Incident = {
        id,
        title,
        fingerprint: trigger.fingerprint,
        service: latest.service,
        trigger: trigger.decision,
        status: "starting",
        summary: `Jev labeled ${trigger.logIds.length} rows ${trigger.decision}. A durable agent is starting.`,
        conversationId: conversation.id,
        branch,
        worktree,
        openedAt: now,
        updatedAt: now,
        evidence: { logIds: rows.map((r) => r.id), firstSeen: first.ts, revision: latest.revision, commit },
        report: { rootCause: null, fix: null, tests: null, commit: null, diffStat: null, deployedRevision: null },
        timeline: [{ at: now, status: "starting", summary: `Opened by the watcher: ${trigger.fingerprint}` }],
        announced: { opened: true, ready: false },
      };
      doc.items[id] = incident;
      return { incident, created: true };
    }, ctx);
    this.openFingerprints.add(trigger.fingerprint);
    if (!created) return;
    console.log(`[ops] ${this.elapsed()} ${incident.id} opened: ${incident.title}`);
    ensureWorktree(incident.branch, incident.worktree);
    if (config.announceOpen)
      this.voice.say(config.openedSpeech.replace("{service}", incident.service.replace(/-api$/, "")));
    void this.kickoff(incident);
    this.emit("incident", incident);
  }

  /** Time since the log stream started, the clock the demo is timed against. */
  private elapsed() {
    const started = Number(this.store.control().started_at);
    return started ? `T+${((Date.now() - started) / 1000).toFixed(1)}s` : "";
  }

  /**
   * Starts the incident's agent on its brief; the runner makes that exactly-once, so a retry after a crash is safe.
   * Never rejects: a failure is logged and recorded on the incident, which is blocked.
   */
  private async kickoff(incident: Incident) {
    incident = { ...incident }; // the runner records where a remote agent lives; a document snapshot is read only
    const note = async (text: string, failed = false) => {
      console.log(`[ops] ${this.elapsed()} ${incident.id} ${failed ? "agent failed to start" : "agent"}: ${text}`);
      this.emit("incident", await recordNote(this.harness, incident.id, failed ? `Agent failed to start: ${text}` : text, failed));
    };
    try {
      await this.runner.start(incident, this.brief(incident), {
        note,
        save: async (remote) => {
          await this.harness.commit(async (tx) => {
            (await tx.doc(Incidents)).items[incident.id].remote = remote;
          }, ctx);
          incident.remote = remote;
        },
      });
    } catch (e) {
      await note((e as Error).message, true).catch((err) => console.error(`[ops] could not record the failure of ${incident.id}: ${err}`));
    }
  }

  private brief(incident: Incident) {
    const rows = this.store.rows(incident.evidence.logIds);
    const stack = rows.find((r) => r.severity === "ERROR")?.entry.jsonPayload?.stack_trace;
    return `${incident.id} opened automatically by the proactive stream watcher at ${new Date(incident.openedAt).toISOString()}.

Jev labeled ${rows.length} log rows "${incident.trigger}" with the same fingerprint inside ${config.windowMs / 1000}s:
  ${incident.fingerprint}

Flagged rows, oldest first:
${rows.map(logLine).join("\n")}
${stack ? `\nStack trace:\n${stack}\n` : ""}
Your worktree ${incident.worktree} is checkout-api on branch ${incident.branch}, created from main. Work the incident through every stage of your playbook.`;
  }

  /** Tells a remote agent something, exactly once per request ID. A failure is logged: the decision itself is committed. */
  private async tell(incident: Incident | undefined, requestId: string, text: string) {
    if (!incident?.remote) return;
    try {
      await this.runner.tell?.(incident, requestId, text);
    } catch (e) {
      console.error(`[ops] could not tell ${incident.id} (${requestId}): ${(e as Error).message}`);
    }
  }

  private incidentChanged(incident: Incident, announce: boolean) {
    if (incident.status === "deployed") void this.tell(incident, `deploy:${incident.id}:live`, incident.summary);
    if (announce) {
      console.log(`[ops] ${this.elapsed()} ${incident.id} awaiting deploy approval: ${incident.report.commit}`);
      this.voice.say(config.readySpeech);
    }
    this.emit("incident", incident);
  }

  async conversation(cid: number) {
    const conversation = await this.harness.conversation(cid as ConversationId, ctx);
    if (!conversation) throw Error("Conversation not found");
    return conversation;
  }

  async snapshot(cid: number) {
    const conversation = await this.conversation(cid);
    const view = await conversation.viewState(ctx);
    try {
      const [incidents, agent, deploys] = await Promise.all([
        this.incidents(),
        conversation.agent(ctx),
        this.harness.snapshot(Deploys, ctx),
      ]);
      return {
        conversationId: cid,
        view: view.value,
        incidents,
        deploys: Object.values(deploys?.items ?? {}).filter((d) => d.conversationId === cid) as Deploy[],
        tools: agent.tools.map((t) => t.name),
        serverTime: Date.now(),
      };
    } finally {
      view.dispose();
    }
  }

  modelList() {
    return curatedModels.flatMap((c) => {
      const m = this.models.getModel(PROVIDER, c.id);
      return m
        ? [{ id: m.id, provider: PROVIDER, name: c.name, tier: c.tier, icon: c.icon, contextWindow: m.contextWindow }]
        : [];
    });
  }

  async action(cid: number, action: string, body: Record<string, unknown>) {
    const conversation = await this.conversation(cid);
    switch (action) {
      case "send": {
        if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100_000)
          throw Error("Enter a message under 100,000 characters");
        if (!["steer", "followUp", "reject"].includes(String(body.whenBusy)))
          throw Error("Invalid queue mode");
        if (typeof body.requestId !== "string" || body.requestId.length > 128)
          throw Error("requestId required");
        const submission = await conversation.submit(
          {
            type: "input",
            content: body.content,
            requestId: body.requestId,
            whenBusy: body.whenBusy as "steer" | "followUp" | "reject",
          },
          ctx,
        );
        return { id: submission.id };
      }
      case "interrupt":
        await conversation.abort(ctx);
        return { ok: true };
      case "withdraw":
        return {
          status: await this.harness.abortSubmission(Number(body.submissionId) as SubmissionId, ctx, conversation.id),
        };
      case "configure": {
        const model = body.model as ModelRef | undefined;
        if (model && (model.provider !== PROVIDER || !this.models.getModel(PROVIDER, model.modelId)))
          throw Error("Choose a model from the list");
        if (body.thinkingLevel !== undefined && !THINKING.includes(String(body.thinkingLevel)))
          throw Error("Invalid thinking level");
        await conversation.configure(
          {
            ...(model ? { model } : {}),
            ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel as "low" } : {}),
          },
          ctx,
        );
        return { ok: true };
      }
      default:
        throw Error("Unknown action");
    }
  }

  /** The engineer's decision. The deploy's durable task picks it up from the committed document; a remote agent hears of it by message. */
  async decideDeploy(id: number, approved: boolean, note: string | null) {
    const { incidentId, commit } = await this.harness.commit(async (tx) => {
      const request = (await tx.doc(Deploys)).items[String(id)];
      if (!request) throw Error("Deploy not found");
      if (request.status !== "awaiting_approval") throw Error(`This deploy is already ${request.status}`);
      request.status = approved ? "deploying" : "declined";
      request.decidedAt = Date.now();
      request.note = note;
      return { incidentId: request.incidentId, commit: request.commit };
    }, ctx);
    console.log(`[ops] ${this.elapsed()} deploy ${id} ${approved ? "approved" : "declined"}`);
    const why = note ? `: ${note}` : "";
    await this.tell(
      (await this.incidents()).find((i) => i.id === incidentId),
      `deploy:${id}:decision`,
      approved
        ? `Deploy ${id} of ${commit} was approved by the on-call engineer${why}. It is rolling out and being verified on live traffic. You will get another message when it is live.`
        : `Deploy ${id} was declined by the on-call engineer${why}. Nothing shipped. Acknowledge in one sentence. Call deploy again only if they ask.`,
    );
  }

  /** The remote tool API (tool-api.ts): a remote agent's tool call against its incident. */
  callTool(name: string, incidentId: string, args: unknown) {
    return this.extensions.callTool(this.harness, ctx, name, incidentId, args);
  }
  toolInfo() {
    return this.extensions.toolInfo();
  }

  async close() {
    try {
      await this.harness.close(ctx);
    } finally {
      await closeCodemodeSandbox();
      this.unlock();
    }
  }
}
