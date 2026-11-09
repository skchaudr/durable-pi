import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Response } from "express";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { AgentModel, SessionModel } from "../../dpi-sdk/src/models.js";
import type { Frame } from "../../dpi-sdk/src/api.js";
import { openSse } from "../src/streams.js";
import { bootServer, delay, faux, newToken, tempStore, until } from "./helpers.js";

function collect(stream: AsyncGenerator<Frame>, sink: Frame[], onFrame?: (f: Frame) => void) {
  return (async () => {
    for await (const frame of stream) {
      sink.push(frame);
      onFrame?.(frame);
    }
  })().catch(() => {});
}

test("agent, session and device streams carry snapshots and deltas that reduce to the transcript", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const stop = new AbortController();
  try {
    const client = new DpiClient(server.base, token);
    const session = await client.createSession({ name: "Streams", cwd: t.work, model: faux });
    const main = client.agent(session.id, "main");

    // Device stream: hello, tree, then activity when the agent works.
    const deviceFrames: Frame[] = [];
    void collect(client.deviceEvents(stop.signal, ["app.shared-state"]), deviceFrames);
    // Session stream: one session snapshot, then tasks/agents updates.
    const sessionFrames: Frame[] = [];
    const sessionModel = new SessionModel();
    void collect(client.session(session.id).events(stop.signal), sessionFrames, (f) => sessionModel.apply(f));
    // Agent stream with documents.
    const agentFrames: Frame[] = [];
    const model = new AgentModel();
    void collect(main.events(stop.signal, ["demo.job-runs"]), agentFrames, (f) => model.apply(f));
    await until(async () => model.state.ready, 5000, "agent snapshot");
    assert.equal(agentFrames[0].type, "hello");
    assert.equal(agentFrames[1].type, "snapshot");
    assert.ok(agentFrames.some((f) => f.type === "doc" && f.kind === "demo.job-runs"));

    // A tool turn streams output and ends in the same items the server normalizes.
    await main.send("!for i in 1 2 3; do echo line$i; sleep 0.4; done", "followUp", "s-1");
    await until(
      async () =>
        model.state.items.some(
          (i) => i.kind === "assistant" && i.blocks.some((b) => b.type === "tool" && b.call.status === "running" && (b.call.output ?? "").includes("line1")),
        ),
      8000,
      "live tool output",
    );
    await until(async () => !model.state.running && model.state.items.filter((i) => i.kind === "assistant").length >= 2, 15000, "run end");
    const server_items = (await main.transcript("json")).items;
    assert.deepEqual(JSON.parse(JSON.stringify(model.state.items)), server_items);
    const types = new Set(agentFrames.flatMap((f) => (f.type === "batch" ? f.events.map((e) => e.type) : [])));
    for (const expected of ["run_start", "message_start", "message_end", "tool_execution_start", "tool_execution_update", "tool_execution_end", "run_end"])
      assert.ok(types.has(expected as never), `missing ${expected}`);
    // A long reply streams partial text through message_update deltas.
    let sawPartial = false;
    const unsub = model.subscribe(() => {
      const live = model.state.items.find((i) => i.kind === "assistant" && i.streaming);
      if (live && live.kind === "assistant" && live.blocks.some((b) => b.type === "text" && b.text.length > 10)) sawPartial = true;
    });
    await main.send("slow: " + "durable streaming words ".repeat(40), "followUp", "s-slow");
    await until(async () => !model.state.running && model.state.items.filter((i) => i.kind === "assistant").length >= 3, 20000, "slow reply");
    unsub();
    assert.ok(sawPartial, "saw streamed partial text");
    assert.ok(agentFrames.some((f) => f.type === "batch" && f.events.some((e) => e.type === "message_update")), "message_update frames");
    // RECORD_FIXTURES=1 saves the real frame log as the SDK fixture.
    if (process.env.RECORD_FIXTURES) {
      const fixtures = join(import.meta.dirname, "../../dpi-sdk/tests/fixtures");
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, "agent-tool-turn.json"), JSON.stringify({ frames: agentFrames, transcript: (await main.transcript("json")).items }, null, 1));
    }

    // A late joiner mid-run sees the running state in its snapshot; a steer shows in the inbox with content.
    await main.send("!sleep 1.5; echo late", "followUp", "s-2");
    await delay(500);
    const late = new AgentModel();
    const lateFrames: Frame[] = [];
    const lateStop = new AbortController();
    void collect(main.events(lateStop.signal), lateFrames, (f) => late.apply(f));
    await until(async () => late.state.ready, 5000, "late snapshot");
    assert.equal(late.state.running, true);
    await main.send("then say bye", "steer", "s-3");
    await until(async () => late.state.inbox.some((i) => i.content === "then say bye" && i.mode === "steer"), 5000, "inbox content");
    // Closing a viewer mid-run never stops the run.
    lateStop.abort();
    await until(async () => !model.state.running && model.state.items.some((i) => i.kind === "assistant" && i.blocks.some((b) => b.type === "text" && b.text === "Echo: then say bye")), 15000, "run continues after viewer closes");

    // Session stream saw generation tasks come and go; device stream saw activity.
    assert.equal(sessionFrames[1].type, "session");
    assert.ok(sessionFrames.some((f) => f.type === "tasks" && f.tasks.some((task) => task.kind === "pi.generation")));
    await until(async () => sessionModel.state.tasks.length === 0, 5000, "tasks drained");
    // A rename touches only the catalog; the open session stream still carries the new name.
    await main.rename("Renamed live");
    await until(async () => sessionModel.agent(1)?.name === "Renamed live", 5000, "renamed agent on the session stream");
    assert.ok(deviceFrames.some((f) => f.type === "tree"));
    assert.ok(deviceFrames.some((f) => f.type === "doc" && f.kind === "app.shared-state"));
    const activity = () => deviceFrames.flatMap((f) => (f.type === "activity" ? f.items : []));
    await until(async () => activity().some((a) => a.type === "agent.finished" && (a.preview ?? "").length > 0), 5000, "finished activity with preview");
    assert.ok(activity().some((a) => a.type === "agent.started"));

    // Bad stream requests answer JSON errors before any stream starts.
    const bad = await fetch(`${server.base}/v1/sessions/${session.id}/agents/main/events?docs=nope`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${server.base}/v1/sessions/${session.id}/agents/99/events`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 404);
  } finally {
    stop.abort();
    await server.stop();
    await t.cleanup();
  }
});

test("codemode: the agent stream shows a script's nested calls live, running to ok, and a final frame with every call", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const stop = new AbortController();
  try {
    const client = new DpiClient(server.base, token);
    const session = await client.createSession({ name: "Script", cwd: t.work, model: faux });
    const main = client.agent(session.id, "main");
    await main.setExtension({ name: "codemode", enabled: true });
    const frames: Frame[] = [];
    const model = new AgentModel();
    void collect(main.events(stop.signal), frames, (f) => model.apply(f));
    await until(async () => model.state.ready, 5000, "agent snapshot");
    const scripts = () => frames.filter((f): f is Extract<Frame, { type: "script" }> => f.type === "script");
    const codemodeView = () => {
      for (const item of model.state.items)
        if (item.kind === "assistant") for (const b of item.blocks) if (b.type === "tool" && b.call.name === "codemode") return b.call;
      return undefined;
    };

    const code = `const out = []; for (let i = 1; i <= 3; i++) out.push((await tools.bash({ command: "sleep 0.6; echo ok" + i })).output.trim()); return out.join(",")`;
    await main.send(`code:${code}`, "followUp", "sc-1");
    // Progress: a frame with c1 running, then one with c1 ok and c2 running, then the final one.
    await until(async () => scripts().some((f) => f.calls[0]?.status === "running"), 10000, "first call running");
    await until(async () => scripts().some((f) => f.calls[0]?.status === "ok" && f.calls[1]?.status === "running"), 10000, "second call running");
    const live = codemodeView();
    assert.equal(live?.status, "running");
    assert.ok((live?.calls?.length ?? 0) >= 1, "the running codemode view carries its calls");
    assert.ok(live?.startedAt, "startedAt on the running view");
    await until(async () => scripts().some((f) => f.endedAt !== undefined), 15000, "final script frame");
    const final = scripts().at(-1)!;
    assert.equal(final.endedAt !== undefined, true);
    assert.deepEqual(final.calls.map((c) => [c.id, c.name, c.status]), [[1, "bash", "ok"], [2, "bash", "ok"], [3, "bash", "ok"]]);
    assert.ok(final.calls.every((c) => c.taskId && c.startedAt && c.endedAt && (c.durationMs ?? 0) >= 500), JSON.stringify(final.calls));
    assert.equal(final.calls[0].args, '{"command":"sleep 0.6; echo ok1"}');
    assert.ok(final.taskId, "the codemode task id");
    for (const f of scripts()) assert.equal(f.toolCallId, final.toolCallId);
    // Nested calls never appear as transcript tools of their own; the settled view lists them from the result.
    await until(async () => !model.state.running, 15000, "run end");
    assert.ok(!model.state.items.some((i) => i.kind === "tool"), "no stray live tool items");
    const done = codemodeView();
    assert.equal(done?.status, "done");
    assert.deepEqual(done?.calls?.map((c) => [c.id, c.status, c.durationMs !== undefined]), [[1, "ok", true], [2, "ok", true], [3, "ok", true]]);
    type Item = { kind: string; blocks?: { type: string; call?: { calls?: unknown } }[] };
    const items = ((await main.transcript("json")).items ?? []) as Item[];
    const toolBlock = items.flatMap((i) => (i.kind === "assistant" ? (i.blocks ?? []) : [])).find((b) => b.type === "tool");
    assert.deepEqual(JSON.parse(JSON.stringify(done?.calls)), JSON.parse(JSON.stringify(toolBlock!.call!.calls)));

    // A viewer that attaches mid-script gets the running state from the snapshot: finished calls and the one in flight.
    await main.send(`code:${code}`, "followUp", "sc-2");
    await delay(1000);
    const lateStop = new AbortController();
    const lateFrames: Frame[] = [];
    const late = new AgentModel();
    void collect(main.events(lateStop.signal), lateFrames, (f) => late.apply(f));
    await until(async () => lateFrames.some((f) => f.type === "script"), 5000, "late script frame");
    const first = lateFrames.find((f): f is Extract<Frame, { type: "script" }> => f.type === "script")!;
    assert.ok(first.calls.length >= 1 && first.calls.every((c) => c.status === "ok" || c.status === "running"), JSON.stringify(first));
    assert.ok(first.startedAt && first.calls.every((c) => c.startedAt), "timing recovered from task records");
    await until(async () => lateFrames.some((f) => f.type === "script" && f.endedAt !== undefined && f.calls.length === 3 && f.calls.every((c) => c.status === "ok")), 15000, "late final frame");
    lateStop.abort();
  } finally {
    stop.abort();
    await server.stop();
    await t.cleanup();
  }
});

test("codemode: aborting the agent stops the script; the in-flight nested call reads interrupted and no nested task remains", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  const stop = new AbortController();
  try {
    const client = new DpiClient(server.base, token);
    const session = await client.createSession({ name: "Abort", cwd: t.work, model: faux });
    const main = client.agent(session.id, "main");
    await main.setExtension({ name: "codemode", enabled: true });
    const frames: Frame[] = [];
    const model = new AgentModel();
    void collect(main.events(stop.signal), frames, (f) => model.apply(f));
    const sessionModel = new SessionModel();
    void collect(client.session(session.id).events(stop.signal), [], (f) => sessionModel.apply(f));
    await until(async () => model.state.ready && sessionModel.state.ready, 5000, "snapshots");
    const scripts = () => frames.filter((f): f is Extract<Frame, { type: "script" }> => f.type === "script");

    const code = `const out = []; for (let i = 1; i <= 10; i++) { try { out.push((await tools.bash({ command: "sleep 2; echo ok" + i })).output.trim()) } catch (e) { out.push("E" + i) } } return out.join(",")`;
    const sent = await main.send(`code:${code}`, "followUp", "ab-1");
    await until(async () => scripts().some((f) => f.calls[0]?.status === "running"), 10000, "first call running");
    await until(async () => sessionModel.state.tasks.some((task) => task.kind === "pi.tool" && task.owner !== undefined), 5000, "nested task in the graph");
    await main.abort();
    const settled = await client.session(session.id).submission(sent.submissionId, 15000);
    assert.equal(settled.status, "unanswered");
    await until(async () => scripts().some((f) => f.endedAt !== undefined), 10000, "final script frame");
    const final = scripts().at(-1)!;
    assert.equal(final.calls.length, 1, "the abort stopped the loop: no further calls");
    assert.equal(final.calls[0].status, "interrupted");
    assert.match(final.calls[0].error ?? "", /aborted/);
    await until(async () => !model.state.running, 10000, "run end");
    const view = model.state.items.flatMap((i) => (i.kind === "assistant" ? i.blocks : [])).find((b) => b.type === "tool" && b.call.name === "codemode");
    assert.equal(view?.type === "tool" && view.call.status, "error");
    assert.match((view?.type === "tool" && view.call.result) || "", /aborted/);
    assert.deepEqual(view?.type === "tool" ? view.call.calls?.map((c) => c.status) : [], ["interrupted"]);
    await until(async () => sessionModel.state.tasks.length === 0, 10000, "task graph drained");
    assert.equal((await client.session(session.id).tasks("live")).length, 0);
  } finally {
    stop.abort();
    await server.stop();
    await t.cleanup();
  }
});

test("openSse ends a slow viewer instead of buffering without bound", () => {
  const writes: string[] = [];
  let ended = false;
  const handlers: Record<string, () => void> = {};
  const res = {
    writableLength: 0,
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
    socket: undefined,
    on(event: string, fn: () => void) {
      handlers[event] = fn;
    },
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    end() {
      ended = true;
    },
  };
  const sse = openSse(res as unknown as Response, { kind: "device" });
  assert.match(writes[0], /event: hello/);
  res.writableLength = 3_000_000;
  sse.send({ type: "activity", items: [] });
  assert.equal(ended, true);
  assert.equal(sse.closed, true);
  sse.send({ type: "activity", items: [] });
  assert.equal(writes.length, 1);
});
