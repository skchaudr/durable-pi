import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { projectEnvPath } from "../../../shared/paths.ts";

// CLIPROXY_API_KEY (agent), TYPESAFE_API_KEY or OPENROUTER_API_KEY (Jev) and ELEVENLABS_API_KEY live in the project root .env.
if (existsSync(projectEnvPath)) process.loadEnvFile(projectEnvPath);

const args = process.argv.slice(2);
const option = (key: string, fallback: string) => {
  const i = args.indexOf(key);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw Error(`${key} needs a value`);
  return args[i + 1];
};
// Host playback uses afplay, which only macOS has. Elsewhere the voice plays in the browser.
const tts = option("--tts", process.platform === "darwin" ? "host" : "browser");
if (!["host", "browser", "both", "off"].includes(tts)) throw Error("--tts is host, browser, both, or off");

const agentBackend = option("--agent-backend", "inproc");
if (!["inproc", "dpi", "prime"].includes(agentBackend)) throw Error("--agent-backend is inproc, dpi, or prime");
/** The dpi API of a remote agent backend. Its token never leaves this process: read from the backend's own env file. */
const remote = (url: string, envFile: string) => ({
  url,
  token: () => parseEnv(readFileSync(join(homedir(), envFile), "utf8")).DPI_TOKEN ?? "",
});
const remotes = {
  dpi: remote(process.env.DPI_BACKEND_URL ?? "http://127.0.0.1:4780", ".dpi/backend.env"),
  prime: remote(process.env.PRIME_BACKEND_URL ?? "http://127.0.0.1:4782", ".prime-backend/backend.env"),
};

/**
 * Remote agents call the tool API with OPS_TOOL_TOKEN, which the dpi backend's environment and Prime's settings.json
 * hold too. A random token per run would 401 every call, so remote backends refuse to start without one.
 */
export function opsToolToken(env: string | undefined, backend: string) {
  if (env) return env;
  if (backend !== "inproc")
    throw Error(`--agent-backend ${backend} needs OPS_TOOL_TOKEN (project .env): the ${backend} agent's tool calls would get 401 otherwise`);
  console.warn("[config] OPS_TOOL_TOKEN is not set: --agent-backend dpi or prime would get 401 on every tool call (inproc is unaffected)");
  return randomBytes(24).toString("hex");
}

export const config = {
  port: Number(option("--port", "4790")),
  /** Loopback by default: the UI has no login and the incident agent runs bash. Pass --host 0.0.0.0 for a LAN. */
  host: option("--host", "127.0.0.1"),
  dev: args.includes("--dev"),
  /** inproc runs the incident agent in this process; dpi and prime run it on that backend through the dpi API. */
  agentBackend: agentBackend as "inproc" | "dpi" | "prime",
  /** The remote agent backend, when there is one. */
  remote: agentBackend === "inproc" ? undefined : remotes[agentBackend as "dpi" | "prime"],
  opsToolToken: opsToolToken(process.env.OPS_TOOL_TOKEN, agentBackend),
  /** Remote agents only: where the hub shows their sessions. */
  hubUrl: process.env.DPI_HUB_URL ?? "http://127.0.0.1:4781",
  /** A CLIProxyAPI model id from model-catalog.ts. */
  model: option("--model", "claude-sonnet-5-5-high"),
  /** CLIProxyAPI's OpenAI-compatible endpoint, as in the dpi backend's ~/.dpi/models.json. */
  cliproxyUrl: process.env.CLIPROXY_BASE_URL ?? "http://127.0.0.1:8317/v1",
  thinking: option("--thinking", "high") as "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  /** Incident verdicts sharing one fingerprint inside the window that open an incident. */
  incidentThreshold: Number(option("--incident-threshold", "3")),
  /** Suspicious verdicts sharing one fingerprint inside the window that open an incident. */
  suspiciousThreshold: Number(option("--suspicious-threshold", "8")),
  windowMs: Number(option("--window", "120")) * 1000,
  jevConcurrency: Number(option("--jev-concurrency", "6")),
  /** Rows older than this when first seen are marked skipped instead of judged. */
  backlogMs: Number(option("--backlog", "300")) * 1000,
  tts: tts as "host" | "browser" | "both" | "off",
  /** Also speak when an incident opens. Off by default: the demo has one voice line, at ready for review. */
  announceOpen: args.includes("--announce-open"),
  voiceId: process.env.ELEVENLABS_VOICE_ID ?? "56bWURjYFHyYyVf490Dp",
  voiceModel: process.env.ELEVENLABS_MODEL ?? "eleven_v4_turbo",
  openedSpeech:
    process.env.DPI_OPENED_SPEECH ??
    "Engineer, heads up. Jev flagged a production issue in {service}. A durable agent is investigating.",
  readySpeech:
    process.env.DPI_READY_SPEECH ??
    "Engineer, your Durable Agent Red Team found a production issue, and found the fix. It's waiting on your review.",
};
