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
import type { PrimeAgentHandle, PrimeDriver } from "./driver.js";
import { invalid } from "./errors.js";

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
  tasks() {
    return { liveTasks: async () => [], terminalTasks: async () => [], abort: async () => { throw invalid("No task"); }, onChange: () => () => {} };
  }
  async compaction(): Promise<CompactionSettings> {
    return { enabled: this.autoCompaction, reserveTokens: 16384, backgroundTokens: 0, keepRecentTokens: 20000 };
  }
  async setCompaction(patch: Record<string, unknown>) {
    if (patch.reserveTokens !== undefined) throw invalid("No reserveTokens on the fake driver");
    if (typeof patch.enabled === "boolean") this.autoCompaction = patch.enabled;
    return this.compaction();
  }
  async compact(instructions?: string) {
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
