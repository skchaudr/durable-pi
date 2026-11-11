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
  /** Forks the session after dpi entry `entryId` into a session of its own; the source keeps its history and worker. */
  forkSession(primeSessionId: string, entryId: number): Promise<{ primeSessionId: string }>;
  openSession(primeSessionId: string, cwd: string): Promise<void>; // after a backend restart
  agent(primeSessionId: string): PrimeAgentHandle; // main agent only for v1
  models(): ModelInfo[];
  defaultModel(): string;
  close(): Promise<void>;
}
