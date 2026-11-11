import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, newSession, until, type Booted } from "./helpers.js";
import { AgentModel } from "../../dpi-sdk/src/models.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import type { Frame, WireAgentEvent } from "../../dpi-sdk/src/api.js";

const DOCS = "docs=demo.job-runs,demo.workspace";
const batchTypes = (frames: Frame[]) => frames.flatMap((f) => (f.type === "batch" ? f.events.map((e: WireAgentEvent) => e.type) : []));
const msgs = (s: { id: string }) => `/v1/sessions/${s.id}/agents/main/messages`;
const busyOf = async (b: Booted, id: string) => (await b.call("GET", `/v1/sessions/${id}`)).body.agents[0].busy as boolean;

async function withBoot(fn: (b: Booted) => Promise<void>) {
  const b = await boot();
  try {
    await fn(b);
  } finally {
    await b.stop();
    await b.cleanup();
  }
}

test("device stream: hello, tree on session change, doc frame, activity on busy flips", () =>
  withBoot(async (b) => {
    b.driver.stepMs = 150; // the run must outlast the stream's 250 ms coalescing, as dpi-backend's does
    const t = b.tail("/v1/events?docs=app.shared-state");
    await t.waitFor((f) => f.type === "hello");
    assert.deepEqual(t.frames[0], { type: "hello", apiVersion: 1, serverTime: (t.frames[0] as { serverTime: number }).serverTime, scope: { kind: "device" } });
    const first = await t.waitFor((f) => f.type === "tree");
    assert.deepEqual((first as { tree: { sessions: unknown[] } }).tree.sessions, []);
    assert.equal((first as { tree: { at: number } }).tree.at, 0);
    assert.deepEqual(await t.waitFor((f) => f.type === "doc"), { type: "doc", kind: "app.shared-state", value: {}, revision: 0 });

    const s = await newSession(b);
    const withSession = await t.waitFor((f) => f.type === "tree" && f.tree.sessions.length === 1, "tree with the new session");
    assert.equal((withSession as { tree: { sessions: { id: string }[] } }).tree.sessions[0].id, s.id);

    await b.call("POST", msgs(s), { content: "hello", requestId: "a1" });
    await t.waitFor((f) => f.type === "activity" && f.items[0].type === "agent.started", "agent.started");
    const done = await t.waitFor((f) => f.type === "activity" && f.items[0].type === "agent.finished", "agent.finished");
    const item = (done as { items: { sessionId: string; agentId: number; preview?: string }[] }).items[0];
    assert.equal(item.sessionId, s.id);
    assert.equal(item.agentId, 1);
    assert.equal(item.preview, "Echo: hello");

    // an unknown doc kind is a plain 400 before the stream opens
    await assert.rejects(
      async () => {
        for await (const _ of b.client.stream("/v1/events?docs=nope", new AbortController().signal));
      },
      (e: unknown) => e instanceof DpiError && e.code === "invalid" && e.status === 400,
    );
    await assert.rejects(
      async () => {
        for await (const _ of b.client.stream(`/v1/sessions/${s.id}/agents/main/events?docs=app.shared-state`, new AbortController().signal));
      },
      (e: unknown) => e instanceof DpiError && e.code === "invalid",
    );
  }));

test("agent stream: hello, snapshot, then one doc frame per requested kind", () =>
  withBoot(async (b) => {
    const s = await newSession(b);
    const t = b.tail(`/v1/sessions/${s.id}/agents/main/events?${DOCS}`);
    await t.waitFor((f) => f.type === "doc" && f.kind === "demo.workspace");
    assert.deepEqual(t.frames.map((f) => f.type), ["hello", "snapshot", "doc", "doc"]);
    assert.deepEqual(t.frames[0], { type: "hello", apiVersion: 1, serverTime: (t.frames[0] as { serverTime: number }).serverTime, scope: { kind: "agent", sessionId: s.id, agentId: 1 } });
    const snap = t.frames[1] as Extract<Frame, { type: "snapshot" }>;
    assert.deepEqual(snap.inbox, []);
    assert.equal(snap.snapshot.type, "snapshot");
    for (const k of ["entries", "tools", "compactions", "inbox"] as const) assert.ok(Array.isArray(snap.snapshot[k]), k);
    assert.deepEqual(snap.snapshot.agent.model, { provider: "fake", modelId: "echo" });
    assert.deepEqual(t.frames[2], { type: "doc", kind: "demo.job-runs", value: { counts: {}, items: {} } });
    assert.deepEqual(t.frames[3], { type: "doc", kind: "demo.workspace", value: {} });
    // without ?docs there are no doc frames
    const bare = b.tail(`/v1/sessions/${s.id}/agents/1/events`);
    await bare.waitFor((f) => f.type === "snapshot");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(bare.frames.map((f) => f.type), ["hello", "snapshot"]);
    // unknown session is a 404 stream failure
    await assert.rejects(
      async () => {
        for await (const _ of b.client.stream("/v1/sessions/nope/agents/main/events", new AbortController().signal));
      },
      (e: unknown) => e instanceof DpiError && e.code === "not_found",
    );
  }));

test("session stream: hello then session {agents, tasks: [], usage}", () =>
  withBoot(async (b) => {
    const s = await newSession(b);
    const t = b.tail(`/v1/sessions/${s.id}/events`);
    await t.waitFor((f) => f.type === "session");
    assert.equal(t.frames[0].type, "hello");
    const f = t.frames[1] as Extract<Frame, { type: "session" }>;
    assert.equal(f.agents[0].id, 1);
    assert.deepEqual(f.tasks, []);
    assert.deepEqual(f.usage, { models: {}, tools: {} });
    await b.call("POST", msgs(s), { content: "u", requestId: "u1" });
    await t.waitFor((x) => x.type === "usage" && Object.keys(x.usage.models).length > 0, "usage frame after the run");
  }));

test("send: 202 queued, requestId dedupe, batches reach the SSE client in order and render through AgentModel", () =>
  withBoot(async (b) => {
    const s = await newSession(b);
    const t = b.tail(`/v1/sessions/${s.id}/agents/main/events?${DOCS}`);
    await t.waitFor((f) => f.type === "doc" && f.kind === "demo.workspace");

    const r1 = await b.call("POST", msgs(s), { content: "hello", requestId: "req-1", whenBusy: "followUp" });
    assert.equal(r1.status, 202);
    assert.equal(r1.body.status, "queued");
    assert.equal(typeof r1.body.submissionId, "number");
    const again = await b.call("POST", msgs(s), { content: "hello", requestId: "req-1", whenBusy: "followUp" });
    assert.equal(again.status, 202);
    assert.equal(again.body.submissionId, r1.body.submissionId);
    assert.equal(b.driver.agent([...b.driver.agents.keys()][0]).sends.length, 1);

    await t.waitFor((f) => f.type === "batch" && f.events.some((e) => e.type === "run_end"), "run_end");
    const types = batchTypes(t.frames);
    const at = (type: string, from = 0) => types.indexOf(type as never, from);
    const order = [
      at("message_end"), // user entry
      at("run_start"),
      at("tool_execution_start"),
      at("tool_execution_update"),
      at("tool_execution_end"),
      at("message_update"),
      at("run_end"),
    ];
    assert.ok(order.every((i) => i >= 0), JSON.stringify(types));
    assert.deepEqual([...order].sort((x, y) => x - y), order, JSON.stringify(types));

    const model = new AgentModel();
    for (const f of t.frames) model.apply(f);
    assert.equal(model.state.running, false);
    assert.deepEqual(model.state.items.map((i) => i.kind), ["user", "assistant", "assistant"]);
    const [user, withTool, final] = model.state.items as any[];
    assert.equal(user.text, "hello");
    assert.equal(withTool.blocks[1].call.name, "bash");
    assert.equal(withTool.blocks[1].call.status, "done");
    assert.equal(withTool.blocks[1].call.result, "hi\n");
    assert.equal(final.blocks[0].text, "Echo: hello");
    assert.ok(model.state.usage.models["fake/echo"]);

    // a viewer that attaches later gets the same transcript from the snapshot
    const late = b.tail(`/v1/sessions/${s.id}/agents/main/events`);
    await late.waitFor((f) => f.type === "snapshot");
    const m2 = new AgentModel();
    for (const f of late.frames) m2.apply(f);
    assert.deepEqual(m2.state.items.map((i) => i.kind), ["user", "assistant", "assistant"]);
  }));

test("whenBusy reject while busy is 409 busy; followUp and a retry are still accepted", () =>
  withBoot(async (b) => {
    b.driver.hold = true;
    const s = await newSession(b);
    assert.equal((await b.call("POST", msgs(s), { content: "one", requestId: "b1" })).status, 202);
    await until(() => busyOf(b, s.id), 5000, "busy");
    const rejected = await b.call("POST", msgs(s), { content: "two", requestId: "b2", whenBusy: "reject" });
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.body, { error: { code: "busy", message: "The agent is busy and the input asked to be rejected while busy" } });
    assert.equal(b.driver.agent([...b.driver.agents.keys()][0]).sends.length, 1);
    assert.equal((await b.call("POST", msgs(s), { content: "three", requestId: "b3", whenBusy: "followUp" })).status, 202);
    assert.equal((await b.call("POST", msgs(s), { content: "four", requestId: "b4", whenBusy: "steer" })).status, 202);
    // a request the driver already accepted keeps answering 202 even if it is retried as reject
    assert.equal((await b.call("POST", msgs(s), { content: "one", requestId: "b1", whenBusy: "reject" })).status, 202);
    await b.call("POST", `/v1/sessions/${s.id}/agents/main/abort`, {});
  }));

test("abort: {ok:true}, run_end on the stream, busy clears in the tree", () =>
  withBoot(async (b) => {
    b.driver.hold = true;
    const s = await newSession(b);
    const t = b.tail(`/v1/sessions/${s.id}/agents/main/events`);
    const dev = b.tail("/v1/events");
    await t.waitFor((f) => f.type === "snapshot");
    await b.call("POST", msgs(s), { content: "stuck", requestId: "x1" });
    await dev.waitFor((f) => f.type === "tree" && f.tree.sessions[0]?.busy === true, "busy tree");
    const res = await b.call("POST", `/v1/sessions/${s.id}/agents/main/abort`, { background: false });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    await t.waitFor((f) => f.type === "batch" && f.events.some((e) => e.type === "run_end"), "run_end");
    await dev.waitFor((f) => f.type === "tree" && f.tree.sessions[0]?.busy === false && f.tree.sessions[0].agents[0].busy === false, "idle tree");
    assert.equal(b.driver.agent([...b.driver.agents.keys()][0]).aborts, 1);
    assert.equal(await busyOf(b, s.id), false);
    // abort on an idle agent is still {ok:true}
    assert.deepEqual((await b.call("POST", `/v1/sessions/${s.id}/agents/main/abort`, {})).body, { ok: true });
  }));
