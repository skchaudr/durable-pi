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
import { Catalog, type AgentRow, type SessionRow } from "./catalog.js";
import type { PrimeAgentHandle, PrimeChild, PrimeDriver } from "./driver.js";
import { ApiFault, invalid, notFound } from "./errors.js";

export const DEVICE_DOC_KINDS = ["app.shared-state"];
export const AGENT_DOC_KINDS = ["demo.job-runs", "demo.workspace"];
/** The session's own Prime session; agents made with `POST .../agents` and `.../fork` are rows in the catalog. */
export const MAIN_AGENT = 1;
/** `handles`, `errors` and `unsubs` key the root agent by the session id and any other agent by `session:agent`. */
const key = (sessionId: string, agent = MAIN_AGENT) => (agent === MAIN_AGENT ? sessionId : `${sessionId}:${agent}`);

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
    for (const row of svc.catalog.list()) await svc.reopen(row);
    return svc;
  }

  /** Reopens a session's root and extra agents through the driver; failures are recorded per agent, not thrown. */
  private async reopen(row: SessionRow) {
    try {
      await this.driver.openSession(row.primeSessionId, row.cwd);
      this.attach(row);
    } catch (e) {
      this.errors.set(row.id, String(e instanceof Error ? e.message : e));
      return;
    }
    for (const a of this.catalog.agents(row.id)) {
      try {
        await this.driver.openSession(a.primeSessionId, row.cwd);
        this.attach(row, a.id, a.primeSessionId);
      } catch (e) {
        this.errors.set(key(row.id, a.id), String(e instanceof Error ? e.message : e));
      }
    }
  }

  archived() {
    return this.catalog.archived().map(({ id, name, cwd, createdAt, archivedAt }) => ({ id, name, cwd, createdAt, archivedAt }));
  }

  /** Brings an archived session back by id and reopens its agents. */
  async unarchive(id: string) {
    const row = this.catalog.getArchived(id);
    if (!row) throw notFound(`No archived session ${id}`);
    this.catalog.unarchive(id);
    await this.reopen(row);
    this.notify();
    return this.sessionSummary(row);
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

  private attach(row: SessionRow, agent = MAIN_AGENT, primeSessionId = row.primeSessionId) {
    const k = key(row.id, agent);
    const handle = this.driver.agent(primeSessionId);
    this.handles.set(k, handle);
    this.errors.delete(k);
    // Busy flips and resets change the tree; everything else is for the agent stream only.
    const offEvents = handle.subscribe((events) => {
      if (events.some((e) => e.type === "run_start" || e.type === "run_end" || e.type === "snapshot")) this.notify();
    });
    const offChildren = handle.onChildren(this.notify);
    this.unsubs.set(k, () => {
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

  handle(row: SessionRow, agent = MAIN_AGENT): PrimeAgentHandle {
    const h = this.handles.get(key(row.id, agent));
    if (!h) throw new ApiFault("unavailable", this.errors.get(key(row.id, agent)) ?? `Session ${row.name} is unavailable`);
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
    for (const [k, h] of this.handles) {
      if (k !== row.id && !k.startsWith(`${row.id}:`)) continue;
      await h.abort().catch(() => {});
      this.unsubs.get(k)?.();
      this.unsubs.delete(k);
      this.handles.delete(k);
      this.errors.delete(k);
    }
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
    const others = this.catalog.agents(row.id).map((a) => ({
      id: a.id,
      name: a.name ?? `${a.kind === "fork" ? "Fork" : "Root"} #${a.id}`,
      named: a.name !== null,
      kind: a.kind,
      ...(a.parentId !== null ? { parentId: a.parentId, forkedAt: a.forkedAt ?? undefined } : {}),
      busy: this.handles.get(key(row.id, a.id))?.busy() ?? false,
      background: 0,
    }));
    const kids = h.children().map((c): AgentSummary => ({ id: c.agentId, name: c.name, named: false, kind: "subagent", ownerAgentId: MAIN_AGENT, busy: c.status === "running", background: 0 }));
    return [{ id: MAIN_AGENT, name: "Main", named: false, kind: "root", busy: h.busy(), background: 0 }, ...others, ...kids];
  }

  /** Agent by numeric id, `main` or unique name (custom or derived, case-insensitive). A Prime child agent answers with `child` set and the main handle. */
  resolveAgent(sessionRef: string, agentRef: string): { row: SessionRow; id: number; h: PrimeAgentHandle; child?: PrimeChild } {
    const row = this.resolveSession(sessionRef);
    this.handle(row);
    const agents = this.agents(row);
    const found = /^\d+$/.test(agentRef)
      ? agents.filter((a) => a.id === Number(agentRef))
      : agents.filter((a) => a.name.toLowerCase() === agentRef.toLowerCase());
    if (found.length > 1) throw new ApiFault("ambiguous", `${found.length} agents are named "${agentRef}"`);
    if (!found.length) throw notFound(`No agent "${agentRef}" in session ${row.name}`);
    const id = found[0].id;
    const child = this.handle(row).children().find((c) => c.agentId === id);
    return { row, id, h: this.handle(row, child ? MAIN_AGENT : id), ...(child ? { child } : {}) };
  }

  agentSummary(row: SessionRow, agent = MAIN_AGENT): AgentSummary {
    return this.agents(row).find((a) => a.id === agent)!;
  }

  async agentDetail(row: SessionRow, agent = MAIN_AGENT, child?: PrimeChild): Promise<AgentDetail> {
    const base = { ...this.agentSummary(row, agent), sessionId: row.id };
    if (child) return { ...base, config: {}, tools: [], extensions: [] };
    const h = this.handle(row, agent);
    return { ...base, config: h.config(), tools: await h.tools(), extensions: [] };
  }

  /** Stores and attaches an agent whose Prime session already exists, then answers with its summary. */
  private addAgent(row: SessionRow, a: Omit<AgentRow, "sessionId" | "id">) {
    const stored = this.catalog.insertAgent({ sessionId: row.id, ...a });
    this.attach(row, stored.id, a.primeSessionId);
    this.notify();
    return this.agentSummary(row, stored.id);
  }

  /** dpi's rule for agent names: no numbers, and not "main". */
  private agentName(name: unknown): string | null {
    if (typeof name !== "string" || !name.trim()) return null;
    const clean = name.trim().slice(0, 100);
    if (/^\d+$/.test(clean) || clean.toLowerCase() === "main") throw invalid("Agent names cannot be numbers or 'main'");
    return clean;
  }

  /** A new Prime session with the model, thinking level and folder of `from` (default: Main). */
  async createAgent(row: SessionRow, body: { from?: unknown; name?: unknown }) {
    const name = this.agentName(body.name);
    const cfg = this.resolveAgent(row.id, String(body.from ?? MAIN_AGENT)).h.config();
    const { primeSessionId } = await this.driver.createSession({
      cwd: cfg.cwd ?? row.cwd,
      model: cfg.model ?? { provider: row.provider, modelId: row.model },
      thinkingLevel: cfg.thinkingLevel,
    });
    return this.addAgent(row, { primeSessionId, name, kind: "root", parentId: null, forkedAt: null });
  }

  /** A new Prime session holding the history of `agent` up to and including entry `body.entryId`. */
  async fork(row: SessionRow, agent: number, body: { entryId?: unknown; name?: unknown }) {
    const at = Number(body.entryId);
    if (!Number.isSafeInteger(at)) throw invalid("entryId is required");
    if (body.name !== undefined && typeof body.name !== "string") throw invalid("Invalid fork name");
    const name = this.agentName(body.name);
    const source = agent === MAIN_AGENT ? row.primeSessionId : this.catalog.agents(row.id).find((a) => a.id === agent)!.primeSessionId;
    const { primeSessionId } = await this.driver.forkSession(source, at);
    return this.addAgent(row, { primeSessionId, name, kind: "fork", parentId: agent, forkedAt: at });
  }

  async configure(row: SessionRow, body: Record<string, unknown>, agent = MAIN_AGENT): Promise<AgentConfig> {
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
    const config = await this.handle(row, agent).setConfig(patch);
    if (agent === MAIN_AGENT && patch.model) this.catalog.setModel(row.id, patch.model.provider, patch.model.modelId);
    if (agent === MAIN_AGENT && patch.thinkingLevel) this.catalog.setThinking(row.id, patch.thinkingLevel);
    this.notify();
    return config;
  }

  /** Prime's new_session starts a new session file; the catalog follows it so a backend restart reopens the new one. */
  async reset(row: SessionRow, note: unknown) {
    if (typeof note === "string" && note.trim()) throw invalid("Prime has no handoff note on a new session");
    const { primeSessionId } = await this.handle(row).reset();
    this.catalog.setPrimeSession(row.id, primeSessionId);
    this.notify();
    return { ok: true as const };
  }

  /** Dedupes on `requestId` (also across restarts); the driver sees each request once. */
  async send(row: SessionRow, body: Record<string, unknown>, agent = MAIN_AGENT) {
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 100000)
      throw invalid("content must be a message under 100,000 characters");
    const whenBusy = (body.whenBusy ?? "followUp") as WhenBusy;
    if (!["steer", "followUp", "reject"].includes(whenBusy)) throw invalid("whenBusy must be followUp, steer or reject");
    if (typeof body.requestId !== "string" || !body.requestId || body.requestId.length > 128)
      throw invalid("requestId is required (≤128 chars) so retries never submit twice");
    const scope = key(row.id, agent);
    const sending = `${scope}\n${body.requestId}`;
    const pending = this.sending.get(sending);
    if (pending) return { id: await pending };
    const known = this.catalog.sendLookup(scope, body.requestId);
    if (known !== undefined) return { id: known };
    const h = this.handle(row, agent);
    if (whenBusy === "reject" && h.busy()) throw new ApiFault("busy", "The agent is busy and the input asked to be rejected while busy");
    const run = h.send(body.content, whenBusy).then(({ submissionId }) => {
      this.catalog.sendRecord(scope, body.requestId as string, submissionId);
      return submissionId;
    });
    this.sending.set(sending, run);
    try {
      return { id: await run };
    } finally {
      this.sending.delete(sending);
    }
  }

  /** background: dpi's "Stop all", which also stops background runs: on Prime, its schedules, heartbeats and goal. */
  async abort(row: SessionRow, background = false, agent = MAIN_AGENT) {
    const h = this.handle(row, agent);
    await h.abort();
    if (background) {
      const t = h.tasks();
      for (const task of await t.liveTasks()) await t.abort(task.id);
    }
    return { ok: true as const };
  }

  /** An agent's live entries, or a Prime child's as Prime holds them now. */
  async agentEntries(row: SessionRow, agent = MAIN_AGENT, child?: PrimeChild): Promise<readonly WireEntry[]> {
    return child ? (await this.handle(row).childSnapshot(child.id)).entries : this.handle(row, agent).snapshot().entries;
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
