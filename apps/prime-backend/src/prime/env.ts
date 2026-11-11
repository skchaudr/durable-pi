// Config inputs for the Prime driver, read from env (the backend's config.ts is not touched).
import { homedir } from "node:os";
import { join } from "node:path";

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export interface PrimeEnv {
  /** PRIME_DAEMON_SOCKET, default /tmp/prime-durable-<uid>/daemon.sock */
  socketPath: string;
  /** PRIME_AGENT_DIR, default ~/.prime-durable/agent */
  agentDir: string;
}

export function primeEnv(env: NodeJS.ProcessEnv = process.env): PrimeEnv {
  return {
    socketPath: expand(env.PRIME_DAEMON_SOCKET ?? `/tmp/prime-durable-${process.getuid?.() ?? 501}/daemon.sock`),
    agentDir: expand(env.PRIME_AGENT_DIR ?? join(homedir(), ".prime-durable", "agent")),
  };
}

/** The env a session's worker runs in (create's `launchEnv`): ours, minus Prime-internal vars and the backend's own token. */
export function launchEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && !k.startsWith("PRIME_AGENT_INTERNAL_") && k !== "DPI_TOKEN") out[k] = v;
  return out;
}
