// An in-memory PrimeDriver for tests. `send` plays a turn shaped like dpi-sdk/tests/fixtures/agent-tool-turn.json:
// user entry, assistant tool call, tool output, tool result, final assistant text, run_end.
import { randomUUID } from "node:crypto";
import type {
  AgentConfig,
  CompactionSettings,
  ModelInfo,
  ThinkingLevel,
  WhenBusy,
  WireAgentEvent,
  WireEntry,
  WireMessage,
  WireSnapshotEvent,
  WireUsage,
} from "../../dpi-sdk/src/api.js";
import type { PrimeGoal, PrimeGoalAction, PrimeGoalResult, PrimeHeartbeatAction, PrimeJob, PrimeWork } from "../../dpi-sdk/src/prime.js";
import type { PrimeAgentHandle, PrimeChild, PrimeDriver, TaskSource } from "./driver.js";
import { ApiFault, invalid } from "./errors.js";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const usage = (): WireUsage => ({
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export class FakeAgent implements PrimeAgentHandle {
  entries: WireEntry[] = [];
  sends: { content: string; whenBusy: WhenBusy }[] = [];
  aborts = 0;
  compacts: (string | undefined)[] = [];
  autoCompaction = true;
  private listeners = new Set<(events: readonly WireAgentEvent[]) => void>();
  private running?: number;
  private nextEntry = 1;
  private nextSubmission = 1;
  private release?: () => void;
  private cfg: AgentConfig;
  private totals: { models: Record<string, WireUsage>; tools: Record<string, WireUsage> } = { models: {}, tools: {} };

  constructor(
    private readonly owner: FakeDriver,
    cwd: string,
    model: { provider: string; modelId: string },
    thinkingLevel: ThinkingLevel = "low",
  ) {
    this.cfg = { model, thinkingLevel, cwd, readOnly: false };
  }

  snapshot(): WireSnapshotEvent {
    return JSON.parse(
      JSON.stringify({
        type: "snapshot",
        entries: this.entries,
        ...(this.running !== undefined ? { run: { inputs: [this.running] } } : {}),
        tools: [],
        compactions: [],
        inbox: [],
        agent: { model: this.cfg.model, thinkingLevel: this.cfg.thinkingLevel, cwd: this.cfg.cwd },
        usage: this.totals,
      }),
    );
  }
  subscribe(fn: (events: readonly WireAgentEvent[]) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  busy() {
    return this.running !== undefined;
  }
  config() {
    return { ...this.cfg };
  }
  async extensions() {
    return { extensions: [], builtIn: [] };
  }
  async patchExtensions(): Promise<never> {
    throw invalid("No extensions on the fake driver");
  }
  async tools() {
    return [];
  }
  /** Prime child agents: set `kids` and call `emitChildren()`. `childEntries` is what each child's transcript reads. */
  kids: PrimeChild[] = [];
  childEntries = new Map<string, WireEntry[]>();
  private childListeners = new Set<() => void>();
  children() {
    return this.kids.map((k) => ({ ...k }));
  }
  onChildren(fn: () => void) {
    this.childListeners.add(fn);
    return () => void this.childListeners.delete(fn);
  }
  emitChildren() {
    for (const fn of [...this.childListeners]) fn();
  }
  async childSnapshot(id: string) {
    const entries = this.childEntries.get(id);
    if (!entries) throw invalid(`Prime has no live session for child ${id}`);
    return { ...this.snapshot(), entries };
  }
  private taskSource?: FakeTasks;
  tasks() {
    return (this.taskSource ??= new FakeTasks(this));
  }
  async compaction(): Promise<CompactionSettings> {
    return { enabled: this.autoCompaction, reserveTokens: 16384, backgroundTokens: 0, keepRecentTokens: 20000 };
  }
  compactionNow(): CompactionSettings {
    return { enabled: this.autoCompaction, reserveTokens: 16384, backgroundTokens: 0, keepRecentTokens: 20000 };
  }
  async setCompaction(patch: Record<string, unknown>) {
    if (patch.reserveTokens !== undefined) throw invalid("No reserveTokens on the fake driver");
    if (typeof patch.enabled === "boolean") this.autoCompaction = patch.enabled;
    return this.compaction();
  }
  async compact(instructions?: string) {
    if (this.busy()) throw new ApiFault("busy", "The agent is busy; Prime compacts only between turns");
    this.compacts.push(instructions);
    return { taskId: this.compacts.length };
  }
  async reset() {
    this.entries = [];
    const primeSessionId = `fake-${randomUUID()}`;
    this.owner.agents.set(primeSessionId, this);
    this.emit([this.snapshot()]);
    return { primeSessionId };
  }
  async setConfig(patch: Partial<AgentConfig>) {
    this.cfg = { ...this.cfg, ...patch };
    this.emit([{ type: "agent_changed", agent: { model: this.cfg.model, thinkingLevel: this.cfg.thinkingLevel, cwd: this.cfg.cwd } }]);
    return this.config();
  }

  emit(events: WireAgentEvent[]) {
    for (const fn of [...this.listeners]) fn(events);
  }

  private entry(kind: string, model: WireMessage[]): WireEntry {
    return { id: this.nextEntry++, conversationId: 1, kind, model };
  }

  async send(content: string, whenBusy: WhenBusy) {
    this.sends.push({ content, whenBusy });
    const submissionId = this.nextSubmission++;
    if (this.running === undefined) {
      this.running = submissionId;
      void this.turn(content, submissionId);
    }
    return { submissionId };
  }

  async abort() {
    this.aborts++;
    if (this.running === undefined) return;
    const inputs = [this.running];
    this.running = undefined;
    this.release?.();
    this.emit([{ type: "run_end", inputs }]);
  }

  private async turn(content: string, submission: number) {
    const step = this.owner.stepMs;
    await delay(step);
    const user = this.entry("pi.user", [{ role: "user", content, timestamp: Date.now() } as WireMessage]);
    this.entries.push(user);
    this.emit([
      { type: "message_start", message: user.model![0] },
      { type: "message_end", entry: user },
      { type: "run_start", inputs: [submission] },
      { type: "turn_start" },
    ]);
    if (this.owner.hold) await new Promise<void>((r) => (this.release = r));
    if (this.running === undefined) return;
    await delay(step);
    const callId = `tool:${Date.now()}:fake`;
    const toolCall = { type: "toolCall" as const, id: callId, name: "bash", arguments: { command: "echo hi" } };
    const first = { role: "assistant" as const, content: [{ type: "text" as const, text: "Running it." }, toolCall], provider: "fake", model: "echo", usage: usage(), stopReason: "toolUse", timestamp: Date.now() };
    const assistant = this.entry("pi.assistant", [first]);
    this.entries.push(assistant);
    this.emit([{ type: "message_start", message: first }, { type: "message_end", entry: assistant }]);
    await delay(step);
    this.emit([{ type: "tool_execution_start", toolCallId: callId, toolName: "bash", args: toolCall.arguments }]);
    this.emit([{ type: "tool_execution_update", toolCallId: callId, toolName: "bash", output: { set: "hi\n" } }]);
    const result = this.entry("pi.tool-result", [
      { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: Date.now() } as WireMessage,
    ]);
    this.entries.push(result);
    this.emit([{ type: "tool_execution_end", toolCallId: callId, toolName: "bash", entry: result }, { type: "turn_end" }, { type: "turn_start" }]);
    await delay(step);
    if (this.running === undefined) return;
    const text = `Echo: ${content}`;
    const second = { role: "assistant" as const, content: [{ type: "text" as const, text: "" }], provider: "fake", model: "echo", usage: usage(), stopReason: "pending", timestamp: Date.now() };
    this.emit([{ type: "message_start", message: second }]);
    this.emit([{ type: "message_update", usage: usage(), changes: [{ type: "text_delta", contentIndex: 0, delta: text }] }]);
    const done = this.entry("pi.assistant", [{ ...second, content: [{ type: "text", text }], stopReason: "stop" }]);
    this.entries.push(done);
    this.running = undefined;
    this.totals.models["fake/echo"] = usage();
    this.emit([
      { type: "message_end", entry: done },
      { type: "turn_end" },
      { type: "run_end", inputs: [submission] },
      { type: "usage_changed", usage: { models: { "fake/echo": usage() }, tools: {} } },
    ]);
  }
}

const SCHEDULE_TEXT = /^(in \d+\s*[a-z]+|every \d+\s*[a-z]+|at \S+|\S+( \S+){4})$/i; // not Prime's parser, only enough to reject junk

/**
 * Prime's goal, heartbeat and schedules, in memory. `/goal` commands go through the agent's `send` (so tests see them in
 * `agent.sends`); sent while the agent is busy they wait and apply when its run ends, like Prime's queue.
 */
export class FakeTasks implements TaskSource {
  private goal: PrimeGoal | null = null;
  private jobs: (PrimeJob & { heartbeat: boolean })[] = [];
  private listeners = new Set<() => void>();
  private queued: string[] = [];
  private seq = 0;

  constructor(private readonly agent: FakeAgent) {
    agent.subscribe((events) => {
      if (!events.some((e) => e.type === "run_end") || agent.busy()) return;
      const waiting = this.queued.splice(0);
      for (const c of waiting) this.apply(c);
      if (waiting.length) this.changed();
    });
  }

  private changed() {
    for (const fn of [...this.listeners]) fn();
  }

  private apply(command: string) {
    const arg = command.replace(/^\/goal\s*/, "").trim();
    const g = this.goal;
    if (arg === "clear" || arg === "stop") this.goal = null;
    else if (arg === "pause" && g) this.goal = { ...g, status: "paused" };
    else if (arg === "resume" && g) this.goal = { ...g, status: "active" };
    else if (arg && arg !== "status") {
      const m = /^--budget (\d+) (.+)$/.exec(arg);
      this.goal = { status: "active", objective: m ? m[2] : arg, ...(m ? { tokenBudget: Number(m[1]) } : {}), tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 };
    }
  }

  /** Test hook: what a `goal_update` from Prime would do. */
  setGoalState(patch: Partial<PrimeGoal> | null) {
    this.goal = patch && ({ ...this.goal, ...patch } as PrimeGoal);
    this.changed();
  }

  async liveTasks() {
    return [];
  }
  async terminalTasks() {
    return [];
  }
  async abort(): Promise<void> {
    throw invalid("No task");
  }
  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  workNow(): PrimeWork {
    const strip = ({ heartbeat: _h, ...job }: PrimeJob & { heartbeat: boolean }): PrimeJob => job;
    return { goal: this.goal && { ...this.goal }, heartbeat: this.jobs.filter((j) => j.heartbeat).map(strip)[0] ?? null, schedules: this.jobs.filter((j) => !j.heartbeat).map(strip) };
  }
  async work() {
    return this.workNow();
  }

  private async command(message: string): Promise<PrimeGoalResult> {
    const queued = this.agent.busy();
    await this.agent.send(message, "followUp");
    if (queued) this.queued.push(message);
    else this.apply(message);
    this.changed();
    return { queued };
  }

  private add(heartbeat: boolean, input: Record<string, unknown>) {
    const schedule = String(input.schedule ?? (heartbeat ? "every 1h" : "")).trim();
    const prompt = String(input.prompt ?? "").trim();
    if (!SCHEDULE_TEXT.test(schedule)) throw invalid(`Invalid schedule "${schedule}"`);
    if (!prompt) throw invalid("prompt is required");
    if (input.deliveryMode !== undefined && input.deliveryMode !== "steer" && input.deliveryMode !== "follow_up") throw invalid('Heartbeat delivery mode must be "steer" or "follow_up"');
    if (heartbeat) this.jobs = this.jobs.filter((j) => !j.heartbeat); // a heartbeat replaces the previous one
    const job = { id: `fake-job-${++this.seq}`, status: "active" as const, schedule, prompt, runCount: 0, heartbeat, ...(heartbeat && input.deliveryMode ? { deliveryMode: input.deliveryMode as "steer" | "follow_up" } : {}) };
    this.jobs.push(job);
    return job;
  }
  private live(jobId: string, heartbeat: boolean) {
    const job = this.jobs.find((j) => j.id === jobId && j.heartbeat === heartbeat);
    if (!job) throw new ApiFault("not_found", `No live ${heartbeat ? "heartbeat" : "schedule"} ${jobId}`);
    return job;
  }

  async runJob(job: string, input: Record<string, unknown> = {}) {
    if (job === "prime.goal") {
      const objective = String(input.objective ?? "").trim();
      if (!objective) throw invalid("objective is required");
      const budget = Number(input.tokenBudget ?? 0);
      if (!Number.isInteger(budget) || budget < 0) throw invalid("tokenBudget must be an integer");
      const { queued } = await this.command(`/goal ${budget > 0 ? `--budget ${budget} ` : ""}${objective}`);
      return { taskId: queued ? 0 : 1, ...(queued ? { queued } : {}) };
    }
    if (job !== "prime.schedule" && job !== "prime.heartbeat") throw new ApiFault("not_found", `No Prime job "${job}"`);
    const made = this.add(job === "prime.heartbeat", input);
    this.changed();
    return { taskId: ++this.seq, jobId: made.id };
  }
  async goalCommand(action: PrimeGoalAction) {
    if (!["pause", "resume", "clear"].includes(action)) throw invalid("action must be pause, resume or clear");
    if (action !== "clear" && !this.goal) throw new ApiFault("conflict", "This session has no goal");
    return this.command(`/goal ${action}`);
  }
  async heartbeatAction(jobId: string, action: PrimeHeartbeatAction) {
    const job = this.live(jobId, true);
    if (action === "stop") this.jobs = this.jobs.filter((j) => j !== job);
    else job.status = action === "pause" ? "paused" : "active";
    this.changed();
  }
  async cancelSchedule(jobId: string) {
    this.jobs = this.jobs.filter((j) => j !== this.live(jobId, false));
    this.changed();
  }
  async editSchedule(jobId: string, input: Record<string, unknown>) {
    const old = this.live(jobId, false);
    const made = this.add(false, input);
    this.jobs = this.jobs.filter((j) => j !== old);
    this.changed();
    return { jobId: made.id, replaced: jobId };
  }
}

export class FakeDriver implements PrimeDriver {
  /** Keeps a run open after the user entry until `abort()`, to test busy handling. */
  hold = false;
  stepMs = 1;
  agents = new Map<string, FakeAgent>();
  opened: { primeSessionId: string; cwd: string }[] = [];
  closed = false;

  async createSession(opts: { cwd: string; model: { provider: string; modelId: string }; thinkingLevel?: ThinkingLevel }) {
    const primeSessionId = `fake-${randomUUID()}`;
    this.agents.set(primeSessionId, new FakeAgent(this, opts.cwd, opts.model, opts.thinkingLevel));
    return { primeSessionId };
  }
  async forkSession(primeSessionId: string, entryId: number) {
    const src = this.agent(primeSessionId);
    if (!src.entries.some((e) => e.id === entryId)) throw invalid(`Prime has no fork point for entry ${entryId}`);
    const { cwd, model, thinkingLevel } = src.config();
    const fork = new FakeAgent(this, cwd!, model!, thinkingLevel);
    fork.entries = src.entries.filter((e) => e.id <= entryId);
    const forkId = `fake-${randomUUID()}`;
    this.agents.set(forkId, fork);
    return { primeSessionId: forkId };
  }
  async openSession(primeSessionId: string, cwd: string) {
    this.opened.push({ primeSessionId, cwd });
    if (!this.agents.has(primeSessionId))
      this.agents.set(primeSessionId, new FakeAgent(this, cwd, { provider: "fake", modelId: "echo" }));
  }
  agent(primeSessionId: string) {
    const a = this.agents.get(primeSessionId);
    if (!a) throw Error(`No fake session ${primeSessionId}`);
    return a;
  }
  models(): ModelInfo[] {
    return [{ id: "echo", provider: "fake", name: "Echo", tier: "T", icon: "lab.png", contextWindow: 128000, reasoning: false, cost: { input: 0, output: 0 } }];
  }
  defaultModel() {
    return "echo";
  }
  async close() {
    this.closed = true;
  }
}
