import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { DaemonClient, PrimeError } from "../src/prime/client.js";

const dir = mkdtempSync("/tmp/pbc-");
after(() => rmSync(dir, { recursive: true, force: true }));
const hello = { type: "daemon_hello", protocol: { name: "prime-agent.daemon", version: 7 }, serverCapabilities: [] };

/** A fake supervisor: hello on connect, then `handler` sees each command envelope. */
function fakeDaemon(path: string, handler: (cmd: any, env: any, sock: net.Socket) => void) {
  const socks = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => {});
    sock.write(JSON.stringify(hello) + "\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const env = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        handler(env.command, env, sock);
      }
    });
  });
  return {
    listen: () => new Promise<void>((r) => server.listen(path, r)),
    stop: () => new Promise<void>((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
  };
}
const respond = (sock: net.Socket, env: any, extra: object) => sock.write(JSON.stringify({ id: env.id, type: "response", command: env.command.type, success: true, ...extra }) + "\n");

test("envelope shape, out-of-order responses and errors correlate by id", async () => {
  const path = join(dir, "a.sock");
  const seen: any[] = [];
  const held: [any, net.Socket][] = [];
  const d = fakeDaemon(path, (cmd, env, sock) => {
    seen.push(env);
    if (cmd.type === "slow") return void held.push([env, sock]);
    if (cmd.type === "bad") return void sock.write(JSON.stringify({ id: env.id, type: "response", command: "bad", success: false, error: "nope", errorInfo: { code: "worker_overloaded" } }) + "\n");
    respond(sock, env, { data: { echo: cmd.type } });
    if (cmd.type === "fast") for (const [e, s] of held) respond(s, e, { data: { echo: "slow" } });
  });
  await d.listen();
  const c = new DaemonClient(path);
  await c.connect();
  const slow = c.request({ type: "slow" });
  assert.deepEqual(await c.request({ type: "fast" }), { echo: "fast" });
  assert.deepEqual(await slow, { echo: "slow" });
  await assert.rejects(c.request({ type: "bad" }), (e: PrimeError) => e.message === "nope" && e.code === "worker_overloaded" && !e.transport);
  assert.deepEqual(seen[0].protocol, { name: "prime-agent.daemon", version: 7 });
  assert.equal(seen[0].type, "command");
  assert.match(seen[0].clientId, /^prime-backend:/);
  c.close();
  await d.stop();
});

test("event frames split across chunks, multibyte included", async () => {
  const path = join(dir, "b.sock");
  let sock!: net.Socket;
  const d = fakeDaemon(path, (_c, env, s) => ((sock = s), respond(s, env, {})));
  await d.listen();
  const c = new DaemonClient(path);
  await c.connect();
  const events: any[] = [];
  const frames: any[] = [];
  c.on("session_event", (f) => events.push(f));
  c.on("frame", (f) => frames.push(f));
  await c.request({ type: "list" });
  const line = Buffer.from(JSON.stringify({ type: "session_event", activeSessionId: "s1", event: { type: "message_update", text: "héllo ✓" }, meta: { sequence: 3 } }) + "\n" + JSON.stringify({ type: "session_binding", previousActiveSessionId: "s1", activeSessionId: "s2" }) + "\n");
  const cut = line.indexOf(Buffer.from("é")) + 1; // inside the 2-byte character
  sock.write(line.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 20));
  sock.write(line.subarray(cut));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(events[0].event.text, "héllo ✓");
  assert.equal(events[0].meta.sequence, 3);
  assert.equal(frames[0].type, "session_binding");
  c.close();
  await d.stop();
});

test("reconnects after the supervisor restarts; in-flight requests fail, new ones wait for the socket", async () => {
  const path = join(dir, "c.sock");
  const handler = (cmd: any, env: any, sock: net.Socket) => cmd.type !== "hang" && respond(sock, env, { data: { ok: true } });
  let d = fakeDaemon(path, handler);
  await d.listen();
  const c = new DaemonClient(path, { backoffMs: [20, 40] });
  after(() => c.close());
  const connected: boolean[] = [];
  c.on("connected", (_h, reconnect) => connected.push(reconnect));
  await c.connect();
  const inflight = assert.rejects(c.request({ type: "hang" }), (e: PrimeError) => e.transport);
  await d.stop();
  await inflight;
  const during = c.request({ type: "list" }, 5000); // issued while the socket is down
  await new Promise((r) => setTimeout(r, 150));
  d = fakeDaemon(path, handler);
  await d.listen();
  assert.deepEqual(await during, { ok: true });
  assert.deepEqual(connected, [false, true]);
  c.close();
  await d.stop();
});

test("a first connect to a missing socket throws after its attempts", async () => {
  const c = new DaemonClient(join(dir, "none.sock"), { backoffMs: [5] });
  await assert.rejects(c.connect(2));
});
