// Prime daemon session events -> dpi wire events, plus the agent snapshot kept from them.
// Prime messages are pi-shaped, so they pass through; only ids, entry kinds and event framing are added.
import type {
  WireAgentEvent,
  WireAgentState,
  WireAssistantBlock,
  WireAssistantMessage,
  WireCompaction,
  WireEntry,
  WireMessage,
  WireMessageChange,
  WireSnapshotEvent,
  WireToolSlot,
  WireUsage,
} from "../../../dpi-sdk/src/api.js";

// Prime events are untyped JSON at this boundary.
type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KINDS: Record<string, string> = {
  user: "pi.user",
  assistant: "pi.assistant",
  toolResult: "pi.tool-result",
  system: "pi.system",
};
const kindOf = (role: string) => KINDS[role] ?? `pi.${role}`;

export function messagesToEntries(primeMessages: unknown[], firstId = 1): WireEntry[] {
  return primeMessages.map((m, i) => ({
    id: firstId + i,
    conversationId: 1,
    kind: kindOf((m as J)?.role),
    model: [m as WireMessage],
  }));
}

/** Text of a tool result (`{content:[{type:"text",text}]}`): Prime's partialResult is the whole output so far. */
const resultText = (r: J | null | undefined): string =>
  (Array.isArray(r?.content) ? r.content : []).map((b: J) => (b?.type === "text" ? (b.text ?? "") : "")).join("");

const emptyBlock = (type: string): WireAssistantBlock =>
  type === "toolcall_start"
    ? { type: "toolCall", id: "", name: "", arguments: {} }
    : type === "thinking_start"
      ? { type: "thinking", thinking: "" }
      : { type: "text", text: "" };

/** One streaming delta as dpi message changes; an unknown kind falls back to the whole partial message. */
function changesOf(delta: J, message: J): WireMessageChange[] {
  const i: number = delta.contentIndex;
  const partial = message.content?.[i];
  switch (delta.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
      return [{ type: delta.type, contentIndex: i, block: partial ?? emptyBlock(delta.type) }];
    case "text_delta":
    case "thinking_delta":
      return [{ type: delta.type, contentIndex: i, delta: delta.delta }];
    // Prime's toolcall delta is raw JSON text, not a path into the arguments: ship the partial's parsed block instead.
    case "toolcall_delta":
      return partial ? [{ type: "block", contentIndex: i, block: partial }] : [{ type: "message", message: message as WireAssistantMessage }];
    case "text_end":
      return [{ type: "block", contentIndex: i, block: { type: "text", text: delta.content ?? "" } }];
    case "thinking_end":
      return [{ type: "block", contentIndex: i, block: { type: "thinking", thinking: delta.content ?? "" } }];
    case "toolcall_end":
      return [{ type: "block", contentIndex: i, block: delta.toolCall }];
    default:
      return [{ type: "message", message: message as WireAssistantMessage }];
  }
}

const zeroUsage = (): WireUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function addUsage(total: WireUsage, u: Partial<WireUsage> | undefined): WireUsage {
  const c = u?.cost;
  return {
    input: total.input + (u?.input ?? 0),
    output: total.output + (u?.output ?? 0),
    cacheRead: total.cacheRead + (u?.cacheRead ?? 0),
    cacheWrite: total.cacheWrite + (u?.cacheWrite ?? 0),
    totalTokens: total.totalTokens + (u?.totalTokens ?? 0),
    cost: {
      input: total.cost.input + (c?.input ?? 0),
      output: total.cost.output + (c?.output ?? 0),
      cacheRead: total.cost.cacheRead + (c?.cacheRead ?? 0),
      cacheWrite: total.cost.cacheWrite + (c?.cacheWrite ?? 0),
      total: total.cost.total + (c?.total ?? 0),
    },
  };
}

export class Translator {
  private entries: WireEntry[];
  private nextId: number;
  private agent: WireAgentState;
  private models: Record<string, WireUsage> = {};
  private run?: { inputs: number[] };
  /** agent_start seen, run_start not yet sent: it waits for the prompt's entry id (dpi orders message_end first). */
  private pending = false;
  private heldTurn = false;
  private live?: J;
  private tools = new Map<string, WireToolSlot>();
  private results = new Map<string, WireEntry>();
  private compaction?: WireCompaction;
  private nextTask = 1;

  constructor(init: { entries: WireEntry[]; agent: WireAgentState }) {
    this.entries = [...init.entries];
    this.agent = init.agent;
    this.nextId = this.entries.reduce((max, e) => Math.max(max, e.id), 0) + 1;
    for (const e of this.entries) for (const m of e.model ?? []) if (m.role === "assistant") this.count(m as J);
  }

  private count(m: J) {
    const key = `${m.provider}/${m.model}`;
    this.models[key] = addUsage(this.models[key] ?? zeroUsage(), m.usage);
  }

  busy(): boolean {
    return !!this.run || this.pending;
  }

  snapshot(): WireSnapshotEvent {
    return structuredClone({
      type: "snapshot",
      entries: this.entries,
      ...(this.run ? { run: this.run } : {}),
      ...(this.live ? { generation: { attempt: 1, message: this.live as WireAssistantMessage } } : {}),
      tools: [...this.tools.values()],
      compactions: this.compaction ? [this.compaction] : [],
      inbox: [],
      agent: this.agent,
      usage: { models: this.models, tools: {} },
    });
  }

  private startRun(out: WireAgentEvent[], inputs: number[]) {
    this.pending = false;
    this.run = { inputs };
    out.push({ type: "run_start", inputs });
    if (this.heldTurn) out.push({ type: "turn_start" });
    this.heldTurn = false;
  }

  apply(primeEvent: unknown): WireAgentEvent[] {
    const e = (primeEvent ?? {}) as J;
    const out: WireAgentEvent[] = [];
    const userMsg = e.message?.role === "user";
    // Only the prompt's own user message may precede run_start; anything else means there was no prompt.
    if (this.pending && !(e.type === "turn_start" || (userMsg && (e.type === "message_start" || e.type === "message_end"))))
      this.startRun(out, []);
    switch (e.type) {
      case "agent_start":
        this.pending = true;
        this.heldTurn = false;
        break;
      case "agent_end":
        for (const slot of this.tools.values()) out.push({ type: "tool_execution_end", toolCallId: slot.callId, toolName: slot.name });
        this.tools.clear();
        this.results.clear();
        this.live = undefined;
        out.push({ type: "run_end", inputs: this.run?.inputs ?? [] });
        this.run = undefined;
        break;
      case "turn_start":
        if (this.pending) this.heldTurn = true;
        else out.push({ type: "turn_start" });
        break;
      case "turn_end":
        out.push({ type: "turn_end" });
        break;
      case "message_start":
        if (e.message?.role === "assistant") this.live = e.message;
        out.push({ type: "message_start", message: e.message });
        break;
      case "message_update":
        this.live = e.message;
        out.push({
          type: "message_update",
          usage: e.message?.usage ?? zeroUsage(),
          changes: changesOf(e.assistantMessageEvent ?? {}, e.message ?? {}),
        });
        break;
      case "message_end": {
        const m = e.message as J;
        const entry: WireEntry = { id: this.nextId++, conversationId: 1, kind: kindOf(m.role), model: [m as WireMessage] };
        this.entries.push(entry);
        if (m.role === "toolResult") this.results.set(m.toolCallId, entry);
        out.push({ type: "message_end", entry });
        if (m.role === "assistant") {
          this.live = undefined;
          this.count(m);
          out.push({ type: "usage_changed", usage: structuredClone({ models: this.models, tools: {} }) });
        }
        if (this.pending) this.startRun(out, [entry.id]);
        break;
      }
      case "tool_execution_start":
        this.tools.set(e.toolCallId, { callId: e.toolCallId, name: e.toolName, status: "running", output: "" });
        out.push({ type: "tool_execution_start", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args });
        break;
      case "tool_execution_update": {
        const output = resultText(e.partialResult);
        const slot = this.tools.get(e.toolCallId);
        if (slot) slot.output = output;
        out.push({
          type: "tool_execution_update",
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          output: { set: output },
          ...(e.partialResult?.details != null ? { details: e.partialResult.details } : {}),
        });
        break;
      }
      case "tool_execution_end": {
        this.tools.delete(e.toolCallId);
        const entry = this.results.get(e.toolCallId);
        out.push({ type: "tool_execution_end", toolCallId: e.toolCallId, toolName: e.toolName, ...(entry ? { entry } : {}) });
        break;
      }
      case "compaction_start": {
        const taskId = this.nextTask++;
        this.compaction = { taskId, reason: String(e.reason ?? "manual"), blocking: false, attempt: 1 };
        out.push({ type: "compaction_start", taskId, reason: this.compaction.reason, blocking: false });
        break;
      }
      case "compaction_end":
        if (this.compaction) out.push({ type: "compaction_end", taskId: this.compaction.taskId, reason: this.compaction.reason });
        this.compaction = undefined;
        break;
      // tool_execution_progress (elapsedMs), goal_update, rlm_child_update and anything unknown: no dpi counterpart.
      default:
        break;
    }
    return out;
  }
}
