// The device: catalog + driver, shaped as dpi-backend's Store is for the routes and streams.
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  AgentDetail,
  AgentSummary,
  CreateSessionBody,
  DeviceInfo,
  DeviceTree,
  DirListing,
  Page,
  SessionSummary,
  ThinkingLevel,
  UsageTotals,
  WhenBusy,
  WireEntry,
} from "../../dpi-sdk/src/api.js";
import { THINKING_LEVELS } from "../../dpi-sdk/src/api.js";
import { lastAssistantText, toMarkdown, toTranscript } from "../../dpi-sdk/src/transcript.js";
import { Catalog, type SessionRow } from "./catalog.js";
import type { PrimeAgentHandle, PrimeChild, PrimeDriver } from "./driver.js";
import { ApiFault, invalid, notFound } from "./errors.js";

export const DEVICE_DOC_KINDS = ["app.shared-state"];
export const AGENT_DOC_KINDS = ["demo.job-runs", "demo.workspace"];
/** The only agent a Prime session has in v1. */
export const MAIN_AGENT = 1;

export interface ServiceOptions {
  dataDir: string;
  startDirs: string[];
  name: string;
}

const encodeCursor = (id: number) => Buffer.from(JSON.stringify(id)).toString("base64url");
const decodeCursor = (cursor?: string): number | undefined => {
  if (!cursor) return undefined;
  try {
    const n = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof n === "number") return n;
  } catch {}
  throw invalid("Invalid cursor");
};

export class Service {
  readonly startedAt = Date.now();
  readonly catalog: Catalog;
  readonly handles = new Map<string, PrimeAgentHandle>();
  readonly errors = new Map<string, string>();
  private unsubs = new Map<string, () => void>();
  private listeners = new Set<() => void>();
  private sending = new Map<string, Promise<number>>();

  private constructor(
    readonly options: ServiceOptions,
    readonly driver: PrimeDriver,
  ) {
    this.catalog = new Catalog(options.dataDir);
  }

  /** Opens the catalog and reopens every non-archived session through the driver. */
  static async open(options: ServiceOptions, driver: PrimeDriver) {
    const svc = new Service({ ...options, dataDir: resolve(options.dataDir) }, driver);
    await Promise.all(options.startDirs.map((dir) => mkdir(dir, { recursive: true }).catch(() => {})));
    for (const row of svc.catalog.list()) {
      try {
        await driver.openSession(row.primeSessionId, row.cwd);
        svc.attach(row);
      } catch (e) {
        svc.errors.set(row.id, String(e instanceof Error ? e.message : e));
      }
    }
    return svc;
  }

  get uid() {
    return this.catalog.uid;
  }
  get name() {
    return this.options.name;
  }

  // ------------------------------------------------------------ change feed

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  notify = () => {
    for (const fn of this.listeners) fn();
  };

  private attach(row: SessionRow) {
    const handle = this.driver.agent(row.primeSessionId);
    this.handles.set(row.id, handle);
    this.errors.delete(row.id);
    // Busy flips and resets change the tree; everything else is for the agent stream only.
    const offEvents = handle.subscribe((events) => {
      if (events.some((e) => e.type === "run_start" || e.type === "run_end" || e.type === "snapshot")) this.notify();
    });
    const offChildren = handle.onChildren(this.notify);
    this.unsubs.set(row.id, () => {
      offEvents();
      offChildren();
    });
    return handle;
  }

  // ------------------------------------------------------------ device

  deviceInfo(): DeviceInfo {
    return {
      uid: this.uid,
      name: this.name,
      hostname: hostname(),
      platform: `${platform()}-${process.arch} node ${process.version}`,
      apiVersion: 1,
      durableVersion: "prime",
      startedAt: this.startedAt,
      startDirs: this.options.startDirs,
      models: this.driver.models(),
      defaultModel: this.driver.defaultModel(),
      storage: { dataDir: this.options.dataDir, catalogPath: this.catalog.path, appStatePath: "" },
      capabilities: ["events"],
    };
  }

  validateModel(model: unknown) {
    const m = model as { provider?: unknown; modelId?: unknown } | undefined;
    if (!m || typeof m.provider !== "string" || typeof m.modelId !== "string")
      throw invalid("model must be { provider, modelId }");
    if (!this.driver.models().some((x) => x.provider === m.provider && x.id === m.modelId))
      throw invalid(`Unknown model ${m.provider}/${m.modelId}. Choose one from GET /v1/device models`);
    return { provider: m.provider, modelId: m.modelId };
  }

  async directories(): Promise<DirListing> {
    const dirs: { name: string; path: string }[] = [];
    for (const root of this.options.startDirs) {
      try {
        dirs.push({ name: root, path: await realpath(root) });
      } catch {}
    }
    return { path: "", dirs };
  }

  async browse(path: string): Promise<DirListing> {
    if (!path) return this.directories();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let real: string;
    try {
      real = await realpath(resolve(expanded));
      if (!(await stat(real)).isDirectory()) throw Error();
    } catch {
      throw notFound(`Not a directory on ${this.name}: ${path}`);
    }
    const dirs: { name: string; path: string }[] = [];
    try {
      for (const entry of await readdir(real, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        dirs.push({ name: entry.name, path: join(real, entry.name) });
      }
    } catch (e) {
      throw new ApiFault("unavailable", `Cannot list ${real}: ${(e as Error).message}`);
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return { path: real, parent: dirname(real) !== real ? dirname(real) : undefined, dirs: dirs.slice(0, 500) };
  }

  // ------------------------------------------------------------ sessions

  list() {
    return this.catalog.list();
  }

  resolveSession(ref: string): SessionRow {
    const byId = this.catalog.get(ref);
    if (byId) return byId;
    const matches = this.catalog.byName(ref);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new ApiFault("ambiguous", `${matches.length} sessions are named "${ref}"; use the session id`);
    throw notFound(`No session "${ref}" on ${this.name}`);
  }

  handle(row: SessionRow): PrimeAgentHandle {
    const h = this.handles.get(row.id);
    if (!h) throw new ApiFault("unavailable", this.errors.get(row.id) ?? `Session ${row.name} is unavailable`);
    return h;
  }

  async create(body: CreateSessionBody): Promise<SessionSummary> {
    if (typeof body?.name !== "string") throw invalid("name is required");
    if (typeof body.cwd !== "string" || !body.cwd.trim()) throw invalid("cwd is required");
    const path = body.cwd.trim();
    const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
    let cwd: string;
    try {
      cwd = await realpath(resolve(this.options.startDirs[0] ?? homedir(), expanded));
      if (!(await stat(cwd)).isDirectory()) throw Error();
    } catch {
      throw invalid(`cwd must be an existing folder on ${this.name}`);
    }
    const model = this.validateModel(body.model);
    if (body.thinkingLevel !== undefined && !THINKING_LEVELS.includes(body.thinkingLevel)) throw invalid("Invalid thinking level");
    const { primeSessionId } = await this.driver.createSession({ cwd, model, thinkingLevel: body.thinkingLevel });
    const row: SessionRow = {
      id: randomUUID(),
      name: body.name.trim().slice(0, 100) || "Untitled session",
      cwd,
      provider: model.provider,
      model: model.modelId,
      thinkingLevel: body.thinkingLevel ?? null,
      createdAt: Date.now(),
      primeSessionId,
      archived: 0,
    };
    this.catalog.insert(row);
    this.attach(row);
    this.notify();
    return this.sessionSummary(row);
  }

  rename(row: SessionRow, name: unknown) {
    if (typeof name !== "string" || !name.trim()) throw invalid("A name is required");
    this.catalog.rename(row.id, name.trim().slice(0, 100));
    this.notify();
    return this.sessionSummary(this.resolveSession(row.id));
  }

  /** Stops the agent and hides the session; the catalog row stays, marked archived. */
  async archive(row: SessionRow) {
    const h = this.handles.get(row.id);
    if (h) await h.abort().catch(() => {});
    this.unsubs.get(row.id)?.();
    this.unsubs.delete(row.id);
    this.handles.delete(row.id);
    this.errors.delete(row.id);
    this.catalog.archive(row.id);
    this.notify();
    return { archived: row.id };
  }

  sessionSummary(row: SessionRow): SessionSummary {
    const base = {
      id: row.id,
      name: row.name,
      cwd: row.cwd,
      model: row.model,
      createdAt: row.createdAt,
      dbPath: `prime:${row.primeSessionId}`,
    };
    if (!this.handles.has(row.id)) return { ...base, busy: false, agents: [], error: this.errors.get(row.id) ?? "Session unavailable" };
    const agents = this.agents(row);
    return { ...base, busy: agents.some((a) => a.busy), agents };
  }

  tree(): DeviceTree {
    return { uid: this.uid, name: this.name, sessions: this.list().map((r) => this.sessionSummary(r)), at: Date.now() };
  }

  // ------------------------------------------------------------ agents

  /** The main agent, then Prime's child agents as subagents it owns. */
  agents(row: SessionRow): AgentSummary[] {
    const h = this.handle(row);
    const kids = h.children().map((c): AgentSummary => ({ id: c.agentId, name: c.name, named: false, kind: "subagent", ownerAgentId: MAIN_AGENT, busy: c.status === "running", background: 0 }));
    return [{ id: MAIN_AGENT, name: "Main", named: false, kind: "root", busy: h.busy(), background: 0 }, ...kids];
  }

  /** Agent `1`, `main` or the name `Main`; or one of Prime's child agents by its agent id (`child` is set then). */
  resolveAgent(sessionRef: string, agentRef: string): { row: SessionRow; h: PrimeAgentHandle; child?: PrimeChild } {
    const row = this.resolveSession(sessionRef);
    const h = this.handle(row);
    const ref = agentRef.toLowerCase();
    if (agentRef === String(MAIN_AGENT) || ref === "main") return { row, h };
    const child = h.children().find((c) => String(c.agentId) === agentRef);
    if (!child) throw notFound(`No agent "${agentRef}" in session ${row.name}`);
    return { row, h, child };
  }

  agentSummary(row: SessionRow): AgentSummary {
    return this.agents(row)[0];
  }

  async agentDetail(row: SessionRow, child?: PrimeChild): Promise<AgentDetail> {
    const h = this.handle(row);
    if (child) return { ...this.agents(row).find((a) => a.id === child.agentId)!, sessionId: row.id, config: {}, tools: [], extensions: [] };
    return { ...this.agentSummary(row), sessionId: row.id, config: h.config(), tools: await h.tools(), extensions: [] };
  }

  async configure(row: SessionRow, body: Record<string, unknown>): Promise<AgentConfig> {
    const patch: Partial<AgentConfig> = {};
    if (body.model !== undefined) patch.model = this.validateModel(body.model);
    if (body.thinkingLevel !== undefined) {
      if (!THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel)) throw invalid("Invalid thinking level");
      patch.thinkingLevel = body.thinkingLevel as ThinkingLevel;
    }
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== "string") throw invalid("instructions must be a string");
      patch.instructions = body.instructions.slice(0, 12000);
    }
    if (body.cwd !== undefined) {
      if (typeof body.cwd !== "string") throw invalid("cwd must be a string");
      patch.cwd = (await this.browse(body.cwd)).path;
    }
    if (body.readOnly !== undefined) {
      if (typeof body.readOnly !== "boolean") throw invalid("readOnly must be a boolean");
      patch.readOnly = body.readOnly;
    }
    const config = await this.handle(row).setConfig(patch);
    if (patch.model) this.catalog.setModel(row.id, patch.model.provider, patch.model.modelId);
    if (patch.thinkingLevel) this.catalog.setThinking(row.id, patch.thinkingLevel);
    this.notify();
    return config;
  }

  /** Dedupes on `requestId` (also across restarts); the driver sees each request once. */
  async send(row: SessionRow, body: Record<string, unknown>) {
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100000)
      throw invalid("content must be a message under 100,000 characters");
    const whenBusy = (body.whenBusy ?? "followUp") as WhenBusy;
    if (!["steer", "followUp", "reject"].includes(whenBusy)) throw invalid("whenBusy must be followUp, steer or reject");
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128)
      throw invalid("requestId is required (≤128 chars) so retries never submit twice");
    const key = `${row.id}\n${body.requestId}`;
    const pending = this.sending.get(key);
    if (pending) return { id: await pending };
    const known = this.catalog.sendLookup(row.id, body.requestId);
    if (known !== undefined) return { id: known };
    const h = this.handle(row);
    if (whenBusy === "reject" && h.busy()) throw new ApiFault("busy", "The agent is busy and the input asked to be rejected while busy");
    const run = h.send(body.content, whenBusy).then(({ submissionId }) => {
      this.catalog.sendRecord(row.id, body.requestId as string, submissionId);
      return submissionId;
    });
    this.sending.set(key, run);
    try {
      return { id: await run };
    } finally {
      this.sending.delete(key);
    }
  }

  /** background: dpi's "Stop all", which also stops background runs: on Prime, its schedules, heartbeats and goal. */
  async abort(row: SessionRow, background = false) {
    const h = this.handle(row);
    await h.abort();
    if (background) {
      const t = h.tasks();
      for (const task of await t.liveTasks()) await t.abort(task.id);
    }
    return { ok: true as const };
  }

  /** The main agent's live entries, or a child's as Prime holds them now. */
  async agentEntries(row: SessionRow, child?: PrimeChild): Promise<readonly WireEntry[]> {
    const h = this.handle(row);
    return child ? (await h.childSnapshot(child.id)).entries : h.snapshot().entries;
  }

  entries(source: readonly WireEntry[], cursor: string | undefined, limit: number): Page<WireEntry> {
    const after = decodeCursor(cursor);
    const all = [...source].sort((a, b) => a.id - b.id).filter((e) => after === undefined || e.id > after);
    const page = all.slice(0, Math.min(Math.max(limit || 500, 1), 2000));
    return { items: page, next: page.length < all.length ? encodeCursor(page[page.length - 1].id) : undefined };
  }

  transcript(source: readonly WireEntry[], format: string) {
    const items = toTranscript(JSON.parse(JSON.stringify(source)) as WireEntry[]);
    return format === "markdown" ? { format: "markdown", text: toMarkdown(items) } : { format: "json", items };
  }

  preview(row: SessionRow) {
    const h = this.handles.get(row.id);
    return h ? lastAssistantText(h.snapshot().entries)?.slice(0, 200) : undefined;
  }

  usage(row: SessionRow): UsageTotals {
    const u = this.handle(row).snapshot().usage;
    return JSON.parse(JSON.stringify({ models: u.models, tools: u.tools })) as UsageTotals;
  }

  // ------------------------------------------------------------ idempotency

  replay(key: string, route: string) {
    const row = this.catalog.replay(key, route);
    if (!row) return undefined;
    if (row.route !== route) throw invalid("Idempotency-Key was already used for a different request");
    return { status: row.status, body: row.body };
  }
  remember(key: string, route: string, status: number, body: unknown) {
    this.catalog.remember(key, route, status, body);
  }

  async close() {
    for (const off of this.unsubs.values()) off();
    this.unsubs.clear();
    this.handles.clear();
    await this.driver.close();
    this.catalog.close();
  }
}
