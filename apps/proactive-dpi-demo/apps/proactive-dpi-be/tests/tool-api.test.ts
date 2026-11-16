import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { NotFound } from "../src/extensions.ts";
import { mountReadApi, mountToolApi, type ToolHost } from "../src/tool-api.ts";

const TOKEN = "t".repeat(32);
const calls: unknown[][] = [];
const host: ToolHost = {
  async callTool(name, incidentId, args) {
    calls.push([name, incidentId, args]);
    if (name === "nope") throw new NotFound("Unknown tool nope");
    if (name === "bad") throw Error("bad arguments");
    return name === "deploy" ? { status: "awaiting_approval", deployId: 7 } : { text: `ran ${name}` };
  },
  toolInfo: () => [{ name: "deploy", description: "d", inputSchema: { type: "object" } }],
};
const app = express();
app.use(express.json());
mountToolApi(app, host, TOKEN);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const post = (path: string, body: unknown, token: string | null = TOKEN) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

test("tool API: no token, a wrong token and a near-miss token are refused before any tool runs", async () => {
  calls.length = 0;
  for (const token of [null, "x", TOKEN.slice(0, -1) + "u", TOKEN + "t"]) {
    assert.equal((await post("/api/tools/query_logs", { incidentId: "INC-0001", args: {} }, token)).status, 401);
    assert.equal((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, token)).status, 401);
  }
  assert.equal(calls.length, 0);
});

test("tool API: runs a tool for the named incident; unknown tool 404, tool error 400, missing incident 400", async () => {
  const ok = await post("/api/tools/query_logs", { incidentId: "INC-0001", args: { limit: 2 } });
  assert.deepEqual([ok.status, await ok.json()], [200, { text: "ran query_logs" }]);
  assert.deepEqual(calls.at(-1), ["query_logs", "INC-0001", { limit: 2 }]);
  assert.equal((await post("/api/tools/nope", { incidentId: "INC-0001" })).status, 404);
  const bad = await post("/api/tools/bad", { incidentId: "INC-0001" });
  assert.deepEqual([bad.status, await bad.json()], [400, { error: "bad arguments" }]);
  assert.equal((await post("/api/tools/deploy", {})).status, 400);
});

test("MCP: initialize, tools/list and tools/call (incident_id in the arguments); errors come back as isError", async () => {
  const rpc = async (method: string, params?: unknown) => (await (await post("/mcp", { jsonrpc: "2.0", id: 1, method, params })).json()).result;
  assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).protocolVersion, "2025-06-18");
  assert.equal((await rpc("tools/list")).tools[0].name, "deploy");
  const r = await rpc("tools/call", { name: "deploy", arguments: { incident_id: "INC-0001", summary: "s" } });
  assert.deepEqual(JSON.parse(r.content[0].text), { status: "awaiting_approval", deployId: 7 });
  assert.deepEqual(calls.at(-1), ["deploy", "INC-0001", { summary: "s" }]);
  const e = await rpc("tools/call", { name: "bad", arguments: { incident_id: "INC-0001" } });
  assert.deepEqual([e.isError, e.content[0].text], [true, "bad arguments"]);
  assert.equal((await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
});

test.after(() => server.close());

test("read API: GET /api/incidents and GET /api/deploys list every row, including where the agent runs", async () => {
  const remote = { backend: "dpi", sessionId: "s1", agentId: "0" };
  const read = express();
  mountReadApi(read, {
    incidents: async () => [{ id: "INC-0001", remote }],
    deploys: async () => [{ id: 3, incidentId: "INC-0001", status: "awaiting_approval", commit: "abc", summary: "s", branch: "b", diffStat: "d", decidedAt: null, remote }],
  });
  const s = read.listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  const url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    assert.deepEqual((await (await fetch(`${url}/api/incidents`)).json())[0].remote, remote);
    const [d] = await (await fetch(`${url}/api/deploys`)).json();
    assert.deepEqual([d.id, d.status, d.remote], [3, "awaiting_approval", remote]);
  } finally {
    s.close();
  }
});
