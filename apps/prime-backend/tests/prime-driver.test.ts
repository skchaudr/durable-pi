// Integration: the driver against an isolated pa-daemon supervisor (no API keys in its env; nothing is ever prompted).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { WireAgentEvent } from "../../dpi-sdk/src/api.js";
import createDriver from "../src/acp-driver.js";
import { ApiFault } from "../src/errors.js";
import type { PrimeDriver } from "../src/driver.js";

const BIN = process.env.PRIME_PA_DAEMON ?? "/Volumes/Mini-SSD/offload/repos/prime-agent-durable/target/release/pa-daemon";
const skip = !existsSync(BIN) && "pa-daemon binary not found";

const root = mkdtempSync("/tmp/pbt-"); // short: unix socket paths cap near 104 bytes
const agentDir = join(root, "agent");
const socketPath = join(root, "s", "d.sock");
const work = join(root, "work");
const SID = "01a1cae3-efc8-7244-9b57-1c5cf3f67aaa";
let sup: ChildProcess | undefined;
let driver: PrimeDriver | undefined;

const startSupervisor = async () => {
  rmSync(socketPath, { force: true });
  sup = spawn("env", ["-i", `HOME=${root}`, "PATH=/usr/bin:/bin", BIN, "supervisor", "--socket", socketPath, "--agent-dir", agentDir], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(socketPath), "supervisor socket never appeared");
};
const stopSupervisor = async () => {
  const p = sup;
  if (!p) return;
  sup = undefined;
  p.kill("SIGTERM");
  await new Promise((r) => (p.exitCode !== null ? r(0) : p.once("exit", r)));
  await new Promise((r) => setTimeout(r, 300)); // workers follow the supervisor
};

before(async () => {
  if (skip) return;
  mkdirSync(join(root, "s"), { recursive: true });
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { cliproxy: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "CLIPROXY_API_KEY", api: "openai-completions", models: [{ id: "test-model", name: "Test Model", reasoning: true, contextWindow: 200000, cost: { input: 1, output: 5 } }] } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "cliproxy", defaultModel: "test-model" }));
  const u = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [
    { type: "session", version: 3, id: SID, timestamp: "2026-11-11T13:00:00.000Z", cwd: work, rlmDepth: 0 },
    { type: "model_change", id: "m1", parentId: null, timestamp: "2026-11-11T13:00:00.001Z", provider: "cliproxy", modelId: "test-model" },
    { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-11-11T13:00:00.002Z", thinkingLevel: "low" },
    { type: "message", id: "u1", parentId: "t1", timestamp: "2026-11-11T13:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "run echo hi" }], timestamp: 1794000001000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-11-11T13:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "need bash" }, { type: "text", text: "Running it." }, { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "echo hi" } }], api: "openai-completions", provider: "cliproxy", model: "test-model", usage: u, stopReason: "toolUse", timestamp: 1794000002000 } },
    { type: "message", id: "r1", parentId: "a1", timestamp: "2026-11-11T13:00:03.000Z", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "hi\n" }], isError: false, timestamp: 1794000003000 } },
    { type: "message", id: "a2", parentId: "r1", timestamp: "2026-11-11T13:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done: hi" }], api: "openai-completions", provider: "cliproxy", model: "test-model", usage: u, stopReason: "stop", timestamp: 1794000004000 } },
  ];
  writeFileSync(join(agentDir, "sessions", `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await startSupervisor();
  driver = await createDriver(undefined, { socketPath, agentDir, env: { PATH: "/usr/bin:/bin", HOME: root }, backoffMs: [50, 100] });
});
after(async () => {
  await driver?.close();
  await stopSupervisor();
  rmSync(root, { recursive: true, force: true });
});

test("models and default model come from models.json and settings.json", { skip }, () => {
  const [m] = driver!.models();
  assert.equal(driver!.models().length, 1);
  assert.deepEqual({ id: m.id, provider: m.provider, name: m.name, contextWindow: m.contextWindow, reasoning: m.reasoning, cost: m.cost }, { id: "test-model", provider: "cliproxy", name: "Test Model", contextWindow: 200000, reasoning: true, cost: { input: 1, output: 5 } });
  assert.equal(driver!.defaultModel(), "test-model");
});

test("openSession loads the saved transcript as dpi entries with the session's model", { skip }, async () => {
  await driver!.openSession(SID, work);
  const snap = driver!.agent(SID).snapshot();
  assert.deepEqual(snap.entries.map((e) => e.kind), ["pi.user", "pi.assistant", "pi.tool-result", "pi.assistant"]);
  assert.deepEqual(snap.entries.map((e) => e.id), [1, 2, 3, 4]);
  assert.deepEqual(snap.agent.model, { provider: "cliproxy", modelId: "test-model" });
  assert.equal(snap.agent.thinkingLevel, "low");
  assert.equal(snap.agent.cwd, work);
  assert.equal(driver!.agent(SID).busy(), false);
});

test("createSession makes a session file and setConfig drives set_model / set_thinking_level", { skip }, async () => {
  const { primeSessionId } = await driver!.createSession({ cwd: work, model: { provider: "cliproxy", modelId: "test-model" }, thinkingLevel: "medium" });
  assert.match(primeSessionId, /^[0-9a-f-]{36}$/);
  assert.ok(existsSync(join(agentDir, "sessions", `${primeSessionId}.jsonl`)));
  const a = driver!.agent(primeSessionId);
  assert.deepEqual(a.snapshot().entries, []);
  assert.equal(a.config().thinkingLevel, "medium");
  const seen: WireAgentEvent[] = [];
  a.subscribe((e) => seen.push(...e));
  const cfg = await a.setConfig({ thinkingLevel: "high", model: { provider: "cliproxy", modelId: "test-model" } });
  assert.equal(cfg.thinkingLevel, "high");
  assert.deepEqual(seen.map((e) => e.type), ["agent_changed"]);
  assert.equal(a.snapshot().agent.thinkingLevel, "high");
  assert.match(readFileSync(join(agentDir, "sessions", `${primeSessionId}.jsonl`), "utf8"), /"thinkingLevel":"high"/);
  await assert.rejects(a.setConfig({ instructions: "x" }), (e: ApiFault) => e.code === "invalid");
  await assert.rejects(a.setConfig({ thinkingLevel: "bogus" as never }), (e: ApiFault) => e.code === "invalid");
});

test("a supervisor restart reconnects, revives the sessions and pushes a fresh snapshot", { skip }, async () => {
  const a = driver!.agent(SID);
  const seen: WireAgentEvent[] = [];
  a.subscribe((e) => seen.push(...e));
  await stopSupervisor();
  await startSupervisor();
  for (let i = 0; i < 100 && !seen.some((e) => e.type === "snapshot"); i++) await new Promise((r) => setTimeout(r, 100));
  const snap = seen.find((e) => e.type === "snapshot");
  assert.ok(snap && snap.type === "snapshot", "no snapshot after reconnect");
  assert.equal(snap.entries.length, 4);
  assert.equal(a.snapshot().entries.length, 4);
});

test("retryWorker on a live session is retry_worker and leaves it usable; a child that was never seen has no live session", { skip }, async () => {
  const a = driver!.agent(SID);
  await a.retryWorker();
  assert.equal(a.busy(), false);
  assert.equal(a.snapshot().entries.length, 4);
  await assert.rejects(a.openChild("no-such-child"), (e: ApiFault) => e.code === "invalid");
});

test("an unknown session id is a not_found fault", { skip }, async () => {
  await assert.rejects(driver!.openSession("00000000-0000-7000-8000-000000000000", work), (e: ApiFault) => e.code === "not_found");
});
