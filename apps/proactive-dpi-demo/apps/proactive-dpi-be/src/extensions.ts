import { Type, validateToolArguments, type Static, type TSchema } from "@earendil-works/pi-ai";
import {
  ToolTask,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  section,
  type ConversationId,
  type Session,
  type TaskId,
  type TaskOptions,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import type { Context } from "@earendil-works/chord";
import type { Deploy, Incident, IncidentStatus, StreamRow } from "../../../shared/types.ts";
import { verifyAndCommit } from "./repo.ts";
import type { WatchStore } from "./watch-store.ts";

/** One sandbox per process, as in dpi-backend/src/addons.ts: each script runs in its own worker thread. */
const codemodeSandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
export const closeCodemodeSandbox = () => codemodeSandbox.close();

/** The codemode tool: scripts call the agent's tools as await tools.<name>(args); its other tools stay offered directly. */
export const Codemode = createCodemodeExtension({ sandbox: codemodeSandbox, models: false });

/** Every incident the watcher opened. Session scoped: shared by all conversations, committed atomically. */
export const Incidents = defineDoc<{ seq: number; items: Record<string, Incident> }>({
  kind: "ops.incidents",
  version: 1,
  scope: "session",
  initial: () => ({ seq: 0, items: {} }),
});

/** Every deploy request and where its durable task stands. Session scoped, so any client can approve it. */
export const Deploys = defineDoc<{ items: Record<string, Deploy> }>({
  kind: "ops.deploys",
  version: 1,
  scope: "session",
  initial: () => ({ items: {} }),
});

/** The incident timeline. An agent reports each stage in order; submit_fix and the deploy finish it. */
const STAGES: IncidentStatus[] = [
  "starting",
  "investigating",
  "root_cause_found",
  "fix_in_progress",
  "ready_for_review",
  "deployed",
];

export function logLine(row: StreamRow): string {
  const v = row.verdict;
  const jev =
    v?.status === "judged"
      ? `jev=${v.decision} ${v.probability?.toFixed(2)}`
      : `jev=${v?.status ?? "pending"}`;
  const request = row.method ? `${row.method} ${row.route} ${row.status} ${row.latencyMs}ms ` : "";
  const error = row.errorType ? ` [${row.errorType}]` : "";
  return `#${row.id} ${row.ts} ${row.severity} ${row.service}@${row.revision} ${request}${row.message}${error} ${jev}`;
}

type DeployInput = { incidentId: string; commit: string };
type DeployState =
  | { phase: "approval" }
  | { phase: "rollout"; revision: string }
  | { phase: "verify"; revision: string; liveAt: number };
type DeployResult = {
  approved: boolean;
  note: string | null;
  revision: string | null;
  checkouts: number;
  guests: number;
  errors: number;
};

/** Where a tool runs: the commit line, and how to find the incident the caller owns in the incidents document. */
type Caller = {
  rt: Pick<Session, "commit" | "snapshot">;
  context: Context;
  own: (items: Record<string, Incident>) => Incident | undefined;
};
type Spec = { description: string; parameters: TSchema; run: (c: Caller, args: any) => Promise<string | object> };
const PENDING = ["awaiting_approval", "deploying", "verifying"];

export class NotFound extends Error {}

/** A tool's JSON schema with the incident_id remote agents pass, since no conversation says which incident is theirs. */
export const withIncidentId = (schema: TSchema) => {
  const s = schema as unknown as { properties: Record<string, unknown>; required?: string[] };
  return {
    ...s,
    properties: { incident_id: Type.String({ description: "Your incident id, from your brief" }), ...s.properties },
    required: ["incident_id", ...(s.required ?? [])],
  };
};

/**
 * The incident agent's playbook. In process the deploy blocks on the engineer; a remote agent (dpi or Prime) cannot,
 * so its deploy returns at once and the decision arrives as a message. `mcp` agents reach the tools from Prime's REPL.
 */
export function playbook(remote?: "tools" | "mcp") {
  return `You are an incident agent for Lumen Market. The proactive stream watcher started you on its own: Jev flagged a cluster of failing production log rows. The on-call engineer is not watching yet. Work the incident through every stage, in order, so they can follow the timeline when they arrive.
${
  remote
    ? `
${remote === "mcp" ? "Your incident tools are the MCP server incident-ops, reached from the Python REPL: mcp.list_tools('incident-ops') lists them and mcp.call_tool('incident-ops', name, {...}) calls one. Run each call in its own short cell." : "Your incident tools are query_logs, log_summary, list_incidents, update_incident, submit_fix and deploy."} Pass incident_id (given in your brief) in the arguments of every incident tool call.
`
    : ""
}
Your working directory is a git worktree of checkout-api, already on your incident branch, created from main. Main is what production runs.${remote ? "" : " Tool calls in one turn run in the order you write them."}

1. Investigate. ${remote ? "" : "In one turn: "}update_incident investigating, log_summary for the failing service, and query_logs for the failing rows with full=true and limit 2.
2. Locate. ${remote ? "Run" : "In one turn: bash with"} git log --oneline -5 and git show of the commit the failing revision was built from, and read the file at the top stack frame.
3. Fix. ${remote ? "" : "In one turn: "}update_incident root_cause_found with the root cause, update_incident fix_in_progress, then write the smallest fix and a regression test under test/ that reproduces the failure. The files are small: write each changed file in full.
4. Review. submit_fix. It proves the test fails on main and the suite passes with your fix, then commits on your branch.
5. Deploy. ${remote ? "Write a short review note (impact, root cause, fix, verification) and call deploy. It returns awaiting_approval at once. End your turn there: the engineer's decision arrives as a message from the ops service." : "In one message, write a short review note (impact, root cause, fix, verification) and call deploy. The deploy waits for the engineer's approval."}

When ${remote ? "the decision message arrives" : "deploy returns"}:
- Declined: acknowledge in one sentence. Answer the engineer's questions. Call deploy again only when they ask.
- Deployed: report the verification in two sentences.

Rules: never push, merge, rebase, switch branches, or touch main. Read logs with tools, not bash. Be concise.`;
}

export function createExtensions(deps: {
  store: WatchStore;
  /** Called after an incident changed; `announce` means the engineer should hear about it. */
  incidentChanged: (incident: Incident, announce: boolean) => void;
}) {
  /** Where a tool runs: a commit line (a tool task's api, or the harness for the remote API) and the incident it owns. */
  const callerOf = (rt: Pick<Session, "commit" | "snapshot">, context: Context, own: Caller["own"]): Caller => ({
    rt,
    context,
    own,
  });
  const NO_INCIDENT = "This agent does not own that incident.";

  const spec = <P extends TSchema>(
    description: string,
    parameters: P,
    run: (c: Caller, args: Static<P>) => Promise<string | object>,
  ): Spec => ({ description, parameters, run });

  async function ownIncident(c: Caller) {
    const incident = c.own((await c.rt.snapshot(Incidents, c.context))?.items ?? {});
    if (!incident) throw Error(NO_INCIDENT);
    return incident as Incident;
  }

  /** Applies one change to the caller's incident and records it on the timeline. */
  async function changeIncident(c: Caller, change: (item: Incident) => void) {
    const incident = await c.rt.commit(async (tx) => {
      const item = c.own((await tx.doc(Incidents)).items);
      if (!item) throw Error(NO_INCIDENT);
      change(item);
      item.updatedAt = Date.now();
      item.timeline.push({ at: item.updatedAt, status: item.status, summary: item.summary });
      return JSON.parse(JSON.stringify(item)) as Incident;
    }, c.context);
    deps.incidentChanged(incident, false);
    return incident;
  }

  /** The last stage reached, looking past a blocked report. */
  const stageOf = (item: Incident) =>
    item.status !== "blocked"
      ? item.status
      : ([...item.timeline].reverse().find((t) => t.status !== "blocked")?.status ?? "starting");

  /**
   * Files a deploy request awaiting the engineer and starts its durable task. `same` finds the request a repeated call
   * already made. Shared by the in-process tool (which then waits) and the remote tool API (which returns at once).
   */
  async function requestDeploy(
    c: Caller,
    summary: string,
    how: { toolTaskId: number; same: (d: Deploy, incident: Incident) => boolean; task: (i: Incident) => TaskOptions },
  ): Promise<{ done: string } | { id: TaskId<DeployResult>; incident: Incident; commit: string }> {
    const incident = await ownIncident(c);
    if (incident.status === "deployed") return { done: `Already deployed as ${incident.report.deployedRevision}.` };
    if (incident.status !== "ready_for_review" || !incident.report.commit)
      throw Error("Nothing to deploy yet. Run submit_fix first.");
    const commit = incident.report.commit;
    // A rerun after a crash finds the same request and keeps waiting on the same durable task.
    const { id, announce } = await c.rt.commit(async (tx) => {
      const deploys = await tx.doc(Deploys);
      const existing = Object.values(deploys.items).find((d) => how.same(d, incident));
      if (existing) return { id: existing.id as TaskId<DeployResult>, announce: false };
      const id = await tx.createTask(DeployTask, { incidentId: incident.id, commit }, how.task(incident));
      deploys.items[String(id)] = {
        id: Number(id),
        toolTaskId: how.toolTaskId,
        incidentId: incident.id,
        conversationId: incident.conversationId,
        commit,
        branch: incident.branch,
        summary,
        diffStat: incident.report.diffStat ?? "",
        status: "awaiting_approval",
        revision: null,
        requestedAt: Date.now(),
        decidedAt: null,
        note: null,
        verification: null,
      };
      const item = (await tx.doc(Incidents)).items[incident.id];
      const announce = !item.announced.ready;
      item.announced.ready = true;
      return { id, announce };
    }, c.context);
    deps.incidentChanged(incident, announce);
    return { id, incident, commit };
  }

  /** The tools, as plain functions: the in-process wrappers and the remote tool API both call these. */
  const specs: Record<string, Spec> = {
    query_logs: spec(
      "Search the production log stream (Google Cloud Logging, Cloud Run, project lumen-market-prod). Every row carries the Jev verdict the watcher gave it. Returns newest first. Use full=true for the complete JSON entry, including stack traces.",
      Type.Object({
        since_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "Default 30" })),
        service: Type.Optional(Type.String({ description: "checkout-api, catalog-api, cart-api, auth-api, payments-webhook" })),
        route: Type.Optional(Type.String({ description: "Route template, such as /v1/checkout" })),
        min_severity: Type.Optional(
          Type.Union(["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR"].map((s) => Type.Literal(s))),
        ),
        status: Type.Optional(Type.Integer({ description: "HTTP status" })),
        revision: Type.Optional(Type.String()),
        text: Type.Optional(Type.String({ description: "Substring of the raw entry: message, error, stack trace, customer fields" })),
        jev: Type.Optional(
          Type.Union([Type.Literal("normal"), Type.Literal("suspicious"), Type.Literal("incident")]),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Default 30" })),
        full: Type.Optional(Type.Boolean()),
      }),
      async (_c, args) => {
        const rows = deps.store.query({
          sinceMinutes: args.since_minutes,
          service: args.service,
          route: args.route,
          severity: args.min_severity,
          status: args.status,
          revision: args.revision,
          text: args.text,
          decision: args.jev,
          limit: args.limit,
        });
        const text = rows.length
          ? rows.map((row) => (args.full ? `${logLine(row)}\n${JSON.stringify(row.entry)}` : logLine(row))).join("\n")
          : "No matching rows.";
        return `${rows.length} rows, newest first\n${text}`;
      },
    ),

    log_summary: spec(
      "Aggregate the log stream: rows, errors, 5xx, and Jev verdicts per minute; traffic per revision; deploy notices; and the fingerprints Jev flagged. Use it to size impact and line the start of a failure up with a deploy.",
      Type.Object({
        since_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "Default 15" })),
        service: Type.Optional(Type.String()),
      }),
      async (_c, args) => JSON.stringify(deps.store.summary(args.since_minutes ?? 15, args.service), null, 1),
    ),

    list_incidents: spec("List incidents the watcher opened, with status, branch, and report.", Type.Object({}), async (c) => {
      const doc = await c.rt.snapshot(Incidents, c.context);
      const items = Object.values(doc?.items ?? {}).map(({ timeline: _, ...incident }) => incident);
      return items.length ? JSON.stringify(items, null, 1) : "No incidents.";
    }),

    update_incident: spec(
      "Move your incident to its next stage on the timeline the engineer watches: investigating, then root_cause_found, then fix_in_progress. Stages go in order and none can be skipped. Use blocked if you cannot proceed. submit_fix and deploy finish the timeline.",
      Type.Object({
        status: Type.Union([
          Type.Literal("investigating"),
          Type.Literal("root_cause_found"),
          Type.Literal("fix_in_progress"),
          Type.Literal("blocked"),
        ]),
        summary: Type.String({ description: "One or two sentences for the engineer" }),
        root_cause: Type.Optional(Type.String()),
      }),
      async (c, args) => {
        const incident = await changeIncident(c, (item) => {
          const next = STAGES.indexOf(args.status as IncidentStatus);
          const reached = STAGES.indexOf(stageOf(item));
          if (args.status !== "blocked" && next > reached + 1)
            throw Error(`Report ${STAGES[reached + 1]} first. Stages go in order and none can be skipped.`);
          item.status = args.status as IncidentStatus;
          item.summary = args.summary;
          if (args.root_cause) item.report.rootCause = args.root_cause;
        });
        return `${incident.id} is now ${incident.status}.`;
      },
    ),

    submit_fix: spec(
      "Move the incident to ready_for_review after fix_in_progress. Proves the fix: the changed tests under test/ must fail on main's code and the whole suite must pass on your branch. Then it commits everything on your incident branch. If verification fails it explains why and changes nothing; fix the problem and call it again.",
      Type.Object({
        summary: Type.String({ description: "One or two sentences for the engineer" }),
        root_cause: Type.String(),
        fix: Type.String({ description: "What the change does" }),
        commit_message: Type.String({ description: "fix(<area>): <what> (<incident id>)" }),
      }),
      async (c, args) => {
        const found = await ownIncident(c);
        if (!["fix_in_progress", "ready_for_review"].includes(stageOf(found)))
          throw Error("Report fix_in_progress with update_incident first.");
        const proof = verifyAndCommit(found.worktree, args.commit_message);
        const tests = `Regression test on main: ${proof.before}\nFull suite with the fix: ${proof.after}`;
        const incident = await changeIncident(c, (item) => {
          item.status = "ready_for_review";
          item.summary = args.summary;
          item.report = {
            rootCause: args.root_cause,
            fix: args.fix,
            tests,
            commit: proof.head,
            diffStat: proof.diffStat,
            deployedRevision: null,
          };
        });
        return `Committed ${proof.head} on ${incident.branch}. ${incident.id} is ready for review.\n${tests}\n${proof.diffStat}`;
      },
    ),

    // Remote agents cannot block on a tool call (Prime's MCP calls time out at 60s), so this returns at once. The
    // decision reaches the agent as a message (ops.decideDeploy).
    deploy: spec(
      "Ship the fix on your incident branch to production. Asks the on-call engineer to approve and returns at once with status awaiting_approval; the engineer's decision arrives later as a message from the ops service. Call it only after submit_fix. If the engineer declines, do not call it again until they ask.",
      Type.Object({ summary: Type.String({ description: "One sentence: what ships and why it is safe" }) }),
      async (c, args) => {
        const r = await requestDeploy(c, args.summary, {
          toolTaskId: 0,
          same: (d, i) => d.toolTaskId === 0 && d.incidentId === i.id && PENDING.includes(d.status),
          task: (i) => ({ ownership: { kind: "conversation" }, conversationId: i.conversationId as ConversationId, background: true }),
        });
        if ("done" in r) return r.done;
        return {
          status: "awaiting_approval",
          deployId: Number(r.id),
          text: `Deploy ${Number(r.id)} of ${r.commit} is awaiting the engineer's approval. End your turn; the decision arrives as a message.`,
        };
      },
    ),
  };

  /** One in-process tool: the spec run against the calling conversation's own incident. */
  const inproc = (name: string) =>
    defineTool({
      name,
      description: specs[name].description,
      parameters: specs[name].parameters,
      replay: "safe",
      execute: async (args, api, context) => {
        const c = callerOf(api, context, (items) => Object.values(items).find((i) => i.conversationId === api.conversationId));
        const r = await specs[name].run(c, args);
        return { output: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }] };
      },
    });

  /** The remote tool API: validates the arguments, then runs the spec against the incident the caller names. */
  async function callTool(rt: Pick<Session, "commit" | "snapshot">, context: Context, name: string, incidentId: string, args: unknown) {
    const s = Object.hasOwn(specs, name) ? specs[name] : undefined;
    if (!s) throw new NotFound(`Unknown tool ${name}`);
    const valid = validateToolArguments(
      { name, description: s.description, parameters: s.parameters },
      { type: "toolCall", id: "api", name, arguments: (args ?? {}) as never },
    );
    const r = await s.run(callerOf(rt, context, (items) => items[incidentId]), valid);
    return typeof r === "string" ? { text: r } : r;
  }

  /** Name, description and JSON schema of each tool, each with the incident_id that selects the caller's incident. */
  const toolInfo = () =>
    Object.entries(specs).map(([name, s]) => ({ name, description: s.description, inputSchema: withIncidentId(s.parameters) }));

  // Approve, roll out, verify. Each phase is checkpointed, so a backend restart resumes the deploy where it stood,
  // including the wait for the engineer. Waiting polls a committed document; Durable Pi has no built-in signal.
  const DeployTask = defineTask<DeployInput, DeployState, DeployResult>({
    name: "ops.deploy",
    version: 1,
    initial: () => ({ phase: "approval" }),
    phases: {
      approval: async (task, runtime, context) => {
        for (;;) {
          const request = (await runtime.snapshot(Deploys, context))?.items[String(task.id)];
          if (request?.status === "declined") {
            await runtime.commit(
              () => ({
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: { approved: false, note: request.note, revision: null, checkouts: 0, guests: 0, errors: 0 },
                },
              }),
              context,
            );
            return;
          }
          if (request?.status === "deploying") {
            await runtime.commit(async (tx) => {
              const deploys = await tx.doc(Deploys);
              const seq = 43 + Object.values(deploys.items).filter((d) => d.revision).length;
              const revision = `checkout-api-${String(seq).padStart(5, "0")}-${task.input.commit.slice(0, 3)}`;
              deploys.items[String(task.id)].revision = revision;
              return { status: "running", checkpoint: { phase: "rollout", revision } };
            }, context);
            return;
          }
          await runtime.sleep(runtime.now() + 400, context);
        }
      },
      rollout: async (task, runtime, context) => {
        const { revision } = task.state.checkpoint as { revision: string };
        deps.store.requestDeploy({ id: Number(task.id), commit: task.input.commit, revision });
        const deadline = runtime.now() + 30_000;
        while (deps.store.deployed()?.id !== Number(task.id)) {
          if (runtime.now() > deadline) {
            await runtime.commit(async (tx) => {
              (await tx.doc(Deploys)).items[String(task.id)].status = "failed";
              return {
                status: "terminal",
                outcome: { status: "failed", error: { message: "The log stream did not roll out the revision within 30s." } },
              };
            }, context);
            return;
          }
          await runtime.sleep(runtime.now() + 250, context);
        }
        await runtime.commit(async (tx) => {
          (await tx.doc(Deploys)).items[String(task.id)].status = "verifying";
          return { status: "running", checkpoint: { phase: "verify", revision, liveAt: runtime.now() } };
        }, context);
      },
      verify: async (task, runtime, context) => {
        const { revision, liveAt } = task.state.checkpoint as { revision: string; liveAt: number };
        let stats = deps.store.checkoutStats(revision);
        while (stats.checkouts < 3 && runtime.now() < liveAt + 20_000) {
          await runtime.sleep(runtime.now() + 400, context);
          stats = deps.store.checkoutStats(revision);
        }
        const ok = stats.checkouts > 0 && stats.errors === 0;
        await runtime.commit(async (tx) => {
          const request = (await tx.doc(Deploys)).items[String(task.id)];
          request.status = ok ? "deployed" : "failed";
          request.verification = stats;
          if (!ok)
            return {
              status: "terminal",
              outcome: {
                status: "failed",
                error: { message: `${revision} served ${stats.checkouts} checkouts with ${stats.errors} errors.` },
              },
            };
          const incident = (await tx.doc(Incidents)).items[task.input.incidentId];
          incident.status = "deployed";
          incident.summary = `${revision} is live: ${stats.checkouts} checkouts, ${stats.guests} from guests, 0 errors.`;
          incident.report.deployedRevision = revision;
          incident.updatedAt = runtime.now();
          incident.timeline.push({ at: incident.updatedAt, status: "deployed", summary: incident.summary });
          return {
            status: "terminal",
            outcome: { status: "completed", result: { approved: true, note: request.note, revision, ...stats } },
          };
        }, context);
        const incident = (await runtime.snapshot(Incidents, context))?.items[task.input.incidentId];
        if (incident) deps.incidentChanged(incident as Incident, false);
      },
    },
    // Interrupt aborts the deploy call, and with it this task: nothing ships after a cancel.
    abort: async (task, runtime, context) => {
      deps.store.cancelDeploy(Number(task.id));
      await runtime.commit(async (tx) => {
        const request = (await tx.doc(Deploys)).items[String(task.id)];
        if (request && PENDING.includes(request.status))
          request.status = "cancelled";
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context);
    },
  });

  const PROGRESS: Record<string, string> = {
    awaiting_approval: "Waiting for the engineer to approve the deploy.",
    deploying: "Approved. Rolling out a new checkout-api revision.",
    verifying: "The revision is live. Verifying guest checkouts.",
  };

  const deploy = defineTool({
    name: "deploy",
    description:
      "Ship the fix on your incident branch to production. Asks the on-call engineer to approve and waits durably for the decision, through restarts. When approved, it rolls out a new checkout-api revision built from your commit and verifies live guest checkouts. Call it only after submit_fix. If the engineer declines, do not call it again until they ask.",
    parameters: specs.deploy.parameters,
    replay: "safe",
    execute: async (args, api, context) => {
      const c = callerOf(api, context, (items) => Object.values(items).find((i) => i.conversationId === api.conversationId));
      const r = await requestDeploy(c, (args as { summary: string }).summary, {
        toolTaskId: Number(api.taskId),
        same: (d) => d.toolTaskId === Number(api.taskId),
        task: () => ({ ownership: { kind: "task", taskId: api.taskId } }),
      });
      if ("done" in r) return { output: [{ type: "text", text: r.done }] };
      const { id, commit } = r;
      await api.details({ deployTaskId: Number(id) }, context);

      // Stream each stage of the durable task into this call's live output.
      let shown = "";
      const report = async () => {
        const status = (await api.snapshot(Deploys, context))?.items[String(id)]?.status ?? "";
        if (status === shown || !PROGRESS[status]) return;
        shown = status;
        api.output(`${PROGRESS[status]}\n`);
      };
      await report();
      const progress = setInterval(() => void report().catch(() => {}), 400);
      let settled;
      try {
        settled = await api.waitForTask(id, context);
      } finally {
        clearInterval(progress);
      }
      const outcome = settled.state.outcome;
      if (outcome.status === "completed" && outcome.result.approved) {
        const r = outcome.result;
        return {
          output: [
            {
              type: "text",
              text: `Deployed ${commit} as ${r.revision}. Verified on live traffic: ${r.checkouts} checkouts, ${r.guests} from guests, ${r.errors} errors.`,
            },
          ],
        };
      }
      if (outcome.status === "completed")
        return {
          output: [
            {
              type: "text",
              text: `The engineer declined the deploy${outcome.result.note ? `: ${outcome.result.note}` : ""}. Nothing shipped. Wait for their direction and call deploy again only if they ask.`,
            },
          ],
        };
      throw Error(outcome.status === "failed" ? `Deploy failed: ${outcome.error.message}` : `Deploy ${outcome.status}.`);
    },
  });

  const OpsTools = defineExtension({
    name: "ops-tools",
    tools: [inproc("query_logs"), inproc("log_summary"), inproc("list_incidents")],
  });

  const Desk = defineExtension({
    name: "ops-desk",
    sections: [
      section(
        "ops_desk",
        () =>
          `You are the Ops desk agent for Lumen Market, an online store running on Google Cloud Run. A proactive watcher sends every production log row to Jev, which labels it normal, suspicious, or incident. When labels with the same fingerprint cluster, the watcher opens an incident and starts a dedicated durable incident agent in its own conversation, on its own git branch of checkout-api. You answer the on-call engineer's questions about the live stream and the open incidents with query_logs, log_summary, and list_incidents. Be brief and specific: numbers, times, revisions. You do not change code.`,
        { tag: false },
      ),
    ],
  });

  const BLOCKED_GIT =
    /\bgit\s+(push|merge|rebase|switch|worktree|reset\s+--hard|branch\s+-[dDmM]|checkout\s+(-b|-B|main\b|master\b))/;
  const IncidentAgent = defineExtension({
    name: "incident-agent",
    tools: [inproc("update_incident"), inproc("submit_fix"), deploy],
    tasks: [DeployTask],
    sections: [
      section(
        "incident_playbook",
        () => playbook(),
        { tag: false },
      ),
    ],
    hooks: [
      hook(ToolTask, {
        beforeTool: (call) => {
          if (call.name !== "bash") return undefined;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          if (BLOCKED_GIT.test(command))
            return {
              block:
                "Blocked by the incident guard. Stay on your incident branch: no push, merge, rebase, branch switching, or worktree changes. A human reviews and merges.",
            };
          return undefined;
        },
      }),
    ],
  });

  return { OpsTools, Desk, IncidentAgent, callTool, toolInfo };
}
