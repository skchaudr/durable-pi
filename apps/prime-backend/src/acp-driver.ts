// PrimeDriver over Prime's daemon protocol (not ACP; the name is historical). One socket to the supervisor carries every
// session; each session keeps a Translator (src/prime/translate.ts) that turns Prime session events into dpi events.
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentConfig, ModelInfo, ThinkingLevel, WhenBusy, WireAgentEvent, WireAgentState, WireSnapshotEvent } from "../../dpi-sdk/src/api.js";
import type { BackendConfig } from "./config.js";
import type { PrimeAgentHandle, PrimeChild, PrimeDriver } from "./driver.js";
import { ApiFault, invalid } from "./errors.js";
import { DaemonClient, PrimeError, type ClientOptions, type SessionEventFrame } from "./prime/client.js";
import { launchEnv, primeEnv } from "./prime/env.js";
import { readDefaultModel, readModels } from "./prime/models.js";
import { Translator, messagesToEntries } from "./prime/translate.js";
import * as ext from "./prime/extend.js";
import { forkPoint } from "./prime/fork.js";
import { PrimeTasks } from "./prime/tasks.js";
import * as comp from "./prime/compaction.js";

export interface DriverOptions extends ClientOptions {
  socketPath?: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Initial connect attempts before createDriver throws (default 3). */
  connectAttempts?: number;
}

type Listener = (events: readonly WireAgentEvent[]) => void;

const fault = (e: unknown): never => {
  if (e instanceof ApiFault) throw e;
  if (e instanceof PrimeError) throw new ApiFault(e.transport || e.code === "model_provider_unauthenticated" ? "unavailable" : "invalid", e.message);
  throw e;
};

class PrimeSession implements PrimeAgentHandle {
  activeId = "";
  private translator?: Translator;
  private buffered: SessionEventFrame[] = []; // events that arrive while (re)opening
  private listeners = new Set<Listener>();
  private childListeners = new Set<() => void>();
  private agent: WireAgentState;
  private submission = Date.now(); // ids only need to grow, also across backend restarts

  constructor(
    private readonly client: DaemonClient,
    private readonly sessionDir: string,
    private readonly env: NodeJS.ProcessEnv | undefined,
    public primeSessionId: string,
    private cwd: string,
    private sessionFile: string | undefined,
    private readonly register: (s: PrimeSession) => void,
    private readonly idDir?: string,
  ) {
    this.agent = { cwd };
  }

  /** create (an existing session file revives its live worker) -> attach -> get_messages -> Translator. `made`: a create response already in hand. */
  async open(file: string, made?: any) {
    this.translator = undefined; // events buffer until the translator exists again
    made ??= await this.client.request({
      type: "create",
      lifecycle: "resident",
      launchEnv: launchEnv(this.env),
      sessionPath: file,
      config: { cwd: this.cwd, sessionDir: this.sessionDir },
    });
    this.activeId = made.activeSessionId;
    this.register(this); // from here on events for this session buffer until the translator is built
    const attached = await this.client.request({ type: "attach", activeSessionId: this.activeId });
    const state = attached?.snapshot?.state ?? attached?.snapshot?.summary ?? made;
    const lastSeq: number = attached?.snapshot?.lastEventSequence ?? 0;
    const entries = messagesToEntries(await this.loadMessages());
    // daemon get_rlm_children (state_getters.rs:30): the roster, for children that started before this attach.
    const roster: unknown[] = (await this.client.request({ type: "get_rlm_children", activeSessionId: this.activeId }).catch(() => undefined))?.children ?? [];
    this.cwd = state.cwd ?? this.cwd;
    this.agent = {
      ...(state.model ? { model: { provider: state.model.provider, modelId: state.model.id } } : {}),
      ...(state.thinkingLevel ? { thinkingLevel: state.thinkingLevel } : {}),
      cwd: this.cwd,
    };
    this.translator = new Translator({ entries, agent: this.agent });
    for (const c of roster) this.translator.setChild(c as Record<string, unknown>);
    const buffered = this.buffered.filter((f) => (f.meta?.sequence ?? Infinity) > lastSeq);
    this.buffered = [];
    for (const f of buffered) this.onEvent(f);
    return made;
  }

  private async loadMessages(activeSessionId = this.activeId): Promise<unknown[]> {
    let all: unknown[] = [];
    let before: string | undefined;
    for (let i = 0; i < 200; i++) {
      const page = await this.client.request({
        type: "get_messages",
        activeSessionId,
        page: { from: "end", ...(before ? { before } : {}), limit: 500 },
      });
      const messages: unknown[] = page?.messages ?? [];
      if (!messages.length) break;
      all = messages.concat(all);
      if (!page.more || !page.firstEntryId) break;
      before = page.firstEntryId;
    }
    return all;
  }

  /** Reopens after a supervisor restart (the active id changes) and tells subscribers to reset to a fresh snapshot. */
  async resync() {
    const file = this.sessionFile ?? (await sessionFile(this.sessionDir, this.primeSessionId));
    await this.open(file);
    this.emit([this.snapshot()]);
  }

  onEvent(frame: SessionEventFrame) {
    if (!this.translator) return void this.buffered.push(frame);
    let events: WireAgentEvent[];
    try {
      events = this.translator.apply(frame.event);
    } catch (e) {
      return void console.error(`[prime-backend] cannot translate ${frame.event?.type} for ${this.primeSessionId}:`, e);
    }
    if (frame.event?.type === "rlm_child_update") for (const fn of [...this.childListeners]) fn();
    if (events.length) this.emit(events);
  }

  private emit(events: readonly WireAgentEvent[]) {
    for (const fn of [...this.listeners]) fn(events);
  }

  snapshot(): WireSnapshotEvent {
    if (!this.translator) throw new ApiFault("unavailable", "Session is reconnecting to Prime");
    const snap = this.translator.snapshot();
    return { ...snap, agent: { ...snap.agent, ...this.agent } };
  }
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  busy() {
    return this.translator?.busy() ?? false;
  }
  children(): PrimeChild[] {
    return this.translator?.children() ?? [];
  }
  onChildren(fn: () => void) {
    this.childListeners.add(fn);
    return () => void this.childListeners.delete(fn);
  }
  /** Reads the child's session through its live id (get_messages); a child whose worker is gone has none, and Prime's error is the 400. */
  async childSnapshot(id: string) {
    const live = this.translator?.childRow(id)?.activeSessionId;
    if (typeof live !== "string" || !live) throw invalid(`Prime has no live session for child ${id}`);
    let messages: unknown[];
    try {
      messages = await this.loadMessages(live);
    } catch (e) {
      return fault(e);
    }
    return new Translator({ entries: messagesToEntries(messages), agent: { cwd: this.cwd } }).snapshot();
  }
  private taskSource?: PrimeTasks;
  tasks() {
    return (this.taskSource ??= new PrimeTasks(this.client, () => this.activeId, {
      idFile: this.idDir ? join(this.idDir, `task-ids-${this.primeSessionId}.json`) : undefined,
    }));
  }
  closeTasks() {
    this.taskSource?.close();
  }

  private get extendCtx(): ext.ExtendContext {
    return { client: this.client, agentDir: dirname(this.sessionDir), activeSessionId: this.activeId, sessionId: this.primeSessionId };
  }
  extensions() {
    return ext.extensions(this.extendCtx);
  }
  patchExtensions(body: unknown) {
    return ext.patch(this.extendCtx, body as Parameters<typeof ext.patch>[1]);
  }
  tools() {
    return ext.tools(this.extendCtx);
  }

  private get compactionCtx(): comp.CompactionContext {
    return { client: this.client, agentDir: dirname(this.sessionDir), activeSessionId: this.activeId };
  }
  async compaction() {
    return comp.compaction(this.compactionCtx).catch(fault);
  }
  async setCompaction(patch: Record<string, unknown>) {
    return comp.setCompaction(this.compactionCtx, patch).catch(fault);
  }

  /** Prime answers compact when the summary is done; dpi answers with the task as soon as it starts. A failure before the start is the caller's error. */
  async compact(instructions?: string) {
    if (this.busy()) throw new ApiFault("busy", "The agent is busy; Prime compacts only between turns");
    let taskId: number | undefined;
    let started!: () => void;
    const first = new Promise<void>((resolve) => (started = resolve));
    const off = this.subscribe((events) => {
      for (const e of events)
        if (e.type === "compaction_start") {
          taskId = e.taskId;
          started();
        }
    });
    const done = this.client.request({ type: "compact", activeSessionId: this.activeId, ...(instructions ? { customInstructions: instructions } : {}) }, 600000);
    done.then(off, off);
    // shortcut: a skip ("too short to compact") answers right after the start event, so give the answer 1s; a real summary takes longer.
    const grace = new Promise<void>((resolve) => setTimeout(resolve, 1000));
    try {
      await Promise.race([first, done]);
      await Promise.race([done, grace]);
    } catch (e) {
      fault(e);
    }
    if (taskId === undefined) throw new ApiFault("unavailable", "Prime finished compact without a compaction event");
    return { taskId };
  }

  /** new_session swaps the worker onto a new session file; the translator restarts from it. */
  async reset() {
    try {
      await this.client.request({ type: "new_session", activeSessionId: this.activeId });
      const state = await this.client.request({ type: "get_connection_state", activeSessionId: this.activeId });
      this.primeSessionId = state.sessionId;
      this.sessionFile = state.sessionFile;
      this.translator = new Translator({ entries: messagesToEntries(await this.loadMessages()), agent: this.agent });
    } catch (e) {
      fault(e);
    }
    this.emit([this.snapshot()]);
    return { primeSessionId: this.primeSessionId };
  }

  config(): AgentConfig {
    const { model, thinkingLevel, cwd } = this.agent;
    return { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ThinkingLevel } : {}), ...(cwd ? { cwd } : {}), readOnly: false };
  }

  async send(content: string, whenBusy: WhenBusy) {
    const submissionId = ++this.submission;
    try {
      if (!this.busy())
        // followUp + queueIfBusy is what Prime's own ACP client sends: it also resumes a queue suspended by an abort.
        await this.client.request({ type: "prompt", activeSessionId: this.activeId, message: content, streamingBehavior: "followUp", queueIfBusy: true }, 60000);
      else
        await this.client.request({ type: whenBusy === "steer" ? "steer" : "follow_up", activeSessionId: this.activeId, message: content }, 60000);
    } catch (e) {
      fault(e);
    }
    return { submissionId };
  }

  async abort() {
    try {
      await this.client.request({ type: "abort", activeSessionId: this.activeId });
    } catch (e) {
      fault(e);
    }
  }

  async setConfig(patch: Partial<AgentConfig>) {
    if (patch.instructions !== undefined) throw invalid("Prime sessions do not take per-session instructions");
    if (patch.readOnly) throw invalid("Prime sessions have no read-only mode");
    if (patch.cwd !== undefined && patch.cwd !== this.cwd) throw invalid("A Prime session cannot change its working folder");
    try {
      if (patch.model) {
        await this.client.request({ type: "set_model", activeSessionId: this.activeId, provider: patch.model.provider, modelId: patch.model.modelId });
        this.agent = { ...this.agent, model: patch.model };
      }
      if (patch.thinkingLevel) {
        await this.client.request({ type: "set_thinking_level", activeSessionId: this.activeId, level: patch.thinkingLevel });
        this.agent = { ...this.agent, thinkingLevel: patch.thinkingLevel };
      }
    } catch (e) {
      fault(e);
    }
    if (patch.model || patch.thinkingLevel) this.emit([{ type: "agent_changed", agent: { ...this.agent } }]);
    return this.config();
  }
}

/** <agent_dir>/sessions/<uuidv7>.jsonl, or a file whose name ends in the id (timestamp-prefixed names). */
async function sessionFile(dir: string, id: string) {
  const exact = `${id}.jsonl`;
  const names = await readdir(dir).catch(() => [] as string[]);
  const name = names.includes(exact) ? exact : names.find((n) => n.endsWith(`_${exact}`));
  if (!name) throw new ApiFault("not_found", `No Prime session file for ${id} in ${dir}`);
  return join(dir, name);
}

export default async function createDriver(_config?: BackendConfig, options: DriverOptions = {}): Promise<PrimeDriver> {
  const cfg = primeEnv(options.env);
  const socketPath = options.socketPath ?? cfg.socketPath;
  const agentDir = options.agentDir ?? cfg.agentDir;
  const sessionDir = join(agentDir, "sessions");
  const client = new DaemonClient(socketPath, options);
  await client.connect(options.connectAttempts ?? 3);

  const sessions = new Map<string, PrimeSession>(); // by primeSessionId
  const byActive = new Map<string, PrimeSession>();
  const track = (s: PrimeSession) => {
    for (const [k, v] of byActive) if (v === s) byActive.delete(k);
    byActive.set(s.activeId, s);
  };
  let closing = false;
  const resync = async (s: PrimeSession) => {
    for (let attempt = 1; !closing; attempt++) {
      try {
        return await s.resync();
      } catch (e) {
        if (attempt >= 5) return void console.error(`[prime-backend] session ${s.primeSessionId} did not come back:`, e);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  };

  client.on("session_event", (f: SessionEventFrame) => byActive.get(f.activeSessionId)?.onEvent(f));
  client.on("connected", (_hello, reconnect: boolean) => {
    if (reconnect) for (const s of sessions.values()) void resync(s);
  });
  client.on("frame", (f: any) => {
    if (f.type !== "session_binding") return; // supervisor rebound a session to a new active id
    const s = byActive.get(f.previousActiveSessionId);
    if (s) void resync(s);
  });

  const adopt = async (s: PrimeSession, file: string, made?: any) => {
    try {
      await s.open(file, made);
    } catch (e) {
      byActive.delete(s.activeId);
      fault(e);
    }
    sessions.set(s.primeSessionId, s);
  };
  const models: ModelInfo[] = readModels(agentDir);
  const defaultModel = readDefaultModel(agentDir, models);

  return {
    async createSession({ cwd, model, thinkingLevel }) {
      let made: any;
      try {
        made = await client.request({
          type: "create",
          lifecycle: "resident",
          launchEnv: launchEnv(options.env),
          config: { cwd, sessionDir, provider: model.provider, model: model.modelId, ...(thinkingLevel ? { thinking: thinkingLevel } : {}) },
        });
      } catch (e) {
        return fault(e);
      }
      const s = new PrimeSession(client, sessionDir, options.env, made.sessionId, cwd, made.sessionFile, track, _config?.dataDir);
      await adopt(s, made.sessionFile, made);
      return { primeSessionId: made.sessionId as string };
    },
    async forkSession(primeSessionId, entryId) {
      const src = sessions.get(primeSessionId);
      if (!src) throw new ApiFault("not_found", `No Prime session ${primeSessionId}`);
      if (src.busy()) throw new ApiFault("busy", "The agent is busy; Prime forks only between turns");
      const at = src.activeId;
      let forked: any;
      try {
        const point = forkPoint(await client.request({ type: "get_session_tree", activeSessionId: at }), src.snapshot().entries, entryId);
        const { sessionFile: back } = await client.request({ type: "get_state", activeSessionId: at });
        await client.request({ type: "fork", activeSessionId: at, entryId: point, position: "at" }, 90000);
        forked = await client.request({ type: "get_state", activeSessionId: at });
        // `fork` moves the source's worker onto the new file; move it back, then give the fork a worker of its own.
        await client.request({ type: "switch_session", activeSessionId: at, sessionPath: back }, 90000);
      } catch (e) {
        return fault(e);
      }
      // The supervisor's roster can still list the source's worker under the fork's file for a moment: create until it is a new one.
      let made: any;
      try {
        for (let i = 0; i < 20 && made?.sessionId !== forked.sessionId; i++) {
          if (i) await new Promise((r) => setTimeout(r, 100));
          made = await client.request({ type: "create", lifecycle: "resident", launchEnv: launchEnv(options.env), sessionPath: forked.sessionFile, config: { cwd: forked.cwd, sessionDir } });
        }
      } catch (e) {
        return fault(e);
      }
      if (made.sessionId !== forked.sessionId) throw new ApiFault("unavailable", "Prime did not open the forked session");
      await adopt(new PrimeSession(client, sessionDir, options.env, forked.sessionId, forked.cwd, forked.sessionFile, track, _config?.dataDir), forked.sessionFile, made);
      return { primeSessionId: forked.sessionId as string };
    },
    async openSession(primeSessionId, cwd) {
      if (sessions.has(primeSessionId)) return;
      const file = await sessionFile(sessionDir, primeSessionId);
      await adopt(new PrimeSession(client, sessionDir, options.env, primeSessionId, cwd, file, track, _config?.dataDir), file);
    },
    agent(primeSessionId) {
      const s = sessions.get(primeSessionId);
      if (!s) throw Error(`No Prime session ${primeSessionId}`);
      return s;
    },
    models: () => models,
    defaultModel: () => defaultModel,
    async close() {
      closing = true;
      for (const s of sessions.values()) s.closeTasks();
      await Promise.all([...byActive.keys()].map((id) => client.request({ type: "detach", activeSessionId: id }, 1000).catch(() => {})));
      client.close();
    },
  };
}
