// Live view of running codemode scripts for the agent stream. pi-durable 1.3.0 publishes every nested call a tool
// makes (`pi.live.nestedTools`) as tool events of its own, keyed to the parent by `parentToolCallId`, and lists the
// still-open ones in the snapshot; this reduces those into one `script` frame per codemode call. Nothing polls the
// task graph. The codemode result's `details.calls` is the authoritative record once the call settled.
import type { ScriptCall, ScriptView, WireAgentEvent, WireSnapshotEvent } from "../../dpi-sdk/src/api.js";

const ARGS_CHARS = 200;
const ERROR_CHARS = 500;
const SCRIPT_TOOL = "codemode";

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const compactArgs = (args: unknown) => cut(JSON.stringify(args ?? {}) ?? "{}", ARGS_CHARS);

/** How a nested call ended. An abort reads as interrupted, like an aborted generation in the transcript. */
export function endedStatus(summary: { isError: boolean; error?: string }): ScriptCall["status"] {
  if (!summary.isError) return "ok";
  return /interrupted|aborted/i.test(summary.error ?? "") ? "interrupted" : "error";
}

type Clock = () => number;

export class ScriptWatch {
  private scripts = new Map<string, ScriptView>();
  private calls = new Map<string, { script: string; call: ScriptCall }>();
  private dirty = new Set<string>();

  constructor(private now: Clock = Date.now) {}

  /** Scripts already running when a stream opens: a restart or a late viewer. `startedAt` reads the task record. */
  async attach(snapshot: WireSnapshotEvent, startedAt: (taskId: number) => Promise<number | undefined>): Promise<ScriptView[]> {
    const out: ScriptView[] = [];
    for (const slot of snapshot.tools) {
      if (slot.name !== SCRIPT_TOOL || slot.status !== "running" || slot.taskId === undefined) continue;
      const script: ScriptView = { toolCallId: slot.callId, taskId: slot.taskId, calls: [] };
      const at = await startedAt(slot.taskId).catch(() => undefined);
      if (at !== undefined) script.startedAt = at;
      this.scripts.set(slot.callId, script);
      out.push(script);
    }
    for (const slot of snapshot.nestedTools ?? []) {
      const script = this.scripts.get(slot.parentCallId);
      if (!script) continue;
      const call = this.add(script, slot.callId, slot.taskId, slot.name, slot.arguments);
      const at = await startedAt(slot.taskId).catch(() => undefined);
      if (at !== undefined) call.startedAt = at;
      if (slot.status === "done" && slot.summary) this.end(call, slot.summary);
    }
    return out;
  }

  /** Reduce one event batch; returns the scripts it changed, final frames (`endedAt` set) last. */
  apply(events: readonly WireAgentEvent[]): ScriptView[] {
    const ended: ScriptView[] = [];
    for (const event of events) {
      if (event.type === "snapshot") {
        // Overflow: the stream replaced undelivered batches with a snapshot; the caller re-attaches from it.
        this.scripts.clear();
        this.calls.clear();
        this.dirty.clear();
        continue;
      }
      if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") continue;
      if (event.parentToolCallId !== undefined) {
        const script = this.scripts.get(event.parentToolCallId);
        if (!script) continue;
        if (event.type === "tool_execution_start") {
          const call = this.add(script, event.toolCallId, event.taskId, event.toolName, event.args);
          call.startedAt = this.now();
        } else {
          const known = this.calls.get(event.toolCallId);
          if (!known) continue;
          // No result: the task faulted or was orphaned, or the script ended first.
          this.end(known.call, event.result ? { isError: event.result.isError, error: errorText(event.result), durationMs: event.result.durationMs } : undefined);
        }
        this.dirty.add(script.toolCallId);
      } else if (event.toolName === SCRIPT_TOOL) {
        if (event.type === "tool_execution_start") {
          const script: ScriptView = { toolCallId: event.toolCallId, startedAt: this.now(), calls: [] };
          if (event.taskId !== undefined) script.taskId = event.taskId;
          this.scripts.set(event.toolCallId, script);
          this.dirty.add(event.toolCallId);
        } else {
          const script = this.scripts.get(event.toolCallId);
          if (!script) continue;
          script.endedAt = this.now();
          for (const call of script.calls) if (call.status === "running") this.end(call, undefined);
          this.scripts.delete(event.toolCallId);
          for (const [id, known] of this.calls) if (known.script === event.toolCallId) this.calls.delete(id);
          this.dirty.delete(event.toolCallId);
          ended.push(script);
        }
      }
    }
    const changed = [...this.dirty].map((id) => this.scripts.get(id)!).filter(Boolean);
    this.dirty.clear();
    return [...changed, ...ended];
  }

  get size() {
    return this.scripts.size;
  }

  private add(script: ScriptView, callId: string, taskId: number | undefined, name: string, args: unknown) {
    const call: ScriptCall = { id: script.calls.length + 1, name, args: compactArgs(args), status: "running" };
    if (taskId !== undefined) call.taskId = taskId;
    script.calls.push(call);
    this.calls.set(callId, { script: script.toolCallId, call });
    return call;
  }

  private end(call: ScriptCall, summary: { isError: boolean; error?: string; durationMs?: number } | undefined) {
    call.endedAt = this.now();
    if (!summary) {
      call.status = "cancelled";
      return;
    }
    call.status = endedStatus(summary);
    if (summary.durationMs !== undefined) call.durationMs = summary.durationMs;
    if (summary.isError && summary.error) call.error = cut(summary.error, ERROR_CHARS);
  }
}

function errorText(result: { diagnostics?: readonly { severity: string; message: string }[] }) {
  const text = (result.diagnostics ?? [])
    .filter((d) => d.severity === "error")
    .map((d) => d.message)
    .join("\n");
  return text || undefined;
}
