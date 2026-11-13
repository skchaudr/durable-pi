// The driver's child agents against a fake supervisor: which daemon commands each control sends, and that a child's own events stream.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { WireAgentEvent } from "../../dpi-sdk/src/api.js";
import createDriver from "../src/acp-driver.js";
import type { PrimeAgentHandle, PrimeDriver } from "../src/driver.js";
import { ApiFault } from "../src/errors.js";
import { until } from "./helpers.js";

const dir = mkdtempSync("/tmp/pbk-");
const hello = { type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: [] };
const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], provider: "p", model: "m", usage: {}, stopReason: "stop", timestamp: 2 });

const seen: any[] = []; // every command the driver sent, in order
const cmds = (type: string) => seen.filter((c) => c.type === type);
let client: net.Socket | undefined;
let childActive = "C1"; // what the roster says the child is attached as
let cancelError: string | undefined;

function answer(cmd: any): { data?: unknown; error?: string } {
  const on = cmd.activeSessionId;
  switch (cmd.type) {
    case "create":
      return { data: { sessionId: "sess-1", sessionFile: join(dir, "sess-1.jsonl"), activeSessionId: "A1" } };
    case "attach":
      return { data: { snapshot: { state: on === "A1" ? { model: { provider: "p", id: "m" }, thinkingLevel: "low", cwd: "/work" } : { model: { provider: "p", id: "kid-model" }, thinkingLevel: "medium", cwd: "/work" }, lastEventSequence: 0 } } };
    case "get_messages":
      return { data: { messages: [on === "A1" ? user("main task") : user("child task")], more: false } };
    case "get_rlm_children":
      return { data: { children: on === "A1" ? [{ id: "child-1", sessionName: "worker-a", status: "running", activeSessionId: childActive, model: "p/kid-model" }] : [] } };
    case "cancel_rlm_child":
      return cancelError ? { error: cancelError } : { data: { cancelled: true } };
    case "send_message":
    case "set_thinking_level":
    case "retry_worker":
    case "detach":
      return { data: null };
    default:
      return { error: `unhandled ${cmd.type}` }; // compaction and the like: the driver tolerates it
  }
}

const server = net.createServer((sock) => {
  client = sock;
  sock.on("error", () => {});
  sock.write(JSON.stringify(hello) + "\n");
  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const env = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      seen.push(env.command);
      const { data, error } = answer(env.command);
      sock.write(JSON.stringify({ id: env.id, type: "response", command: env.command.type, success: !error, ...(error ? { error } : { data }) }) + "\n");
    }
  });
});
const push = (activeSessionId: string, event: unknown) => client!.write(JSON.stringify({ type: "session_event", activeSessionId, event, meta: { sequence: 1 } }) + "\n");

let driver: PrimeDriver;
let parent: PrimeAgentHandle;
before(async () => {
  const socketPath = join(dir, "d.sock");
  await new Promise<void>((r) => server.listen(socketPath, r));
  driver = await createDriver(undefined, { socketPath, agentDir: join(dir, "agent"), env: { PATH: "/usr/bin:/bin", HOME: dir } });
  const { primeSessionId } = await driver.createSession({ cwd: "/work", model: { provider: "p", modelId: "m" } });
  parent = driver.agent(primeSessionId);
});
after(async () => {
  await driver.close();
  client?.destroy();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("openChild attaches the child's own session once, with its transcript and settings", async () => {
  assert.deepEqual(parent.children().map((c) => [c.id, c.agentId, c.status]), [["child-1", 1000, "running"]]);
  const child = await parent.openChild("child-1");
  assert.equal(child, await parent.openChild("child-1"));
  assert.deepEqual(cmds("attach").map((c) => c.activeSessionId), ["A1", "C1"]);
  assert.deepEqual(child.snapshot().entries.map((e) => (e.model![0] as { content?: unknown }).content), [[{ type: "text", text: "child task" }]]);
  assert.deepEqual(child.config(), { model: { provider: "p", modelId: "kid-model" }, thinkingLevel: "medium", cwd: "/work", readOnly: false });
  assert.equal(parent.snapshot().entries.length, 1, "the parent's transcript is its own");
  await assert.rejects(parent.openChild("nope"), (e: ApiFault) => e.code === "invalid" && /no live session for child nope/.test(e.message));
});

test("a child's events stream through its own translator, and only to it", async () => {
  const child = await parent.openChild("child-1");
  const got: WireAgentEvent[] = [];
  const main: WireAgentEvent[] = [];
  child.subscribe((e) => got.push(...e));
  parent.subscribe((e) => main.push(...e));
  push("C1", { type: "agent_start" });
  push("C1", { type: "message_start", message: assistant("") });
  push("C1", { type: "message_end", message: assistant("child reply") });
  push("C1", { type: "agent_end" });
  await until(() => got.some((e) => e.type === "run_end"), 2000, "child run_end");
  assert.deepEqual(got.map((e) => e.type), ["run_start", "message_start", "message_end", "usage_changed", "run_end"]);
  assert.equal(child.snapshot().entries.length, 2);
  assert.equal(parent.snapshot().entries.length, 1);
  assert.deepEqual(main, []);
  assert.equal(child.busy(), false);
});

test("send is send_message from the parent session, not a prompt to the child", async () => {
  const child = await parent.openChild("child-1");
  const before = seen.length;
  const { submissionId } = await child.send("also check the tests", "steer");
  assert.ok(submissionId > 0);
  assert.deepEqual(seen.slice(before), [{ type: "send_message", targetActiveSessionId: "C1", message: "also check the tests", fromActiveSessionId: "A1" }]);
});

test("abort is cancel_rlm_child on the parent; Prime's refusal is a 400", async () => {
  const child = await parent.openChild("child-1");
  await child.abort();
  assert.deepEqual(cmds("cancel_rlm_child"), [{ type: "cancel_rlm_child", activeSessionId: "A1", childId: "child-1" }]);
  assert.equal(cmds("abort").length, 0);
  cancelError = "Child is not running";
  await assert.rejects(child.abort(), (e: ApiFault) => e.code === "invalid" && /not running/.test(e.message));
  cancelError = undefined;
});

test("thinking level goes to the child's session and shows in its snapshot; the model is refused", async () => {
  const child = await parent.openChild("child-1");
  const got: WireAgentEvent[] = [];
  child.subscribe((e) => got.push(...e));
  assert.equal((await child.setConfig({ thinkingLevel: "high" })).thinkingLevel, "high");
  assert.deepEqual(cmds("set_thinking_level"), [{ type: "set_thinking_level", activeSessionId: "C1", level: "high" }]);
  assert.deepEqual(got.map((e) => e.type), ["agent_changed"]);
  assert.equal(child.snapshot().agent.thinkingLevel, "high");
  assert.equal(parent.config().thinkingLevel, "low");
  await assert.rejects(child.setConfig({ model: { provider: "p", modelId: "m" } }), (e: ApiFault) => e.code === "invalid" && /keeps the model/.test(e.message));
  assert.equal(cmds("set_model").length, 0);
});

test("retry_worker goes to the session it is called on", async () => {
  await parent.retryWorker();
  await (await parent.openChild("child-1")).retryWorker();
  assert.deepEqual(cmds("retry_worker").map((c) => c.activeSessionId), ["A1", "C1"]);
});

test("when the roster gives the child a new active session, the next openChild re-attaches and detaches the old one", async () => {
  const old = await parent.openChild("child-1");
  childActive = "C2";
  push("A1", { type: "rlm_child_update", child: { id: "child-1", activeSessionId: "C2" } });
  await until(async () => (await parent.openChild("child-1")) !== old, 2000, "re-attach");
  assert.deepEqual(cmds("attach").map((c) => c.activeSessionId), ["A1", "C1", "C2"]);
  await until(() => cmds("detach").some((c) => c.activeSessionId === "C1"), 2000, "detach of C1");
  push("C1", { type: "agent_start" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(old.busy(), false, "the old session no longer receives events");
});
