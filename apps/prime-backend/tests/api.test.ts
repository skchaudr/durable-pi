import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, newSession, until } from "./helpers.js";
import { FakeDriver } from "../src/fake-driver.js";

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
      ["POST", `${base}/agents/main/fork`, { entryId: 1 }],
      ["POST", `${base}/agents/main/compact`, {}],
      ["POST", `${base}/agents/main/reset`, {}],
      ["PATCH", `${base}/compaction`, { reserveTokens: 2048 }],
      ["GET", `${base}/compaction`, undefined],
      ["POST", `${base}/agents/main/demo/state`, {}],
      ["POST", `${base}/agents/main/demo/jobs/3/approval`, {}],
      ["DELETE", `${base}/agents/main/inbox/1`, undefined],
      ["GET", `${base}/submissions/1`, undefined],
      ["POST", `${base}/agents`, {}],
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
