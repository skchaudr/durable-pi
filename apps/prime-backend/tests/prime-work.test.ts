// Prime work panel over REST and SSE, against the fake driver: goal, heartbeat, schedules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, newSession, until, type Booted } from "./helpers.js";
import { SessionModel } from "../../dpi-sdk/src/models.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import type { Frame } from "../../dpi-sdk/src/api.js";
import type { FakeAgent, FakeTasks } from "../src/fake-driver.js";

async function withBoot(fn: (b: Booted, s: { id: string }, agent: FakeAgent) => Promise<void>) {
  const b = await boot();
  try {
    const s = await newSession(b);
    await fn(b, s, b.driver.agent([...b.driver.agents.keys()][0]));
  } finally {
    await b.stop();
    await b.cleanup();
  }
}
const base = (s: { id: string }) => `/v1/sessions/${s.id}/prime`;
const code = (c: string) => (e: unknown) => e instanceof DpiError && e.code === c;
const idle = (agent: FakeAgent) => until(() => !agent.busy(), 5000, "agent idle");

test("work starts empty", () =>
  withBoot(async (b, s) => {
    assert.deepEqual((await b.call("GET", `${base(s)}/work`)).body, { goal: null, heartbeat: null, schedules: [] });
    assert.equal((await b.call("GET", `/v1/sessions/nope/prime/work`)).status, 404);
  }));

test("goal: set with a budget goes out as a /goal message, then pause, resume and clear", () =>
  withBoot(async (b, s, agent) => {
    const h = b.client.session(s.id);
    assert.deepEqual(await h.setPrimeGoal("ship the thing", 500), { queued: false });
    assert.equal(agent.sends[0].content, "/goal --budget 500 ship the thing");
    assert.equal(agent.sends[0].whenBusy, "followUp");
    assert.deepEqual((await h.primeWork()).goal, { status: "active", objective: "ship the thing", tokenBudget: 500, tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 });
    await idle(agent);
    await h.primeGoal("pause");
    assert.equal((await h.primeWork()).goal?.status, "paused");
    await idle(agent);
    await h.primeGoal("resume");
    assert.equal((await h.primeWork()).goal?.status, "active");
    assert.deepEqual(agent.sends.map((x) => x.content).slice(1), ["/goal pause", "/goal resume"]);
    await idle(agent);
    await h.primeGoal("clear");
    assert.equal((await h.primeWork()).goal, null);
    await idle(agent);
    await h.setPrimeGoal("no budget");
    assert.equal(agent.sends.at(-1)!.content, "/goal no budget");
  }));

test("goal set while the agent is busy queues like a chat message instead of being refused, and applies when the run ends", () =>
  withBoot(async (b, s, agent) => {
    b.driver.hold = true;
    await b.call("POST", `/v1/sessions/${s.id}/agents/main/messages`, { content: "work", requestId: "w1" });
    await until(() => agent.busy(), 5000, "busy");
    const r = await b.call("PUT", `${base(s)}/goal`, { objective: "after this turn", tokenBudget: 0 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { queued: true });
    assert.equal(agent.sends.at(-1)!.content, "/goal after this turn");
    assert.equal((await b.call("GET", `${base(s)}/work`)).body.goal, null); // not applied yet
    await agent.abort(); // the run ends: the queued command runs
    await until(async () => (await b.call("GET", `${base(s)}/work`)).body.goal?.objective === "after this turn", 5000, "queued goal applied");
  }));

test("goal: bad input and wrong state are plain 400/409", () =>
  withBoot(async (b, s) => {
    const goal = (body: unknown) => b.call("PUT", `${base(s)}/goal`, body);
    assert.equal((await goal({})).status, 400);
    assert.equal((await goal({ objective: "  " })).status, 400);
    assert.equal((await goal({ objective: "x", tokenBudget: -5 })).status, 400);
    assert.equal((await goal({ objective: "x", tokenBudget: 1.5 })).status, 400);
    assert.equal((await b.call("POST", `${base(s)}/goal/pause`, {})).status, 409); // no goal yet
    assert.equal((await b.call("POST", `${base(s)}/goal/explode`, {})).status, 400);
  }));

test("heartbeat: set replaces, pause, resume, stop; errors are 400/404", () =>
  withBoot(async (b, s) => {
    const h = b.client.session(s.id);
    const one = await h.setPrimeHeartbeat({ schedule: "every 1h", prompt: "beat one", deliveryMode: "steer" });
    assert.deepEqual([one.schedule, one.prompt, one.status, one.deliveryMode], ["every 1h", "beat one", "active", "steer"]);
    const two = await h.setPrimeHeartbeat({ schedule: "every 2h", prompt: "beat two" });
    assert.notEqual(two.id, one.id);
    assert.equal((await h.primeWork()).heartbeat?.id, two.id); // one heartbeat per session
    await h.primeHeartbeat(two.id, "pause");
    assert.equal((await h.primeWork()).heartbeat?.status, "paused");
    await h.primeHeartbeat(two.id, "resume");
    assert.equal((await h.primeWork()).heartbeat?.status, "active");
    await assert.rejects(h.primeHeartbeat(one.id, "pause"), code("not_found"));
    await h.primeHeartbeat(two.id, "stop");
    assert.equal((await h.primeWork()).heartbeat, null);
    assert.equal((await b.call("PUT", `${base(s)}/heartbeat`, { prompt: "no schedule" })).status, 400);
    assert.equal((await b.call("PUT", `${base(s)}/heartbeat`, { schedule: "soon", prompt: "x" })).status, 400);
    assert.equal((await b.call("PUT", `${base(s)}/heartbeat`, { schedule: "every 1h", prompt: "x", deliveryMode: "shout" })).status, 400);
  }));

test("schedules: add, list, edit changes the id, cancel; a bad edit keeps the old; unknown ids are 404", () =>
  withBoot(async (b, s) => {
    const h = b.client.session(s.id);
    const a = await h.addPrimeSchedule({ schedule: "in 30m", prompt: "check" });
    const other = await h.addPrimeSchedule({ schedule: "every 1h", prompt: "other" });
    assert.deepEqual((await h.primeWork()).schedules.map((j) => j.id), [a.id, other.id]);

    const { job, replaced } = await h.editPrimeSchedule(a.id, { schedule: "every 2h", prompt: "check harder" });
    assert.equal(replaced, a.id);
    assert.notEqual(job.id, a.id);
    assert.deepEqual((await h.primeWork()).schedules.map((j) => [j.id, j.schedule, j.prompt]), [[other.id, "every 1h", "other"], [job.id, "every 2h", "check harder"]]);

    await assert.rejects(h.editPrimeSchedule(job.id, { schedule: "never", prompt: "x" }), code("invalid"));
    assert.equal((await h.primeWork()).schedules.length, 2); // still both, job untouched
    await assert.rejects(h.editPrimeSchedule(a.id, { schedule: "in 1h", prompt: "x" }), code("not_found")); // the old id is gone
    await assert.rejects(h.cancelPrimeSchedule("zzz"), code("not_found"));
    assert.equal((await b.call("POST", `${base(s)}/schedules`, { prompt: "no schedule" })).status, 400);

    await h.cancelPrimeSchedule(other.id);
    await h.cancelPrimeSchedule(job.id);
    assert.deepEqual((await h.primeWork()).schedules, []);
  }));

test("session stream: prime_work arrives with the snapshot and on every change, including a goal usage tick, and feeds SessionModel", () =>
  withBoot(async (b, s, agent) => {
    const t = b.tail(`/v1/sessions/${s.id}/events`);
    const work = (f: Frame) => (f as Extract<Frame, { type: "prime_work" }>).work;
    const first = await t.waitFor((f) => f.type === "prime_work", "first prime_work");
    assert.deepEqual(work(first), { goal: null, heartbeat: null, schedules: [] });

    const h = b.client.session(s.id);
    await h.addPrimeSchedule({ schedule: "every 1h", prompt: "tick" });
    await t.waitFor((f) => f.type === "prime_work" && work(f).schedules.length === 1, "schedule frame");
    await h.setPrimeGoal("stream goal", 100);
    await t.waitFor((f) => f.type === "prime_work" && work(f).goal?.objective === "stream goal", "goal frame");
    (agent.tasks() as FakeTasks).setGoalState({ tokensUsed: 40 }); // what a goal_update does
    const tick = await t.waitFor((f) => f.type === "prime_work" && work(f).goal?.tokensUsed === 40, "usage tick frame");

    const model = new SessionModel();
    for (const f of t.frames) model.apply(f);
    assert.deepEqual(model.state.primeWork, work(tick));
  }));
