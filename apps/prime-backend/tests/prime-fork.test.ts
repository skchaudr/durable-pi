// POST .../agents and .../fork. Unit: forkPoint on hand-built trees, the routes over FakeDriver. Integration: the daemon
// commands acp-driver uses to fork, against an isolated pa-daemon supervisor (nothing is ever prompted).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WireEntry } from "../../dpi-sdk/src/api.js";
import createDriver from "../src/acp-driver.js";
import { ApiFault } from "../src/errors.js";
import { DaemonClient } from "../src/prime/client.js";
import { forkPoint } from "../src/prime/fork.js";
import { boot, until } from "./helpers.js";

const node = (id: string, parentId: string | null, role: string, type = "message") => ({ entry: { type, id, parentId, ...(type === "message" ? { message: { role } } : {}) } });
const tree = {
  leafId: "a2",
  flatNodes: [node("m1", null, "", "model_change"), node("u1", "m1", "user"), node("a1", "u1", "assistant"), node("x1", "a1", "user"), node("u2", "a1", "user"), node("a2", "u2", "assistant")],
};
const entry = (id: number, kind: string) => ({ id, conversationId: 1, kind }) as WireEntry;
const mine = [entry(1, "pi.user"), entry(2, "pi.assistant"), entry(3, "pi.user"), entry(4, "pi.assistant")];

test("forkPoint maps the nth transcript message to the nth message on the active branch", () => {
  assert.equal(forkPoint(tree, mine, 1), "u1");
  assert.equal(forkPoint(tree, mine, 4), "a2"); // x1 is on an abandoned branch
  assert.equal(forkPoint(tree, [...mine, entry(9, "prime.revival")], 2), "a1"); // revival lines are not messages
});

test("forkPoint: no fork point is a one-line 400", () => {
  const bad = (t: object, e: WireEntry[], id: number, re: RegExp) => assert.throws(() => forkPoint(t, e, id), (x: ApiFault) => x.code === "invalid" && re.test(x.message) && !x.message.includes("\n"));
  bad(tree, mine, 7, /not a user, assistant or tool result entry/);
  bad(tree, mine.slice(0, 3), 1, /no fork point/); // transcript shorter than the file (compacted)
  bad(tree, [entry(1, "pi.assistant"), ...mine.slice(1)], 1, /no fork point/); // roles differ
  bad({ flatNodes: [] }, mine, 1, /no fork point/);
});

test("routes: new agent and fork join the session's agent list and take messages", async () => {
  const b = await boot();
  try {
    const s = (await b.call("POST", "/v1/sessions", { name: "s", cwd: b.work, model: { provider: "fake", modelId: "echo" }, thinkingLevel: "high" })).body;
    const base = `/v1/sessions/${s.id}`;
    const made = await b.call("POST", `${base}/agents`, { name: "Side" }, { "idempotency-key": "k1" });
    assert.equal(made.status, 201);
    assert.deepEqual(made.body, { id: 2, name: "Side", named: true, kind: "root", busy: false, background: 0 });
    assert.equal((await b.call("POST", `${base}/agents`, { name: "Side" }, { "idempotency-key": "k1" })).headers.get("idempotent-replay"), "true");
    assert.equal((await b.call("GET", `${base}/agents`)).body.length, 2);
    const detail = (await b.call("GET", `${base}/agents/side`)).body;
    assert.deepEqual([detail.config.model, detail.config.thinkingLevel], [{ provider: "fake", modelId: "echo" }, "high"]);

    await b.call("POST", `${base}/agents/2/messages`, { content: "ping", requestId: "r1" });
    const fake = [...b.driver.agents.values()];
    await until(() => fake[1].entries.length === 4 && !fake[1].busy());
    assert.equal(fake[0].entries.length, 0); // the message went to agent 2 only
    assert.equal((await b.call("GET", `${base}/agents/2/entries`)).body.items.length, 4);

    const forked = await b.call("POST", `${base}/agents/2/fork`, { entryId: 2 });
    assert.equal(forked.status, 201);
    assert.deepEqual(forked.body, { id: 3, name: "Fork #3", named: false, kind: "fork", parentId: 2, forkedAt: 2, busy: false, background: 0 });
    assert.equal((await b.call("GET", `${base}/agents/3/entries`)).body.items.length, 2);
    assert.equal((await b.call("GET", `${base}`)).body.agents.length, 3);

    const bad = async (path: string, body: unknown, code: number) => assert.equal((await b.call("POST", `${base}${path}`, body)).status, code, path);
    await bad("/agents", { name: "12" }, 400);
    await bad("/agents", { name: "main" }, 400);
    await bad("/agents", { from: 9 }, 404);
    await bad("/agents/2/fork", {}, 400);
    await bad("/agents/2/fork", { entryId: 99 }, 400);
    await bad("/agents/2/fork", { entryId: 1, name: 5 }, 400);
    assert.equal((await b.call("GET", `${base}/agents`)).body.length, 3);
    // catalog survives a restart: all three agents reopen
    await b.stop();
    const again = await boot({ dir: b.dir, token: b.token, driver: b.driver });
    try {
      assert.deepEqual((await again.call("GET", `${base}/agents`)).body.map((a: { id: number }) => a.id), [1, 2, 3]);
    } finally {
      await again.stop();
    }
  } finally {
    await b.cleanup();
  }
});

// ---- integration: isolated supervisor

const BIN = process.env.PRIME_PA_DAEMON ?? "/Volumes/Mini-SSD/offload/repos/prime-agent-durable/target/release/pa-daemon";
const skip = !existsSync(BIN) && "pa-daemon binary not found";
const root = mkdtempSync("/tmp/pbt-fk-");
let sup: ChildProcess | undefined;
let closeDriver: (() => Promise<void>) | undefined;
after(async () => {
  await closeDriver?.();
  sup?.kill("SIGTERM");
  if (sup && sup.exitCode === null) await new Promise((r) => sup!.once("exit", r));
  rmSync(root, { recursive: true, force: true });
});

test("integration: fork leaves the source on its file and gives the fork a worker of its own", { skip }, async () => {
  const agentDir = join(root, "agent");
  const work = join(root, "work");
  const socketPath = join(root, "s", "d.sock");
  const SID = "01a1cae3-efc8-7244-9b57-1c5cf3f67ccc";
  mkdirSync(join(root, "s"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { cliproxy: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "CLIPROXY_API_KEY", api: "openai-completions", models: [{ id: "test-model", name: "Test Model", reasoning: true, contextWindow: 200000, cost: { input: 1, output: 5 } }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "cliproxy", defaultModel: "test-model" }));
  const u = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const text = (role: string, t: string, extra: object = {}) => ({ role, content: [{ type: "text", text: t }], timestamp: 1, ...extra });
  const lines = [
    { type: "session", version: 3, id: SID, timestamp: "2026-11-11T13:00:00.000Z", cwd: work, rlmDepth: 0 },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-11-11T13:00:01.000Z", message: text("user", "first") },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-11T13:00:02.000Z", message: text("assistant", "one", { api: "openai-completions", provider: "cliproxy", model: "test-model", usage: u, stopReason: "stop" }) },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-11-11T13:00:03.000Z", message: text("user", "second") },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-11-11T13:00:04.000Z", message: text("assistant", "two", { api: "openai-completions", provider: "cliproxy", model: "test-model", usage: u, stopReason: "stop" }) },
  ];
  writeFileSync(join(agentDir, "sessions", `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  sup = spawn("env", ["-i", `HOME=${root}`, "PATH=/usr/bin:/bin", BIN, "supervisor", "--socket", socketPath, "--agent-dir", agentDir], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(socketPath), "supervisor socket never appeared");
  const driver = await createDriver(undefined, { socketPath, agentDir, env: { PATH: "/usr/bin:/bin", HOME: root } });
  closeDriver = () => driver.close();

  await driver.openSession(SID, work);
  const { primeSessionId } = await driver.forkSession(SID, 2);
  assert.notEqual(primeSessionId, SID);
  assert.ok(existsSync(join(agentDir, "sessions", `${primeSessionId}.jsonl`)));
  const fork = driver.agent(primeSessionId);
  assert.deepEqual(fork.snapshot().entries.map((e) => e.kind), ["pi.user", "pi.assistant"]);
  assert.equal(fork.config().cwd, work);
  assert.equal(driver.agent(SID).snapshot().entries.length, 4);
  // the source's worker is still on the source file: it forks again, from its later entry
  const second = await driver.forkSession(SID, 4);
  assert.equal(driver.agent(second.primeSessionId).snapshot().entries.length, 4);
  // forking the fork works the same way
  const third = await driver.forkSession(primeSessionId, 1);
  assert.deepEqual(driver.agent(third.primeSessionId).snapshot().entries.map((e) => e.kind), ["pi.user"]);
  await assert.rejects(driver.forkSession(SID, 9), (e: ApiFault) => e.code === "invalid" && /not a user, assistant or tool result/.test(e.message));

  // schedules: fork rebinds the source worker's jobs to the fork's file while it moves; switch_session must hand them back
  const ops = new DaemonClient(socketPath);
  await ops.connect(1);
  try {
    const src = (driver.agent(SID) as unknown as { activeId: string }).activeId;
    const { job } = await ops.request({ type: "cron_add", activeSessionId: src, schedule: "0 0 1 1 *", prompt: "never fires in this test" }); // yearly: no model call
    const mine = async () => ((await ops.request({ type: "cron_list", includeInactive: true })).jobs as { id: string; sessionId: string; sessionFile: string }[]).filter((j) => j.id === job.id);
    assert.deepEqual((await mine()).map((j) => j.sessionId), [SID]);
    const forked = await driver.forkSession(SID, 2);
    const after = await mine();
    assert.equal(after.length, 1, "the job survives the fork");
    assert.equal(after[0].sessionId, SID, "the source still owns its job");
    assert.ok(after[0].sessionFile.endsWith(`${SID}.jsonl`));
    assert.notEqual(after[0].sessionId, forked.primeSessionId);
    await ops.request({ type: "cron_cancel", jobId: job.id });
  } finally {
    ops.close();
  }
});
