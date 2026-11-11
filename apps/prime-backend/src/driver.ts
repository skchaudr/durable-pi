// The seam between the dpi-facing server and Prime. Everything dpi-shaped lives outside this file.
import type {
  AgentConfig,
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
