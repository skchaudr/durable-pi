// The remote deploy tool must not block: it files the request and returns at once, and asking again returns the same one.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness, configure, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Incident } from "../../../shared/types.ts";
import { recordNote } from "../src/agents.ts";
import { opsToolToken } from "../src/config.ts";
import { Deploys, Incidents, createExtensions } from "../src/extensions.ts";

const store = { requestDeploy() {}, cancelDeploy() {}, deployed: () => undefined } as never;
const announced: boolean[] = [];
const ext = createExtensions({ store, incidentChanged: (_i, announce) => announced.push(announce) });
const registry = createRegistry();
registry.install(ext.IncidentAgent);
const harness = await Harness.open(
  await openNodeSqliteStorage(join(mkdtempSync(join(tmpdir(), "ops-deploy-")), "agent.sqlite")),
  { models: createModels(), registry },
  ctx,
);
harness.resume();

const incident = (conversationId: number): Incident => ({
  id: "INC-0001", title: "t", fingerprint: "f", service: "checkout-api", trigger: "incident", status: "ready_for_review",
  summary: "", conversationId, branch: "incident/inc-0001", worktree: "/nowhere", openedAt: 1, updatedAt: 1,
  evidence: { logIds: [], firstSeen: "", revision: "r", commit: null },
  report: { rootCause: "rc", fix: "fx", tests: "t", commit: "abc1234", diffStat: "1 file", deployedRevision: null },
  timeline: [], announced: { opened: true, ready: false },
});
await harness.commit(async (tx) => {
  const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
  await configure(tx, c.id, { extensions: [ext.IncidentAgent], cwd: "/" });
  (await tx.doc(Incidents)).items["INC-0001"] = incident(Number(c.id));
}, ctx);
const call = (name: string, incidentId: string, args: unknown) => ext.callTool(harness, ctx, name, incidentId, args);
const deploys = async () => Object.values((await harness.snapshot(Deploys, ctx))?.items ?? {});

test("remote deploy returns awaiting_approval at once and a repeat finds the same request", async () => {
  const started = Date.now();
  const first = (await call("deploy", "INC-0001", { summary: "ships the fix" })) as { status: string; deployId: number };
  assert.ok(Date.now() - started < 3000, "deploy must not wait for the engineer");
  assert.equal(first.status, "awaiting_approval");
  const [d] = await deploys();
  assert.deepEqual([d.id, d.status, d.commit, d.incidentId], [first.deployId, "awaiting_approval", "abc1234", "INC-0001"]);
  assert.deepEqual(announced, [true]);
  assert.equal(((await call("deploy", "INC-0001", { summary: "again" })) as { deployId: number }).deployId, first.deployId);
  assert.equal((await deploys()).length, 1);
});

test("after a decline the agent may ask again and gets a new request", async () => {
  const [first] = await deploys();
  await harness.commit(async (tx) => {
    (await tx.doc(Deploys)).items[String(first.id)].status = "declined";
  }, ctx);
  const second = (await call("deploy", "INC-0001", { summary: "retry" })) as { deployId: number };
  assert.notEqual(second.deployId, first.id);
});

test("tool arguments are validated and an unknown incident or tool is refused", async () => {
  await assert.rejects(call("update_incident", "INC-0001", { status: "garbage", summary: "s" }));
  await assert.rejects(call("deploy", "INC-9999", { summary: "s" }), /does not own/);
  await assert.rejects(call("rm_rf", "INC-0001", {}), /Unknown tool/);
  await assert.rejects(call("toString", "INC-0001", {}), /Unknown tool/);
});

test("a failed agent start blocks the incident and lands on its timeline; a note only adds a line", async () => {
  const noted = await recordNote(harness, "INC-0001", "Agent model on dpi: x", false);
  assert.deepEqual([noted.status, noted.timeline.at(-1)?.summary], ["ready_for_review", "Agent model on dpi: x"]);
  const failed = await recordNote(harness, "INC-0001", "Agent failed to start: model_error", true);
  assert.deepEqual([failed.status, failed.summary, failed.timeline.at(-1)?.status], ["blocked", "Agent failed to start: model_error", "blocked"]);
  assert.equal((await harness.snapshot(Incidents, ctx))?.items["INC-0001"].status, "blocked");
});

test("remote agent backends refuse to start without OPS_TOOL_TOKEN; inproc warns and still gets a token", () => {
  assert.equal(opsToolToken("abc", "dpi"), "abc");
  assert.throws(() => opsToolToken(undefined, "dpi"), /--agent-backend dpi needs OPS_TOOL_TOKEN/);
  assert.throws(() => opsToolToken("", "prime"), /needs OPS_TOOL_TOKEN/);
  assert.match(opsToolToken(undefined, "inproc"), /^[0-9a-f]{48}$/);
});

test.after(() => harness.close(ctx));
