import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, newSession, until } from "./helpers.js";
import { FakeDriver } from "../src/fake-driver.js";
import type { Frame } from "../../dpi-sdk/src/api.js";

test("auth: /healthz is open, /v1 needs the token (Bearer or X-DPI-Token)", async () => {
  const b = await boot();
  try {
    assert.equal((await fetch(`${b.base}/healthz`)).status, 200);
    const anon = await fetch(`${b.base}/v1/device`);
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get("www-authenticate"), 'Bearer realm="dpi"');
    assert.deepEqual(await anon.json(), { error: { code: "unauthorized", message: "Missing or invalid device token" } });
    assert.equal((await fetch(`${b.base}/v1/device`, { headers: { authorization: "Bearer nope" } })).status, 401);
    assert.equal((await fetch(`${b.base}/v1/device`, { headers: { "x-dpi-token": b.token } })).status, 200);
    assert.equal((await fetch(`${b.base}/v1/nothing`, { headers: { authorization: `Bearer ${b.token}` } })).status, 404);
  } finally {
    await b.stop();
    await b.cleanup();
  }
});

test("GET /v1/device passes the hub monitor checks and uid survives a restart", async () => {
  const b = await boot();
  const info = await b.client.device();
  // hub/monitor.ts: apiVersion must be 1; uid is compared and sliced; FE DeviceIcon reads platform.
  assert.equal(info.apiVersion, 1);
  assert.equal(typeof info.uid, "string");
  assert.ok(info.uid.length >= 8);
  assert.equal(info.name, "test-prime");
  assert.equal(typeof info.platform, "string");
  assert.equal(typeof info.hostname, "string");
  assert.deepEqual(info.capabilities, ["events"]);
  assert.equal(info.jobs, undefined);
  assert.ok(info.models.length > 0);
  assert.ok(info.models.some((m) => m.id === info.defaultModel));
  assert.deepEqual(info.startDirs, [b.work]);
  assert.equal((await b.client.tree()).uid, info.uid);
  await b.stop();
  const again = await boot({ dir: b.dir, token: b.token });
  try {
    assert.equal((await again.client.device()).uid, info.uid);
  } finally {
    await again.stop();
    await again.cleanup();
  }
});

test("sessions: create, idempotency, lookup by name, rename, archive, validation", async () => {
  const b = await boot();
  try {
    const first = await b.call(
      "POST",
      "/v1/sessions",
      { name: "Work One", cwd: b.work, model: { provider: "fake", modelId: "echo" } },
      { "idempotency-key": "k1" },
    );
    assert.equal(first.status, 201);
    const s = first.body;
    assert.match(s.id, /^[0-9a-f-]{36}$/);
    assert.equal(s.name, "Work One");
    assert.equal(s.cwd, b.work);
    assert.equal(s.model, "echo");
    assert.equal(s.busy, false);
    assert.equal(typeof s.createdAt, "number");
    assert.equal(typeof s.dbPath, "string");
    assert.deepEqual(s.agents, [{ id: 1, name: "Main", named: false, kind: "root", busy: false, background: 0 }]);

    const replay = await b.call(
      "POST",
      "/v1/sessions",
      { name: "Work One", cwd: b.work, model: { provider: "fake", modelId: "echo" } },
      { "idempotency-key": "k1" },
    );
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    assert.equal(replay.body.id, s.id);
    const other = await b.call("POST", "/v1/sessions/" + s.id + "/agents", {}, { "idempotency-key": "k1" });
    assert.equal(other.status, 400);
    assert.equal(other.body.error.code, "invalid");

    assert.equal((await b.call("GET", "/v1/sessions/work%20one")).body.id, s.id);
    assert.equal((await b.call("GET", "/v1/sessions")).body.length, 1);
    assert.equal((await b.call("PATCH", `/v1/sessions/${s.id}`, { name: "Renamed" })).body.name, "Renamed");
    assert.equal((await b.call("PATCH", `/v1/sessions/${s.id}`, { name: " " })).status, 400);
    assert.equal((await b.call("GET", "/v1/sessions/nope")).status, 404);

    assert.equal((await b.call("POST", "/v1/sessions", { cwd: b.work, model: { provider: "fake", modelId: "echo" } })).status, 400);
    assert.equal((await b.call("POST", "/v1/sessions", { name: "x", cwd: "/definitely/not/here", model: { provider: "fake", modelId: "echo" } })).status, 400);
    const badModel = await b.call("POST", "/v1/sessions", { name: "x", cwd: b.work, model: { provider: "fake", modelId: "nope" } });
    assert.equal(badModel.status, 400);
    assert.equal(badModel.body.error.code, "invalid");

    const dup = await newSession(b, "renamed");
    assert.equal((await b.call("GET", "/v1/sessions/renamed")).status, 409);
    assert.equal((await b.call("GET", `/v1/sessions/${dup.id}`)).status, 200);

    assert.deepEqual(Object.keys((await b.call("DELETE", `/v1/sessions/${s.id}`)).body), ["archived"]);
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}`)).status, 404);
    assert.equal((await b.client.tree()).sessions.length, 1);

    const listed = (await b.call("GET", "/v1/archived")).body;
    assert.deepEqual(listed.map((a: { id: string }) => a.id), [s.id]);
    assert.equal(typeof listed[0].archivedAt, "number");
    assert.equal((await b.call("POST", `/v1/archived/${dup.id}/restore`)).status, 404);
    const restored = await b.call("POST", `/v1/archived/${s.id}/restore`);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.id, s.id);
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}`)).status, 200);
    assert.deepEqual((await b.call("GET", "/v1/archived")).body, []);
    assert.equal((await b.call("POST", `/v1/archived/${s.id}/restore`)).status, 404);
  } finally {
    await b.stop();
    await b.cleanup();
  }
});

test("restart: sessions reopen through driver.openSession", async () => {
  const b = await boot();
  const s = await newSession(b);
  const primeId = [...b.driver.agents.keys()][0];
  await b.stop();
  const driver = new FakeDriver();
  const again = await boot({ dir: b.dir, token: b.token, driver });
  try {
    assert.deepEqual(driver.opened.map((o) => o.primeSessionId), [primeId]);
    const tree = await again.client.tree();
    assert.equal(tree.sessions[0].id, s.id);
    assert.equal(tree.sessions[0].agents.length, 1);
  } finally {
    await again.stop();
    await again.cleanup();
  }
});

test("agents: addressing, detail, config, entries, transcript, benign and unsupported routes", async () => {
  const b = await boot();
  try {
    const s = await newSession(b);
    const base = `/v1/sessions/${s.id}`;
    for (const ref of ["main", "1", "Main"]) assert.equal((await b.call("GET", `${base}/agents/${ref}`)).status, 200);
    assert.equal((await b.call("GET", `${base}/agents/2`)).status, 404);
    assert.equal((await b.call("GET", `${base}/agents`)).body[0].id, 1);

    const detail = (await b.call("GET", `${base}/agents/main`)).body;
    assert.equal(detail.sessionId, s.id);
    assert.deepEqual(detail.tools, []);
    assert.deepEqual(detail.config.model, { provider: "fake", modelId: "echo" });

    assert.equal((await b.call("PATCH", `${base}/agents/main/config`, { thinkingLevel: "high" })).body.thinkingLevel, "high");
    assert.equal((await b.call("GET", `${base}/agents/main/config`)).body.thinkingLevel, "high");
    assert.equal((await b.call("PATCH", `${base}/agents/main/config`, { thinkingLevel: "wild" })).status, 400);
    assert.equal((await b.call("PATCH", `${base}/agents/main/config`, { model: { provider: "fake", modelId: "zzz" } })).status, 400);

    // benign answers the FE needs
    assert.deepEqual((await b.call("GET", `${base}/agents/main/extensions`)).body, { extensions: [], builtIn: [] });
    assert.deepEqual((await b.call("GET", `${base}/tasks?status=terminal&limit=40`)).body, []);
    assert.deepEqual((await b.call("GET", `${base}/tasks?status=live`)).body, []);
    assert.equal((await b.call("GET", `${base}/tasks?status=x`)).status, 400);
    assert.deepEqual((await b.call("GET", `${base}/inspect`)).body, {});

    // extensions and tasks go to the driver; the fake one has none
    const patchExt = await b.call("PATCH", `${base}/agents/main/extensions`, { name: "x", enabled: true });
    assert.equal(patchExt.status, 400);
    assert.deepEqual((await b.call("GET", `${base}/tasks?status=live`)).body, []);
    assert.equal((await b.call("POST", `${base}/tasks/1/abort`, {})).status, 400);
    assert.equal((await b.call("POST", `${base}/tasks/x/abort`, {})).status, 400);
    // everything else
    const nope: [string, string, unknown][] = [
      ["POST", `${base}/agents/main/demo/state`, {}],
      ["POST", `${base}/agents/main/demo/jobs/3/approval`, {}],
      ["DELETE", `${base}/agents/main/inbox/1`, undefined],
      ["GET", `${base}/submissions/1`, undefined],
      ["PATCH", `${base}/agents/main`, { name: "x" }],
      ["GET", `${base}/agents/main/docs/demo.job-runs`, undefined],
    ];
    for (const [m, p, body] of nope) {
      const r = await b.call(m, p, body);
      assert.equal(r.status, 400, `${m} ${p}`);
      assert.deepEqual(r.body, { error: { code: "invalid", message: "Not supported on Prime yet" } });
    }

    // message validation
    assert.equal((await b.call("POST", `${base}/agents/main/messages`, { content: "hi" })).status, 400);
    assert.equal((await b.call("POST", `${base}/agents/main/messages`, { content: " ", requestId: "r" })).status, 400);
    assert.equal((await b.call("POST", `${base}/agents/main/messages`, { content: "hi", requestId: "r", whenBusy: "later" })).status, 400);

    // entries and transcript come from the snapshot
    await b.call("POST", `${base}/agents/main/messages`, { content: "ping", requestId: "e1" });
    await until(() => !b.driver.agent([...b.driver.agents.keys()][0]).busy() && b.driver.agent([...b.driver.agents.keys()][0]).entries.length === 4);
    const all = (await b.call("GET", `${base}/agents/main/entries?limit=3`)).body;
    assert.equal(all.items.length, 3);
    assert.ok(all.next);
    const rest = (await b.call("GET", `${base}/agents/main/entries?limit=3&cursor=${all.next}`)).body;
    assert.equal(rest.items.length, 1);
    assert.equal(rest.next, undefined);
    assert.equal((await b.call("GET", `${base}/agents/main/entries?scope=active`)).body.items.length, 4);
    const t = (await b.call("GET", `${base}/agents/main/transcript?format=json`)).body;
    assert.equal(t.format, "json");
    assert.deepEqual(t.items.map((i: { kind: string }) => i.kind), ["user", "assistant", "assistant"]);
    assert.match((await b.call("GET", `${base}/agents/main/transcript?format=markdown`)).body.text, /Echo: ping/);
  } finally {
    await b.stop();
    await b.cleanup();
  }
});

test("compact on a busy agent is 409 busy and reaches the driver no further", async () => {
  const b = await boot();
  try {
    b.driver.hold = true;
    const s = await newSession(b);
    assert.equal((await b.call("POST", `/v1/sessions/${s.id}/agents/main/messages`, { content: "one", requestId: "c1" })).status, 202);
    const agent = b.driver.agent([...b.driver.agents.keys()][0]);
    await until(() => agent.busy(), 5000, "busy");
    const r = await b.call("POST", `/v1/sessions/${s.id}/agents/main/compact`, {});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, "busy");
    assert.deepEqual(agent.compacts, []);
    await b.call("POST", `/v1/sessions/${s.id}/agents/main/abort`, {});
  } finally {
    await b.stop();
    await b.cleanup();
  }
});

test("compaction, compact and reset go to the driver; a reset moves the catalog to the new Prime session", async () => {
  const b = await boot();
  try {
    const s = await newSession(b);
    const base = `/v1/sessions/${s.id}`;
    const oldId = [...b.driver.agents.keys()][0];
    const agent = b.driver.agent(oldId);
    assert.deepEqual((await b.call("GET", `${base}/compaction`)).body, { enabled: true, reserveTokens: 16384, backgroundTokens: 0, keepRecentTokens: 20000 });
    assert.equal((await b.call("PATCH", `${base}/compaction`, { enabled: false })).body.enabled, false);
    assert.equal(agent.autoCompaction, false);
    const bad = await b.call("PATCH", `${base}/compaction`, { reserveTokens: 2048 });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, "invalid");

    assert.deepEqual((await b.call("POST", `${base}/agents/main/compact`, { instructions: " keep the plan " })).body, { taskId: 1 });
    assert.deepEqual((await b.call("POST", `${base}/agents/main/compact`, {})).body, { taskId: 2 });
    assert.deepEqual(agent.compacts, [" keep the plan ", undefined]);

    assert.equal((await b.call("POST", `${base}/agents/main/reset`, { note: "carry on" })).status, 400);
    assert.deepEqual((await b.call("POST", `${base}/agents/main/reset`, {})).body, { ok: true });
    await b.stop();
    const driver = new FakeDriver();
    const again = await boot({ dir: b.dir, token: b.token, driver });
    try {
      assert.notEqual(driver.opened[0].primeSessionId, oldId);
    } finally {
      await again.stop();
      await again.cleanup();
    }
  } finally {
    await b.cleanup();
  }
});

test("fs/dirs: start dirs, one level, not a directory", async () => {
  const b = await boot();
  try {
    const roots = (await b.call("GET", "/v1/fs/dirs")).body;
    assert.equal(roots.path, "");
    assert.equal(roots.dirs[0].path, b.work);
    const level = (await b.call("GET", `/v1/fs/dirs?path=${encodeURIComponent(b.work)}`)).body;
    assert.deepEqual(level.dirs.map((d: { name: string }) => d.name), ["project"]);
    assert.equal(level.parent, b.dir);
    assert.equal((await b.call("GET", "/v1/fs/dirs?path=/nope/nope")).status, 404);
  } finally {
    await b.stop();
    await b.cleanup();
  }
});

test("Prime child agents: subagents in the tree and agents list, read-only agent view, 400 for the rest", async () => {
  const b = await boot();
  try {
    const s = await newSession(b);
    const main = b.driver.agent([...b.driver.agents.keys()][0]);
    const frames = b.tail("/v1/events");
    await frames.waitFor((f) => f.type === "tree", "first tree");
    main.kids = [{ agentId: 1000, id: "child-1", name: "worker-a", status: "running" }];
    main.childEntries.set("child-1", [{ id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "child task", timestamp: 1 }] }]);
    main.emitChildren();
    const withKid = await frames.waitFor((f) => f.type === "tree" && f.tree.sessions[0].agents.length === 2, "tree with the child");
    const kid = (withKid as Extract<Frame, { type: "tree" }>).tree.sessions[0].agents[1];
    assert.deepEqual(kid, { id: 1000, name: "worker-a", named: false, kind: "subagent", ownerAgentId: 1, busy: true, background: 0 });
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}/agents`)).body.length, 2);
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}`)).body.busy, true);

    const detail = await b.call("GET", `/v1/sessions/${s.id}/agents/1000`);
    assert.equal(detail.status, 200);
    assert.deepEqual([detail.body.id, detail.body.kind, detail.body.sessionId], [1000, "subagent", s.id]);
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}/agents/1000/entries`)).body.items[0].model[0].content, "child task");
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}/agents/1000/entries?scope=active`)).body.items.length, 1);
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}/agents/1000/transcript`)).status, 200);
    const stream = b.tail(`/v1/sessions/${s.id}/agents/1000/events`);
    const snap = await stream.waitFor((f) => f.type === "snapshot", "child snapshot");
    assert.equal((snap as Extract<Frame, { type: "snapshot" }>).snapshot.entries.length, 1);

    for (const [method, path] of [["POST", "messages"], ["POST", "abort"], ["GET", "config"], ["PATCH", "config"], ["GET", "extensions"], ["POST", "fork"], ["PATCH", ""]]) {
      const r = await b.call(method, `/v1/sessions/${s.id}/agents/1000${path && `/${path}`}`, method === "GET" ? undefined : {});
      assert.equal(r.status, 400, `${method} ${path}`);
      assert.equal(r.body.error.code, "invalid");
      assert.match(r.body.error.message, /child agents are read-only/);
    }
    assert.equal(main.sends.length, 0);
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}/agents/9999`)).status, 404);

    // created agents take catalog ids (2, 3, ...), children 1000 and up: no clash, whichever came first
    const made = await b.call("POST", `/v1/sessions/${s.id}/agents`, { name: "side" });
    assert.equal(made.status, 201);
    assert.deepEqual((await b.call("GET", `/v1/sessions/${s.id}/agents`)).body.map((a: { id: number }) => a.id), [1, 2, 1000]);
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}/agents/side`)).body.kind, "root");
    assert.equal((await b.call("GET", `/v1/sessions/${s.id}/agents/worker-a`)).body.kind, "subagent");

    main.childEntries.clear(); // Prime cannot read a child whose session is gone
    const gone = await b.call("GET", `/v1/sessions/${s.id}/agents/1000/entries`);
    assert.equal(gone.status, 400);
    assert.match(gone.body.error.message, /no live session for child child-1/);
    frames.stop();
    stream.stop();
  } finally {
    await b.stop();
    await b.cleanup();
  }
});
