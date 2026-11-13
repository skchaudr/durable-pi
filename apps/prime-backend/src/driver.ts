// The seam between the dpi-facing server and Prime. Everything dpi-shaped lives outside this file.
import type {
  AgentConfig,
  AgentDetail,
  AgentExtensions,
  CompactionSettings,
  TaskNode,
  TaskOutcome,
  ModelInfo,
  ThinkingLevel,
  WhenBusy,
  WireAgentEvent,
  WireSnapshotEvent,
} from "../../dpi-sdk/src/api.js";
import type { PrimeGoalAction, PrimeGoalResult, PrimeHeartbeatAction, PrimeWork } from "../../dpi-sdk/src/prime.js";

/** Child agents are numbered from here; the catalog hands out the ids below it (2, 3, ...) to created and forked agents. */
export const CHILD_AGENT_BASE = 1000;

/** One of Prime's child agents (RLM children) of a session. `agentId` is its place in the dpi tree; the main agent is 1. */
export interface PrimeChild {
  agentId: number;
  /** Prime's own child id. */
  id: string;
  name: string;
  /** Prime's run status: running | done | error | cancelled. */
  status: string;
  /** Its model, from Prime's "provider/id". */
  model?: { provider: string; modelId: string };
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
  compaction(): Promise<CompactionSettings>;
  compactionNow(): CompactionSettings; // compaction() without asking Prime, for the session summary
  setCompaction(patch: Record<string, unknown>): Promise<CompactionSettings>;
  compact(instructions?: string): Promise<{ taskId: number }>; // answers once the summary has started
  reset(): Promise<{ primeSessionId: string }>; // Prime's new_session: a fresh session file, which the catalog must follow
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
  // The Prime work panel: goal, heartbeat and schedules, set and managed from the page.
  work(): Promise<PrimeWork>; // reads Prime, then answers
  workNow(): PrimeWork; // as of the last read, for the session stream
  /** Creates a schedule (`prime.schedule`), the heartbeat (`prime.heartbeat`, replacing it) or a goal (`prime.goal`, queued while busy). */
  runJob(job: string, input?: Record<string, unknown>): Promise<{ taskId: number; jobId?: string; queued?: boolean }>;
  goalCommand(action: PrimeGoalAction): Promise<PrimeGoalResult>;
  heartbeatAction(jobId: string, action: PrimeHeartbeatAction): Promise<void>;
  cancelSchedule(jobId: string): Promise<void>;
  /** Cancel plus add: Prime has no edit, so the schedule's id changes. */
  editSchedule(jobId: string, input: Record<string, unknown>): Promise<{ jobId: string; replaced: string }>;
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
