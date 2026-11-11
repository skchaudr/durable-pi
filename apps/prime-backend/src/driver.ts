// The seam between the dpi-facing server and Prime. Everything dpi-shaped lives outside this file.
import type {
  AgentConfig,
  AgentDetail,
  AgentExtensions,
  TaskNode,
  TaskOutcome,
  ModelInfo,
  ThinkingLevel,
  WhenBusy,
  WireAgentEvent,
  WireSnapshotEvent,
} from "../../dpi-sdk/src/api.js";

/** One of Prime's child agents (RLM children) of a session. `agentId` is its place in the dpi tree; the main agent is 1. */
export interface PrimeChild {
  agentId: number;
  /** Prime's own child id. */
  id: string;
  name: string;
  /** Prime's run status: running | done | error | cancelled. */
  status: string;
}

export interface PrimeAgentHandle {
  snapshot(): WireSnapshotEvent; // full current state of the agent, dpi wire shape
  subscribe(fn: (events: readonly WireAgentEvent[]) => void): () => void; // batches, already in dpi wire shape
  busy(): boolean;
  send(content: string, whenBusy: WhenBusy): Promise<{ submissionId: number }>;
  abort(): Promise<void>;
  setConfig(patch: Partial<AgentConfig>): Promise<AgentConfig>;
  config(): AgentConfig;
  extensions(): Promise<AgentExtensions>;
  patchExtensions(body: unknown): Promise<AgentExtensions>;
  tools(): Promise<AgentDetail["tools"]>;
  tasks(): TaskSource;
  children(): PrimeChild[];
  onChildren(fn: () => void): () => void; // the roster or a child's status changed
  /** A child's transcript as Prime holds it now (no live feed); throws a 400 when Prime cannot serve it. */
  childSnapshot(id: string): Promise<WireSnapshotEvent>;
}

/** Prime's schedules, heartbeats and goal as dpi tasks (src/prime/tasks.ts). Created in chat; listed and cancelled here. */
export interface TaskSource {
  liveTasks(): Promise<TaskNode[]>;
  terminalTasks(limit?: number): Promise<TaskOutcome[]>;
  abort(taskId: number): Promise<void>;
  onChange(listener: () => void): () => void;
}

export interface PrimeDriver {
  createSession(opts: {
    cwd: string;
    model: { provider: string; modelId: string };
    thinkingLevel?: ThinkingLevel;
  }): Promise<{ primeSessionId: string }>;
  openSession(primeSessionId: string, cwd: string): Promise<void>; // after a backend restart
  agent(primeSessionId: string): PrimeAgentHandle; // main agent only for v1
  models(): ModelInfo[];
  defaultModel(): string;
  close(): Promise<void>;
}
