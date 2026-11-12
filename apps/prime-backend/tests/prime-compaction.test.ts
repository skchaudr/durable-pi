// Unit: compaction settings against a fake client. Integration: compaction settings, compact and reset through the driver against
// an isolated pa-daemon supervisor (fake model endpoint at 127.0.0.1:1; no prompt is ever sent, so nothing calls a model).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WireAgentEvent } from "../../dpi-sdk/src/api.js";
import createDriver from "../src/acp-driver.js";
import { ApiFault } from "../src/errors.js";
import { compaction, setCompaction, type CompactionContext } from "../src/prime/compaction.js";

const root = mkdtempSync("/tmp/pbc-");
after(() => rmSync(root, { recursive: true, force: true }));

const fake = (state: any, sent: any[] = [], agentDir = root): CompactionContext => ({
  agentDir,
  activeSessionId: "act",
  client: { request: async (cmd: any) => (sent.push(cmd), cmd.type === "get_connection_state" ? state : undefined) } as CompactionContext["client"],
});

test("compaction: enabled from get_connection_state, margins from settings.json, Prime defaults otherwise; no background compaction", async () => {
  assert.deepEqual(await compaction(fake({ autoCompactionEnabled: false })), { enabled: false, reserveTokens: 16384, backgroundTokens: 0, keepRecentTokens: 20000 });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 4096, keepRecentTokens: 8000 } }));
  assert.deepEqual(await compaction(fake({ autoCompactionEnabled: true })), { enabled: true, reserveTokens: 4096, backgroundTokens: 0, keepRecentTokens: 8000 });
  rmSync(join(root, "settings.json"));
});

test("compaction: with a model, reserveTokens is the margin of Prime's trigger (window, output budget, 95%, retention floor)", async () => {
  const dir = mkdtempSync(join(root, "m-"));
  const model = { provider: "p", modelId: "m" };
  const put = (m: object, compaction?: object) => {
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { p: { models: [{ id: "m", ...m }] } } }));
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ compaction }));
  };
  const margin = async () => (await compaction({ ...fake({}, [], dir), model })).reserveTokens;
  put({ contextWindow: 400000, maxTokens: 128000 }); // combined cap: 400000 - 128000 - 16384
  assert.equal(await margin(), 144384);
  put({ contextWindow: 1000000 }); // 95% cap; maxTokens defaults to 16384
  assert.equal(await margin(), 50000);
  put({ contextWindow: 1000000 }, { thresholdPercent: 50 });
  assert.equal(await margin(), 500000);
  put({ contextWindow: 100000 }, { keepRecentTokens: 60000, reserveTokens: 20000 }); // retention floor 100001 -> combined cap 63616
  assert.equal(await margin(), 36384);
  assert.equal((await compaction(fake({}, [], dir))).reserveTokens, 20000); // no model: Prime's raw reserve
});

test("setCompaction: enabled is set_auto_compaction; every other field is a one-line 400", async () => {
  const sent: any[] = [];
  const out = await setCompaction(fake({ autoCompactionEnabled: false }, sent), { enabled: false });
  assert.equal(out.enabled, false);
  assert.deepEqual(sent.map((c) => c.type === "set_auto_compaction" ? [c.type, c.activeSessionId, c.enabled] : c.type), [["set_auto_compaction", "act", false], "get_connection_state"]);
  const bad = (body: any, re: RegExp) => assert.rejects(setCompaction(fake({}, sent), body), (e: ApiFault) => e.code === "invalid" && re.test(e.message) && !e.message.includes("\n"));
  await bad({ reserveTokens: 1 }, /reserveTokens.*settings\.json/);
  await bad({ keepRecentTokens: 1 }, /keepRecentTokens/);
  await bad({ backgroundTokens: 0 }, /no background compaction/);
  await bad({ enabled: "yes" }, /boolean/);
});

// ---- integration: isolated supervisor

const BIN = process.env.PRIME_PA_DAEMON ?? "/Volumes/Mini-SSD/offload/repos/prime-agent-durable/target/release/pa-daemon";
const skip = !existsSync(BIN) && "pa-daemon binary not found";
let sup: ChildProcess | undefined;
const hang = createServer(() => {}); // a model endpoint that accepts and never answers, so a summary stays in flight
const iso = mkdtempSync("/tmp/pbk-");
const agentDir = join(iso, "agent");
const socketPath = join(iso, "s", "d.sock");
const work = join(iso, "work");
const SID = "01a1cae3-efc8-7244-9b57-1c5cf3f67ccc";
const BIG = "01a1cae3-efc8-7244-9b57-1c5cf3f67ddd";
after(async () => {
  hang.closeAllConnections();
  hang.close();
  sup?.kill("SIGTERM");
  if (sup && sup.exitCode === null) await new Promise((r) => sup!.once("exit", r));
  rmSync(iso, { recursive: true, force: true });
});

test("integration: settings, compact and reset through the driver", { skip }, async () => {
  await new Promise<void>((r) => hang.listen(0, "127.0.0.1", r));
  for (const d of [join(iso, "s"), join(agentDir, "sessions"), work]) mkdirSync(d, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { cliproxy: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "CLIPROXY_API_KEY", api: "openai-completions", models: [{ id: "test-model", name: "Test", reasoning: true, contextWindow: 200000, cost: { input: 1, output: 5 } }] }, hang: { baseUrl: `http://127.0.0.1:${(hang.address() as { port: number }).port}/v1`, apiKey: "CLIPROXY_API_KEY", api: "openai-completions", models: [{ id: "hang-model", name: "Hang", reasoning: true, contextWindow: 200000, cost: { input: 1, output: 5 } }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "cliproxy", defaultModel: "test-model", compaction: { reserveTokens: 9000 } }));
  const u = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [
    { type: "session", version: 3, id: SID, timestamp: "2026-11-11T13:00:00.000Z", cwd: work, rlmDepth: 0 },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-11T13:00:00.001Z", provider: "cliproxy", modelId: "test-model" },
    { type: "message", id: "u1", parentId: "m1", timestamp: "2026-11-11T13:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1794000001000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-11T13:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hi there" }], api: "openai-completions", provider: "cliproxy", model: "test-model", usage: u, stopReason: "stop", timestamp: 1794000002000 } },
  ];
  writeFileSync(join(agentDir, "sessions", `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // a history long enough to compact: the summary call then hits the dead endpoint
  const long = [lines[0], { ...lines[1], provider: "hang", modelId: "hang-model" }];
  for (let i = 0; i < 12; i++) {
    const parent = i ? `a${i - 1}` : "m1";
    long.push({ type: "message", id: `u${i}`, parentId: parent, timestamp: "2026-11-11T13:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `${i} ${"lorem ipsum ".repeat(1500)}` }], timestamp: 1794000001000 + i } });
    long.push({ type: "message", id: `a${i}`, parentId: `u${i}`, timestamp: "2026-11-11T13:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: `ok ${i} ${"dolor sit ".repeat(1500)}` }], api: "openai-completions", provider: "hang", model: "hang-model", usage: u, stopReason: "stop", timestamp: 1794000002000 + i } });
  }
  writeFileSync(join(agentDir, "sessions", `${BIG}.jsonl`), long.map((l) => JSON.stringify({ ...l, ...(l.type === "session" ? { id: BIG } : {}) })).join("\n") + "\n");
  sup = spawn("env", ["-i", `HOME=${iso}`, "PATH=/usr/bin:/bin", BIN, "supervisor", "--socket", socketPath, "--agent-dir", agentDir], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(socketPath), "supervisor socket never appeared");
  const driver = await createDriver(undefined, { socketPath, agentDir, env: { PATH: "/usr/bin:/bin", HOME: iso } });
  try {
    await driver.openSession(SID, work);
    const a = driver.agent(SID);
    const seen: WireAgentEvent[] = [];
    a.subscribe((e) => seen.push(...e));

    // the margin is Prime's trigger: min(95% of 200k, 200k - 16384 default output - 9000 reserve) = 174616, so 25384 below the window
    assert.deepEqual(await a.compaction(), { enabled: true, reserveTokens: 25384, backgroundTokens: 0, keepRecentTokens: 20000 });
    assert.deepEqual(a.compactionNow(), await a.compaction()); // the session summary's copy, no daemon call
    assert.equal((await a.setCompaction({ enabled: false })).enabled, false);
    assert.equal((await a.compaction()).enabled, false);
    assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).compaction.enabled, false); // Prime persists the toggle
    assert.equal((await a.setCompaction({ enabled: true })).enabled, true);
    await assert.rejects(a.setCompaction({ reserveTokens: 2048 }), (e: ApiFault) => e.code === "invalid");

    // Two messages are too short for Prime to compact: the command reaches the daemon, its refusal is the caller's 400, and
    // the stream still shows the compaction begin and end (translate.ts).
    await assert.rejects(a.compact("keep the plan"), (e: ApiFault) => e.code === "invalid" && /too short to compact/.test(e.message));
    assert.deepEqual(seen.map((e) => e.type), ["compaction_start", "compaction_end"]);
    assert.equal(a.snapshot().compactions.length, 0);
    seen.length = 0;

    // A long history gets its compaction task id as soon as the summary starts; the endpoint never answers, so it stays running.
    await driver.openSession(BIG, work);
    const big = driver.agent(BIG);
    const bigSeen: WireAgentEvent[] = [];
    big.subscribe((e) => bigSeen.push(...e));
    assert.deepEqual(await big.compact("focus"), { taskId: 1 });
    assert.deepEqual(bigSeen.map((e) => e.type), ["compaction_start"]);
    assert.equal(big.snapshot().compactions[0].taskId, 1);

    // reset: a new session file, an empty snapshot, and the new id for the catalog
    const before = a.snapshot().entries.length;
    assert.equal(before, 2);
    const { primeSessionId } = await a.reset();
    assert.notEqual(primeSessionId, SID);
    assert.equal(a.snapshot().entries.length, 0);
    assert.equal(seen.filter((e) => e.type === "snapshot").length, 1);
    assert.ok(existsSync(join(agentDir, "sessions")) && readFileSync(join(agentDir, "sessions", `${SID}.jsonl`), "utf8").includes("hello"), "old session file kept");
    await driver.openSession(primeSessionId, work); // what a backend restart does with the catalog's new id
  } finally {
    await driver.close();
  }
});
