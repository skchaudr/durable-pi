// Traces for dpi agents, the backend's counterpart of the Pi extensions ~/.pi/agent/extensions/{traces,otlp-observe}.ts,
// which never load here. After each commit it reads the session's new entries and, per agent (conversation):
//
//   grok-traces   `grok-traces hook dpi` per Pi lifecycle event (traces.ts payload), so the index re-reads agent.sqlite
//   Phoenix       one span per tool result and per assistant message, via the same otlp-ship.py subprocess
//
// Both are fire-and-forget detached children: a missing binary or a dead collector costs nothing.
// Reads start at the newest entry when the session opens, so a backend restart does not re-ship history.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = homedir();
const TRACES_BIN = process.env.DPI_GROK_TRACES ?? join(HOME, ".grok", "bin", "grok-traces");
const GRPC = process.env.OBS_OTLP_GRPC ?? "http://100.109.233.105:4317";
const PROJECT = process.env.DPI_OTLP_PROJECT ?? "dpi";
const SHIPPER = process.env.OBS_OTLP_SHIPPER ?? join(HOME, ".local/share/agent-obs/bin/otlp-ship.py");
const PYBIN = process.env.OBS_OTLP_PYTHON ?? join(HOME, "phoenix-lab/.venv/bin/python");
const COALESCE_MS = 300;

interface Message {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}
interface Row {
  id: number;
  conversation_id: number;
  record: string;
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const ns = (ms: number | undefined) => (BigInt(Math.round(ms ?? Date.now())) * 1_000_000n).toString();

function detached(bin: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const child = spawn(bin, args, { stdio: "ignore", detached: true, env });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

/** Watch one opened session. Returns the unsubscribe. */
export function observeSession(
  session: { id: string; dbPath: string; cwd: string },
  subscribeCommits: (fn: () => void) => () => void,
): () => void {
  const traces = existsSync(TRACES_BIN);
  const otlp = existsSync(SHIPPER) && existsSync(PYBIN);
  if (!traces && !otlp) return () => {};

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(session.dbPath, { readOnly: true });
  } catch {
    return () => {};
  }
  const next = db.prepare("SELECT id, conversation_id, record FROM entries WHERE id > ? ORDER BY id");
  let cursor = Number((db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM entries").get() as { m: number }).m);
  // Tool calls seen in an assistant message, until their result arrives: start time and the conversation's trace.
  const calls = new Map<string, { at: number; tool: string }>();
  const started = new Set<number>();

  const agentId = (conv: number) => `${session.id}:${conv}`;
  const traceId = (conv: number) => md5(`${PROJECT}:${agentId(conv)}`);
  const rootSpan = (conv: number) => traceId(conv).slice(0, 16);

  function span(conv: number, s: { id?: string; root?: boolean; kind: string; name: string; start?: number; end?: number; tool?: string; error?: boolean; event: string }) {
    if (!otlp) return;
    detached(
      PYBIN,
      [
        SHIPPER,
        "--service", PROJECT,
        "--trace-id", traceId(conv),
        "--span-id", s.root ? rootSpan(conv) : (s.id ?? randomBytes(8).toString("hex")),
        "--parent-span-id", s.root ? "" : rootSpan(conv),
        "--span-kind", s.kind,
        "--name", s.name,
        "--start-ns", ns(s.start),
        "--end-ns", ns(s.end ?? s.start),
        "--event", s.event,
        "--tool", s.tool ?? "",
        "--session", agentId(conv),
        "--status", s.error ? "ERROR" : "OK",
      ],
      { ...process.env, OBS_OTLP_GRPC: GRPC, OBS_OTLP_PROJECT: PROJECT },
    );
  }

  // Hooks run one at a time: grok-traces orders receipts by arrival, and `live` needs agent_end after the last tool.
  let hooks = Promise.resolve();
  function hook(conv: number, event: string, extra: Record<string, unknown> = {}) {
    if (!traces) return;
    const body = { event, tool: "", cwd: session.cwd, session_id: agentId(conv), session_file: session.dbPath, harness_pid: process.pid, ...extra };
    hooks = hooks.then(
      () =>
        new Promise<void>((done) => {
          try {
            const child = spawn(TRACES_BIN, ["hook", "dpi"], { stdio: ["pipe", "ignore", "ignore"] });
            child.on("error", () => done());
            child.on("close", () => done());
            child.stdin?.on("error", () => {});
            child.stdin?.end(JSON.stringify(body));
          } catch {
            done();
          }
        }),
    );
  }

  function entry(conv: number, kind: string, msg: Message | undefined) {
    if (!started.has(conv)) {
      started.add(conv);
      span(conv, { root: true, kind: "CHAIN", name: "dpi agent", start: msg?.timestamp, event: "session_start" });
    }
    if (!msg) return;
    // grok-traces gets Pi's event names (agent_start, tool_execution_start/end, agent_end), derived from entries.
    if (kind === "pi.user") hook(conv, "agent_start");
    if (kind === "pi.assistant" && msg.role === "assistant") {
      span(conv, { kind: "LLM", name: "dpi turn", start: msg.timestamp, event: "turn_end" });
      let toolCalls = 0;
      for (const block of Array.isArray(msg.content) ? msg.content : [])
        if (block?.type === "toolCall" && typeof block.id === "string") {
          toolCalls++;
          const tool = String(block.name ?? "");
          calls.set(block.id, { at: msg.timestamp ?? Date.now(), tool });
          hook(conv, "tool_execution_start", { tool, tool_use_id: block.id, tool_input: block.arguments ?? {} });
        }
      if (!toolCalls) hook(conv, "agent_end");
    } else if (kind === "pi.tool-result" && msg.role === "toolResult") {
      const call = msg.toolCallId ? calls.get(msg.toolCallId) : undefined;
      if (msg.toolCallId) calls.delete(msg.toolCallId);
      const tool = msg.toolName ?? call?.tool ?? "";
      span(conv, { kind: "TOOL", name: `dpi tool:${tool}`, start: call?.at ?? msg.timestamp, end: msg.timestamp, tool, error: msg.isError, event: "tool_result" });
      hook(conv, "tool_execution_end", { tool, tool_use_id: msg.toolCallId ?? "" });
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function drain() {
    timer = undefined;
    try {
      for (const row of next.all(cursor) as unknown as Row[]) {
        cursor = row.id;
        const record = JSON.parse(row.record) as { kind?: string; model?: Message[] };
        entry(row.conversation_id, String(record.kind ?? ""), record.model?.at(-1));
      }
    } catch {}
  }

  const off = subscribeCommits(() => {
    timer ??= setTimeout(drain, COALESCE_MS);
    timer.unref?.();
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    drain();
    try {
      db.close();
    } catch {}
  };
}
