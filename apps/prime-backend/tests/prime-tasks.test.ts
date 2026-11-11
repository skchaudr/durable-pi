// Unit: Prime job/goal JSON -> dpi shapes, against a fake daemon. Integration: an isolated pa-daemon supervisor (no API
// keys in its env; no prompt is ever sent, the far-future schedule never fires).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DaemonClient } from "../src/prime/client.js";
import { launchEnv } from "../src/prime/env.js";
import { PrimeTasks, cronItem, goalItem, taskNode, taskOutcome, type Daemon } from "../src/prime/tasks.js";

const job = (o: object) => ({
  id: "j1", status: "active", source: "cron", activeSessionId: "s", sessionId: "sid", sessionFile: "/f", cwd: "/w", prompt: "check the build\nand report",
  schedule: { kind: "interval", expression: "every 5m", intervalMs: 300000 }, createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
  nextRunAt: "2026-11-11T10:05:00.000Z", runCount: 0, ...o,
});
const goal = (o: object) => ({ active: true, status: "active", goalId: "g1", objective: "ship the thing", tokenBudget: 1000, tokensUsed: 10, timeUsedSeconds: 3, continuationsUsed: 1, updatedAt: 1794000000000, ...o });

/** Fake daemon: scripted state, records commands. */
class Fake extends EventEmitter implements Daemon {
  jobs: any[] = [];
  goal: any = { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 };
  sent: any[] = [];
  goals = 0;
  async request(c: any) {
    this.sent.push(c);
    switch (c.type) {
      case "cron_list": return { jobs: this.jobs };
      case "get_connection_state": return { goal: this.goal };
      case "cron_add": { const j = job({ id: "new1", prompt: c.prompt, schedule: { kind: "once", expression: c.schedule } }); this.jobs.push(j); return { job: j }; }
      case "heartbeat_set": { const j = job({ id: "hb1", source: "heartbeat", prompt: c.prompt, schedule: { kind: "interval", expression: c.schedule } }); this.jobs.push(j); return { heartbeat: j }; }
      case "cron_cancel": this.jobs.forEach((j) => j.id === c.jobId && (j.status = "cancelled")); return {};
      case "heartbeat_manage": this.jobs.forEach((j) => j.id === c.jobId && (j.status = "cancelled")); return {};
      case "prompt":
        if (c.message.startsWith("/goal clear")) this.goal = { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 };
        else this.goal = goal({ goalId: `g${++this.goals}`, objective: c.message.replace(/^\/goal (--budget \d+ )?/, "") });
        return undefined;
    }
    throw Error(`unexpected ${c.type}`);
  }
}

test("a schedule maps to a waiting prime.schedule node with the schedule and prompt head", () => {
  const n = taskNode(7, cronItem(job({})));
  assert.deepEqual(n, { id: 7, kind: "prime.schedule", conversationId: 1, background: true, state: { status: "waiting", phase: "next 2026-11-11T10:05:00.000Z" }, conversations: [], label: "every 5m: check the build and report" });
});

test("a heartbeat is prime.heartbeat, paused shows as phase paused", () => {
  const it = cronItem(job({ source: "heartbeat", status: "paused", nextRunAt: undefined }));
  assert.equal(it.kind, "prime.heartbeat");
  assert.equal(it.live, true);
  assert.equal(taskNode(1, it).state.phase, "paused");
  assert.match(it.label, /^Heartbeat every 5m: /);
});

test("cancelled and completed jobs are terminal outcomes; a failed one-shot carries its error", () => {
  assert.deepEqual(taskOutcome(2, cronItem(job({ status: "cancelled", nextRunAt: undefined }))).state.outcome?.status, "aborted");
  const done = cronItem(job({ status: "completed", runCount: 1, lastRunAt: "2026-11-11T10:05:00.000Z" }));
  assert.equal(done.live, false);
  assert.deepEqual(taskOutcome(3, done), { id: 3, kind: "prime.schedule", conversationId: 1, state: { status: "terminal", outcome: { status: "completed", result: { id: "j1", schedule: "every 5m", prompt: "check the build\nand report", runCount: 1, lastRunAt: "2026-11-11T10:05:00.000Z" } } } });
  const bad = taskOutcome(4, cronItem(job({ status: "completed", lastError: "boom" })));
  assert.deepEqual(bad.state.outcome?.error, { message: "boom" });
  assert.equal(bad.state.outcome?.status, "failed");
});

test("goal states: idle is nothing, active is running, complete/error/budget are terminal", () => {
  assert.equal(goalItem({ status: "idle" }), undefined);
  assert.equal(goalItem(null), undefined);
  assert.equal(goalItem({ status: "active", objective: undefined }), undefined);
  const live = goalItem(goal({}))!;
  assert.deepEqual(taskNode(5, live), { id: 5, kind: "prime.goal", conversationId: 1, background: true, state: { status: "running", phase: "active" }, conversations: [], label: "ship the thing" });
  assert.equal(taskNode(5, goalItem(goal({ status: "paused" }))!).state.status, "waiting");
  assert.equal(goalItem(goal({ status: "complete" }))!.outcome?.status, "completed");
  assert.equal(goalItem(goal({ status: "budget_limited" }))!.outcome?.status, "aborted");
  assert.deepEqual(goalItem(goal({ status: "error", lastError: "provider down" }))!.outcome?.error, { message: "provider down" });
});

test("ids are numeric, stable across polls, and survive a restart through idFile", async () => {
  const dir = mkdtempSync("/tmp/pbt-ids-");
  const idFile = join(dir, "ids.json");
  const d = new Fake();
  d.jobs = [job({ id: "a" }), job({ id: "b" })];
  const t = new PrimeTasks(d, "s", { idFile });
  const first = (await t.liveTasks()).map((n) => [n.id, n.label]);
  assert.deepEqual(first.map(([id]) => id), [1, 2]);
  assert.deepEqual((await t.liveTasks()).map((n) => n.id), [1, 2]);
  d.jobs.push(job({ id: "c" }));
  const again = new PrimeTasks(d, "s", { idFile }); // "restart"
  assert.deepEqual((await again.liveTasks()).map((n) => n.id), [1, 2, 3]);
  assert.ok(JSON.parse(readFileSync(idFile, "utf8")).ids["cron:c"] === 3);
  rmSync(dir, { recursive: true, force: true });
});

test("runJob creates on the session, returns the task id and publishes a run that follows the task", async () => {
  const d = new Fake();
  const t = new PrimeTasks(d, () => "s");
  const { taskId } = await t.runJob("prime.schedule", { schedule: "in 2h", prompt: "ping" });
  assert.deepEqual(d.sent.find((c) => c.type === "cron_add"), { type: "cron_add", schedule: "in 2h", prompt: "ping", activeSessionId: "s" });
  assert.deepEqual((await t.liveTasks()).map((n) => n.id), [taskId]);
  let doc = t.jobRunsDoc();
  assert.deepEqual(doc.counts, { "prime.schedule": 1 });
  assert.equal(doc.items[String(taskId)].status, "waiting");
  assert.equal(doc.items[String(taskId)].title, "Schedule a prompt");
  assert.deepEqual(doc.items[String(taskId)].input, { schedule: "in 2h", prompt: "ping" });
  await t.abort(taskId);
  doc = t.jobRunsDoc();
  assert.equal(doc.items[String(taskId)].status, "aborted");
  assert.deepEqual(await t.liveTasks(), []);
  assert.deepEqual((await t.terminalTasks(10)).map((o) => [o.id, o.state.outcome?.status]), [[taskId, "aborted"]]);
});

test("heartbeat jobs use heartbeat_set and abort uses heartbeat_manage stop", async () => {
  const d = new Fake();
  const t = new PrimeTasks(d, "s");
  const { taskId } = await t.runJob("prime.heartbeat", { prompt: "beat" });
  assert.equal(d.sent.find((c) => c.type === "heartbeat_set").schedule, "every 1h");
  assert.equal((await t.liveTasks())[0].kind, "prime.heartbeat");
  await t.abort(taskId);
  assert.deepEqual(d.sent.find((c) => c.type === "heartbeat_manage"), { type: "heartbeat_manage", jobId: "hb1", action: "stop", activeSessionId: "s" });
});

test("goal job sends /goal with the budget; abort sends /goal clear and keeps an aborted outcome", async () => {
  const d = new Fake();
  const t = new PrimeTasks(d, "s");
  const { taskId } = await t.runJob("prime.goal", { objective: "make it pass", tokenBudget: 5000 });
  assert.equal(d.sent.find((c) => c.type === "prompt").message, "/goal --budget 5000 make it pass");
  assert.deepEqual((await t.liveTasks()).map((n) => [n.id, n.kind, n.state.status]), [[taskId, "prime.goal", "running"]]);
  assert.equal(t.jobRunsDoc().items[String(taskId)].status, "running");
  await t.abort(taskId);
  assert.ok(d.sent.some((c) => c.type === "prompt" && c.message === "/goal clear"));
  assert.deepEqual(await t.liveTasks(), []);
  const [o] = await t.terminalTasks(5);
  assert.equal(o.id, taskId);
  assert.equal(o.state.outcome?.status, "aborted");
  assert.equal(t.jobRunsDoc().items[String(taskId)].status, "aborted");
  assert.notEqual((await t.runJob("prime.goal", { objective: "again" })).taskId, taskId); // a new goal gets a new id
});

test("runJob validates: unknown job, empty required input, bad integer; no budget flag at 0", async () => {
  const d = new Fake();
  const t = new PrimeTasks(d, "s");
  await assert.rejects(t.runJob("nope", {}), { code: "not_found" });
  await assert.rejects(t.runJob("prime.goal", {}), { code: "invalid", message: /objective is required/ });
  await assert.rejects(t.runJob("prime.goal", { objective: "x", tokenBudget: -1 }), { code: "invalid" });
  await assert.rejects(t.runJob("prime.goal", { objective: "x", tokenBudget: 1.5 }), { code: "invalid" });
  assert.equal(d.sent.length, 0);
  await t.runJob("prime.goal", { objective: "plain", tokenBudget: "0" });
  assert.equal(d.sent.find((c) => c.type === "prompt").message, "/goal plain");
  await assert.rejects(t.abort(999), { code: "not_found" });
});

test("terminalTasks returns the newest `limit`, oldest first", async () => {
  const d = new Fake();
  d.jobs = [1, 2, 3].map((i) => job({ id: `c${i}`, status: "cancelled", updatedAt: `2026-11-11T1${i}:00:00.000Z` }));
  const t = new PrimeTasks(d, "s");
  assert.deepEqual((await t.terminalTasks(2)).map((o) => o.id), [2, 3]);
  assert.deepEqual(await t.liveTasks(), []);
});

test("onChange fires on a heartbeats_changed frame and on goal_update for this session only, once per real change", async () => {
  const d = new Fake();
  const t = new PrimeTasks(d, "s", { pollMs: 3_600_000 });
  await t.refresh();
  let fired = 0;
  const off = t.onChange(() => fired++);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  await settle();
  const base = fired; // the subscribe-time refresh may report nothing new
  d.jobs.push(job({ id: "z" }));
  d.emit("frame", { type: "heartbeats_changed" });
  await settle();
  assert.equal(fired, base + 1);
  d.emit("frame", { type: "heartbeats_changed" }); // nothing changed: no second notification
  await settle();
  assert.equal(fired, base + 1);
  d.goal = goal({});
  d.emit("session_event", { activeSessionId: "other", event: { type: "goal_update", goal: d.goal } });
  await settle();
  assert.equal(fired, base + 1);
  d.emit("session_event", { activeSessionId: "s", event: { type: "goal_update", goal: d.goal } });
  await settle();
  assert.equal(fired, base + 2);
  off();
  assert.equal(d.listenerCount("frame"), 0);
  assert.equal(d.listenerCount("session_event"), 0);
});

test("onChange polls when no event arrives", async () => {
  const d = new Fake();
  const t = new PrimeTasks(d, "s", { pollMs: 20 });
  let fired = 0;
  const off = t.onChange(() => fired++);
  await new Promise((r) => setTimeout(r, 40));
  const base = fired;
  d.jobs.push(job({ id: "p" }));
  await new Promise((r) => setTimeout(r, 80));
  off();
  assert.ok(fired > base);
});

// ------------------------------------------------------------------ integration

const BIN = process.env.PRIME_PA_DAEMON ?? "/Volumes/Mini-SSD/offload/repos/prime-agent-durable/target/release/pa-daemon";
const skip = !existsSync(BIN) && "pa-daemon binary not found";

test("integration: cron_add shows up live, abort moves it to terminal (isolated supervisor, nothing is prompted)", { skip }, async () => {
  const root = mkdtempSync("/tmp/pbt-tasks-"); // short: unix socket paths cap near 104 bytes
  const agentDir = join(root, "agent");
  const socketPath = join(root, "s", "d.sock");
  mkdirSync(join(root, "s"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(join(root, "work"), { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { cliproxy: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "CLIPROXY_API_KEY", api: "openai-completions", models: [{ id: "test-model", name: "Test Model", reasoning: true, contextWindow: 200000, cost: { input: 1, output: 5 } }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "cliproxy", defaultModel: "test-model" }));
  const sup: ChildProcess = spawn("env", ["-i", `HOME=${root}`, "PATH=/usr/bin:/bin", BIN, "supervisor", "--socket", socketPath, "--agent-dir", agentDir], { stdio: "ignore" });
  const client = new DaemonClient(socketPath, { backoffMs: [50, 100] });
  let tasks: PrimeTasks | undefined;
  try {
    for (let i = 0; i < 100 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(socketPath), "supervisor socket never appeared");
    await client.connect();
    const made = await client.request({ type: "create", lifecycle: "resident", launchEnv: launchEnv({ PATH: "/usr/bin:/bin", HOME: root }), config: { cwd: join(root, "work"), sessionDir: join(agentDir, "sessions"), provider: "cliproxy", model: "test-model" } });
    await client.request({ type: "attach", activeSessionId: made.activeSessionId });
    tasks = new PrimeTasks(client, made.activeSessionId, { idFile: join(root, "ids.json") });
    assert.deepEqual(await tasks.liveTasks(), []);

    const { taskId } = await tasks.runJob("prime.schedule", { schedule: "at 2099-01-01T00:00:00Z", prompt: "never fires" });
    const live = await tasks.liveTasks();
    assert.equal(live.length, 1);
    assert.equal(live[0].id, taskId);
    assert.equal(live[0].kind, "prime.schedule");
    assert.match(live[0].label!, /at 2099-01-01T00:00:00Z: never fires/);
    assert.equal(tasks.jobRunsDoc().items[String(taskId)].status, "waiting");

    const hb = await tasks.runJob("prime.heartbeat", { schedule: "every 24h", prompt: "never beats" });
    assert.deepEqual((await tasks.liveTasks()).map((n) => [n.id, n.kind]), [[taskId, "prime.schedule"], [hb.taskId, "prime.heartbeat"]]);

    await tasks.abort(taskId);
    await tasks.abort(hb.taskId);
    assert.deepEqual(await tasks.liveTasks(), []);
    const done = await tasks.terminalTasks(10);
    assert.deepEqual(done.map((o) => [o.id, o.state.outcome?.status]), [[taskId, "aborted"], [hb.taskId, "aborted"]]);
    assert.equal(tasks.jobRunsDoc().items[String(taskId)].status, "aborted");
    assert.equal(tasks.jobRunsDoc().items[String(hb.taskId)].status, "aborted");
  } finally {
    tasks?.close();
    client.close();
    sup.kill("SIGTERM");
    await new Promise((r) => (sup.exitCode !== null ? r(0) : sup.once("exit", r)));
    await new Promise((r) => setTimeout(r, 300));
    rmSync(root, { recursive: true, force: true });
  }
});
