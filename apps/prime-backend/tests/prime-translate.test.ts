import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WireAgentEvent } from "../../dpi-sdk/src/api.js";
import { AgentModel } from "../../dpi-sdk/src/models.js";
import { Translator, messagesToEntries, parsePythonState } from "../src/prime/translate.js";

const fixture = JSON.parse(readFileSync(new URL("../../dpi-sdk/tests/fixtures/agent-tool-turn.json", import.meta.url), "utf8"));
const fixtureEvents: WireAgentEvent[] = fixture.frames.flatMap((f: { type: string; events?: WireAgentEvent[] }) => (f.type === "batch" ? f.events! : []));

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
});
const asst = (content: unknown[], stopReason: string, u = usage(10, 5)) => ({
  role: "assistant",
  content,
  api: "t",
  provider: "prime",
  model: "m1",
  usage: u,
  stopReason,
  timestamp: 1,
});
const userMsg = { role: "user", content: "list the files", timestamp: 1 };
const call = { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } };
const toolResult = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "bash",
  content: [{ type: "text", text: "a.txt\nb.txt\n" }],
  isError: false,
  timestamp: 2,
};
const partialText = (t: string) => asst([{ type: "text", text: t }], "stop");
const partialCall = asst([{ type: "text", text: "Looking." }, call], "toolUse");

/** What the daemon sends for: prompt -> text + toolCall -> bash start/update/end -> result -> final text. */
const script: unknown[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: userMsg },
  { type: "message_end", message: userMsg },
  { type: "message_start", message: asst([], "stop") },
  { type: "message_update", message: partialText("Look"), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Look" } },
  { type: "message_update", message: partialCall, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"ls"}' } },
  { type: "message_end", message: partialCall },
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
  { type: "tool_execution_progress", toolCallId: "c1", toolName: "bash", elapsedMs: 5 },
  { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "a.txt\n" }], details: null } },
  { type: "tool_execution_update", toolCallId: "c1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "a.txt\nb.txt\n" }], details: null } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "a.txt\nb.txt\n" }] }, isError: false },
  { type: "message_start", message: toolResult },
  { type: "message_end", message: toolResult },
  { type: "turn_end", message: partialCall, toolResults: [toolResult] },
  { type: "turn_start" },
  { type: "message_start", message: asst([], "stop") },
  { type: "message_update", message: partialText("Two files."), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Two files." } },
  { type: "message_end", message: partialText("Two files.") },
  { type: "turn_end", message: partialText("Two files."), toolResults: [] },
  { type: "agent_end", messages: [] },
];

const fresh = () => new Translator({ entries: [], agent: { cwd: "/w" } });
const types = (events: WireAgentEvent[]) => events.map((e) => e.type);

describe("Translator", () => {
  it("emits dpi events in the fixture's order and shapes", () => {
    const t = fresh();
    const events = script.flatMap((e) => t.apply(e));
    assert.deepEqual(types(events), [
      "message_start", "message_end", "run_start", "turn_start", // the prompt lands before run_start, as in the fixture
      "message_start", "message_update", "message_update", "message_end", "usage_changed",
      "tool_execution_start", "tool_execution_update", "tool_execution_update", "tool_execution_end",
      "message_start", "message_end", "turn_end",
      "turn_start", "message_start", "message_update", "message_end", "usage_changed", "turn_end",
      "run_end",
    ]);
    // every key we emit exists on the fixture's event of the same type
    for (const ev of events) {
      const ref = fixtureEvents.find((f) => f.type === ev.type);
      assert.ok(ref, `fixture has ${ev.type}`);
      for (const key of Object.keys(ev)) assert.ok(key in ref, `${ev.type}.${key} is in the fixture`);
    }
    assert.equal((events[1] as any).entry.id, 1);
    assert.deepEqual(events[2], { type: "run_start", inputs: [1] });
    assert.deepEqual(events.at(-1), { type: "run_end", inputs: [1] });
    const updates = events.filter((e) => e.type === "tool_execution_update") as any[];
    assert.deepEqual(updates.map((u) => u.output), [{ set: "a.txt\n" }, { set: "a.txt\nb.txt\n" }]);
    const ids = events.filter((e) => e.type === "message_end").map((e: any) => e.entry.id);
    assert.deepEqual(ids, [1, 2, 3, 4]);
    assert.deepEqual(
      events.filter((e) => e.type === "message_end").map((e: any) => e.entry.kind),
      ["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant"],
    );
    const lastUsage = events.filter((e) => e.type === "usage_changed").at(-1) as any;
    assert.equal(lastUsage.usage.models["prime/m1"].input, 20);
    assert.equal(t.busy(), false);
  });

  it("renders through AgentModel and toTranscript", () => {
    const t = fresh();
    const model = new AgentModel();
    model.apply({ type: "snapshot", snapshot: t.snapshot(), inbox: [] });
    const feed = (e: unknown) => model.apply({ type: "batch", events: t.apply(e) });
    const upTo = script.findIndex((e: any) => e.type === "tool_execution_update");
    script.slice(0, upTo + 1).forEach(feed);
    assert.equal(model.state.running, true);
    assert.equal(t.busy(), true);
    const mid = model.state.items.at(-1) as any;
    assert.equal(mid.kind, "assistant");
    assert.equal(mid.blocks[1].call.status, "running");
    assert.equal(mid.blocks[1].call.output, "a.txt\n");
    script.slice(upTo + 1).forEach(feed);

    const items = model.state.items as any[];
    assert.equal(items[0].text, "list the files");
    const withTool = items[1];
    assert.equal(withTool.blocks[0].text, "Looking.");
    assert.equal(withTool.blocks[1].call.name, "bash");
    assert.equal(withTool.blocks[1].call.status, "done");
    assert.equal(withTool.blocks[1].call.result, "a.txt\nb.txt\n");
    assert.equal(items.at(-1).blocks[0].text, "Two files.");
    assert.equal(items.length, 3); // the tool result folds into its call
    assert.equal(model.state.running, false);
    assert.equal(model.state.usage.models["prime/m1"].output, 10);
  });

  it("snapshot mid-run carries run, live message and running tool", () => {
    const t = fresh();
    const upTo = script.findIndex((e: any) => e.type === "tool_execution_update");
    script.slice(0, upTo + 1).forEach((e) => t.apply(e));
    const s = t.snapshot();
    assert.deepEqual(s.run, { inputs: [1] });
    assert.deepEqual(s.tools.map((x) => [x.callId, x.status, x.output]), [["c1", "running", "a.txt\n"]]);
    assert.equal(s.entries.length, 2);
    const t2 = fresh();
    script.slice(0, 6).forEach((e) => t2.apply(e)); // mid-stream
    assert.equal((t2.snapshot().generation!.message!.content[0] as any).text, "Look");
  });

  it("falls back to a whole-message change for an unknown delta kind", () => {
    const t = fresh();
    const [ev] = t.apply({ type: "message_update", message: partialText("x"), assistantMessageEvent: { type: "mystery" } });
    assert.equal((ev as any).changes[0].type, "message");
  });

  it("a run without a prompt starts at the first other event; unmapped events produce nothing", () => {
    const t = fresh();
    assert.deepEqual(t.apply({ type: "agent_start" }), []);
    assert.deepEqual(t.apply({ type: "turn_start" }), []);
    assert.deepEqual(types(t.apply({ type: "message_start", message: asst([], "stop") })), ["run_start", "turn_start", "message_start"]);
    for (const type of ["goal_update", "rlm_child_update", "tool_execution_progress", "nope"]) assert.deepEqual(t.apply({ type }), []);
  });

  it("maps compaction start/end", () => {
    const t = fresh();
    assert.deepEqual(t.apply({ type: "compaction_start", reason: "threshold" }), [{ type: "compaction_start", taskId: 1, reason: "threshold", blocking: false }]);
    assert.equal(t.snapshot().compactions.length, 1);
    assert.deepEqual(t.apply({ type: "compaction_end", reason: "threshold" }), [{ type: "compaction_end", taskId: 1, reason: "threshold" }]);
    assert.equal(t.snapshot().compactions.length, 0);
  });

  it("the compaction summary is a pi.compaction entry with the summary as its note, live and from history, and hides nothing", () => {
    const t = new Translator({ entries: messagesToEntries([userMsg]), agent: {} });
    t.apply({ type: "compaction_start", reason: "manual" });
    const out = t.apply({ type: "compaction_end", reason: "manual", result: { summary: "the story so far", tokensBefore: 9 }, aborted: false });
    assert.deepEqual(out.map((x) => x.type), ["compaction_end", "entry_appended"]);
    const live = (out[1] as Extract<WireAgentEvent, { type: "entry_appended" }>).entry;
    assert.deepEqual([live.id, live.kind, live.head], [2, "pi.compaction", 1]);
    const [row] = messagesToEntries([{ role: "compactionSummary", summary: "the story so far", tokensBefore: 9, timestamp: 5 }], 7);
    assert.deepEqual([row.id, row.kind, row.head], [7, "pi.compaction", 7]);
    // skipped or aborted compactions carry no summary
    t.apply({ type: "compaction_start", reason: "manual" });
    assert.deepEqual(t.apply({ type: "compaction_end", reason: "manual", errorMessage: "Session is too short to compact" }).map((x) => x.type), ["compaction_end"]);
    // the page's model renders it under "Context note" next to the earlier messages
    const m = new AgentModel();
    m.apply({ type: "snapshot", snapshot: t.snapshot(), inbox: [] });
    m.apply({ type: "batch", events: [{ type: "entry_appended", entry: live }] });
    const items = m.state.items;
    assert.deepEqual(items.map((i) => i.kind), ["user", "event"]);
    assert.equal((items[1] as { note?: string }).note, "the story so far");
  });
});

describe("messagesToEntries", () => {
  it("round-trips get_messages output into a transcript and continues ids", () => {
    const entries = messagesToEntries([userMsg, partialCall, toolResult, partialText("Two files.")], 5);
    assert.deepEqual(entries.map((e) => [e.id, e.kind, e.conversationId]), [
      [5, "pi.user", 1], [6, "pi.assistant", 1], [7, "pi.tool-result", 1], [8, "pi.assistant", 1],
    ]);
    const t = new Translator({ entries, agent: {} });
    const model = new AgentModel();
    model.apply({ type: "snapshot", snapshot: t.snapshot(), inbox: [] });
    const items = model.state.items as any[];
    assert.equal(items[0].text, "list the files");
    assert.equal(items[1].blocks[1].call.result, "a.txt\nb.txt\n");
    assert.equal(items[2].blocks[0].text, "Two files.");
    assert.equal(t.snapshot().usage.models["prime/m1"].input, 20);
    const [end] = t.apply({ type: "message_end", message: userMsg });
    assert.equal((end as any).entry.id, 9);
    assert.deepEqual(messagesToEntries([userMsg]).map((e) => e.id), [1]);
  });
});

describe("revival events", () => {
  it("live events and history rows become one chat line each", () => {
    const t = new Translator({ entries: [], agent: {} });
    const live = t.apply({
      type: "revival_continued",
      interruptedToolCalls: [{ toolCallId: "c1", toolName: "python_repl", started: true }],
      at: "2026-11-11T15:17:14.063Z",
    });
    // the interrupted call is closed (Prime writes its result to the file only), then the chat line
    assert.deepEqual(live.map((x) => x.type), ["tool_execution_end", "message_end", "entry_appended"]);
    const closed = (live[1] as Extract<WireAgentEvent, { type: "message_end" }>).entry;
    assert.equal(closed.kind, "pi.tool-result");
    assert.equal((closed.model![0] as { toolCallId: string }).toolCallId, "c1");
    const ev = live[2] as Extract<WireAgentEvent, { type: "entry_appended" }>;
    assert.equal(ev.type, "entry_appended");
    assert.equal(ev.entry.kind, "prime.revival");
    assert.equal((ev.entry.data as { text: string }).text, "Turn continued after a restart. Interrupted: python_repl (may have partly run).");
    assert.equal(t.snapshot().entries.length, 2);

    const rows = messagesToEntries([
      { role: "custom", customType: "revival_event", display: true, details: { type: "revival", outcome: "skipped", reason: "its busy evidence is stale", restarts: 0 } },
      { role: "custom", customType: "revival_event", details: { type: "worker_restarted", failure: 2, maxFailures: 5 } },
    ]);
    assert.deepEqual(rows.map((r) => [r.kind, (r.data as { text: string }).text]), [
      ["prime.revival", "Prime did not revive this session: its busy evidence is stale"],
      ["prime.revival", "Session worker crashed and was restarted (2/5)."],
    ]);
  });
});

describe("python kernel notice", () => {
  // Sentences from pa-core ipython_state.rs notice_content: header, persistence, then the pruned sentence, then the names sentence.
  const head = "[python-state]\n\nYour Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.";
  const pruned = " Variables above the per-variable snapshot limit were removed: big, df2.";

  it("parses defined and pruned names", () => {
    assert.deepEqual(parsePythonState(`${head}${pruned} These names are still defined: a, b, np.`), { defined: ["a", "b", "np"], pruned: ["big", "df2"] });
    assert.deepEqual(parsePythonState(`${head} These names are still defined: a.`), { defined: ["a"], pruned: [] });
    assert.deepEqual(parsePythonState(`${head}${pruned} You have not defined any names yet.`), { defined: [], pruned: ["big", "df2"] });
    assert.deepEqual(parsePythonState(`${head} You have not defined any names yet.`), { defined: [], pruned: [] });
    assert.deepEqual(parsePythonState(head), { pruned: [] }); // listing failed: no names sentence
    assert.deepEqual(parsePythonState(`${head}${pruned}`), { pruned: ["big", "df2"] });
  });

  it("history and live rows become prime.python_state with no raw message", () => {
    const row = { role: "custom", customType: "ipython_state", content: `${head}${pruned} These names are still defined: a, b.`, display: false, timestamp: 1 };
    const [e] = messagesToEntries([row]);
    assert.equal(e.kind, "prime.python_state");
    assert.equal(e.model, undefined);
    assert.deepEqual(e.data, { text: "Python kernel survived compaction (2 names defined).", defined: ["a", "b"], pruned: ["big", "df2"] });
    const t = new Translator({ entries: [], agent: {} });
    const [end] = t.apply({ type: "message_end", message: { ...row, content: [{ type: "text", text: `${head} You have not defined any names yet.` }] } });
    assert.equal((end as Extract<WireAgentEvent, { type: "message_end" }>).entry.kind, "prime.python_state");
    assert.deepEqual((t.snapshot().entries[0].data as { defined: string[] }).defined, []);
  });
});

describe("rlm child agents", () => {
  // Child fields: crates/pa-daemon/src/rlm_children.rs:244-263 (ChildRecord::snapshot_value), also the get_rlm_children rows.
  // A later update may carry only id/status/error (crates/pa-daemon/src/acp/wire_events.rs:731-737).
  const started = { type: "rlm_child_update", child: { id: "child-1", activeSessionId: "live-1", sessionName: "worker-a", label: "run the lane task", status: "running", durationMs: 500, sessionDir: "/s/child-1" } };

  it("lists each child once as a subagent from CHILD_AGENT_BASE, merging later updates; no wire event goes out", () => {
    const t = new Translator({ entries: [], agent: {} });
    assert.deepEqual(t.apply(started), []);
    t.apply({ type: "rlm_child_update", child: { id: "child-2", status: "running", label: "second task" } });
    t.apply({ type: "rlm_child_update", child: { id: "child-1", status: "done" } });
    assert.deepEqual(t.children(), [
      { agentId: 1000, id: "child-1", name: "worker-a", status: "done" },
      { agentId: 1001, id: "child-2", name: "second task", status: "running" },
    ]);
    assert.equal(t.childRow("child-1")?.activeSessionId, "live-1"); // kept through the status-only update
  });

  it("carries the child's model, split at the first slash", () => {
    const t = new Translator({ entries: [], agent: {} });
    t.setChild({ id: "a", model: "cliproxy/gpt-6.1-sol" });
    t.setChild({ id: "b", model: "or/meta/llama" });
    t.setChild({ id: "c", model: "bare" });
    assert.deepEqual(t.children().map((c) => c.model), [{ provider: "cliproxy", modelId: "gpt-6.1-sol" }, { provider: "or", modelId: "meta/llama" }, undefined]);
  });

  it("ignores an update with no child id and seeds from a get_rlm_children roster", () => {
    const t = new Translator({ entries: [], agent: {} });
    t.apply({ type: "rlm_child_update" });
    t.apply({ type: "rlm_child_update", child: { status: "running" } });
    assert.deepEqual(t.children(), []);
    t.setChild(started.child);
    assert.deepEqual(t.children().map((c) => [c.agentId, c.status]), [[1000, "running"]]);
  });
});
