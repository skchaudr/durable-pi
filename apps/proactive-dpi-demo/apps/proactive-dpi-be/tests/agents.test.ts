// The remote runner against a stub dpi API: dpi gets instructions and the add-on, Prime gets instructions in the message.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { Incident } from "../../../shared/types.ts";
import { remoteRunner } from "../src/agents.ts";

let unanswered = false;
const seen: { method: string; url: string; body: any; key?: string }[] = [];
const server = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  seen.push({ method: req.method!, url: req.url!, body: text ? JSON.parse(text) : undefined, key: req.headers["idempotency-key"] as string });
  res.setHeader("content-type", "application/json");
  if (req.url === "/v1/device")
    res.end(JSON.stringify({ models: [{ provider: "cliproxy", id: "gpt-6.1-sol" }], defaultModel: "gpt-6.1-sol" }));
  else if (req.url === "/v1/sessions") res.end(JSON.stringify({ id: "sess-1", agents: [{ id: 1 }] }));
  else if (unanswered && req.url?.endsWith("/messages")) res.end(JSON.stringify({ submissionId: 1, status: "unanswered", reason: "model_error" }));
  else res.end(JSON.stringify({ submissionId: 1, status: "queued" }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const remote = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: () => "tok" };
const incident = { id: "INC-0001", title: "boom", openedAt: 5, worktree: "/w", branch: "incident/inc-0001" } as Incident;

for (const backend of ["dpi", "prime"] as const) {
  test(`${backend}: start makes one session, delivers instructions its own way, and a restart does not make another`, async () => {
    seen.length = 0;
    const runner = remoteRunner(backend, remote);
    let saved: unknown;
    const notes: string[] = [];
    const hooks = { save: async (r: unknown) => void (saved = r), note: async (t: string) => void notes.push(t) } as never;
    await runner.start(incident, "BRIEF", hooks);
    // The default --model (claude-sonnet-5-5-high) is not in this device's list, so the device default runs, and the timeline says so.
    assert.equal(notes.length, 1);
    assert.match(notes[0], new RegExp(`${backend}: gpt-6.1-sol \\(the requested claude-sonnet-5-5-high is not listed there\\)`));
    assert.deepEqual(saved, { backend, sessionId: "sess-1", agentId: "1" });
    const session = seen.find((r) => r.url === "/v1/sessions")!;
    assert.deepEqual([session.key, session.body.cwd, session.body.model], ["incident:INC-0001:5:session", "/w", { provider: "cliproxy", modelId: "gpt-6.1-sol" }]);
    const message = seen.find((r) => r.url.endsWith("/messages"))!;
    assert.equal(message.body.requestId, "incident:INC-0001:brief");
    const configured = seen.some((r) => r.url.endsWith("/config") && /incident_id is INC-0001/.test(r.body.instructions));
    const addon = seen.some((r) => r.url.endsWith("/extensions") && r.body.name === "incident-ops" && r.body.enabled);
    if (backend === "dpi") {
      assert.ok(configured && addon);
      assert.equal(message.body.content, "BRIEF");
    } else {
      assert.ok(!configured && !addon, "Prime refuses instructions and takes tools from settings.json");
      assert.match(message.body.content, /^You are an incident agent[\s\S]*mcp\.call_tool[\s\S]*incident_id is INC-0001[\s\S]*BRIEF$/);
    }
    seen.length = 0;
    await runner.start({ ...incident, remote: saved as Incident["remote"] }, "BRIEF", { ...hooks, save: async () => assert.fail("no second session") } as never);
    assert.ok(!seen.some((r) => r.url === "/v1/sessions"));
    await runner.tell!({ ...incident, remote: saved as Incident["remote"] }, "deploy:1:decision", "approved");
    assert.deepEqual(seen.at(-1)!.body, { content: "approved", whenBusy: "followUp", requestId: "deploy:1:decision" });
  });
}

test("an agent that cannot run (the backend answers 'unanswered') makes start reject with the reason", async () => {
  unanswered = true;
  try {
    const hooks = { save: async () => {}, note: async () => {} };
    await assert.rejects(remoteRunner("dpi", remote).start({ ...incident, openedAt: 6 }, "BRIEF", hooks), /dpi agent could not run the brief: model_error/);
  } finally {
    unanswered = false;
  }
});

test.after(() => server.close());
