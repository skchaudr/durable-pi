// What a remote agent is owed is derived from committed state; the Notifier delivers it with a fake runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Deploy, Incident } from "../../../shared/types.ts";
import { Notifier, decisionMessage, owedMessages, type AgentRunner } from "../src/agents.ts";

const remote = { backend: "dpi", sessionId: "s", agentId: "1" } as const;
const incident = (over: Partial<Incident> = {}) => ({ id: "INC-0001", status: "ready_for_review", summary: "rev is live", remote, ...over }) as Incident;
const deploy = (over: Partial<Deploy> = {}) => ({ id: 7, incidentId: "INC-0001", commit: "abc", status: "awaiting_approval", note: null, decidedAt: null, ...over }) as Deploy;
const fakeRunner = (failures = 0) => {
  const sent: [string, string][] = [];
  let left = failures;
  const runner: AgentRunner = {
    start: async () => {},
    tell: async (_i, requestId, text) => {
      if (left-- > 0) throw Error("backend down");
      sent.push([requestId, text]);
    },
  };
  return { runner, sent };
};
const notifier = (runner: AgentRunner, state: { incidents: Incident[]; deploys: Deploy[] }, gaveUp: string[] = []) =>
  new Notifier(runner, async () => state, async (_i, id) => void gaveUp.push(id), () => 0);

test("owed messages come from committed state: nothing before a decision or without a remote agent", () => {
  assert.deepEqual(owedMessages([incident()], [deploy()]), []);
  assert.deepEqual(owedMessages([incident({ remote: undefined })], [deploy({ status: "declined", decidedAt: 1 })]), []);
  const owed = owedMessages([incident({ status: "deployed" })], [deploy({ status: "deployed", decidedAt: 1, note: "ok" })]);
  assert.deepEqual(owed.map((o) => o.requestId), ["deploy:7:decision", "deploy:INC-0001:live"]);
  assert.equal(owed[0].text, decisionMessage(deploy({ status: "deployed", decidedAt: 1, note: "ok" })));
  assert.match(decisionMessage(deploy({ status: "declined", note: "no" })), /declined by the on-call engineer: no/);
});

test("ops dies after committing the decision and before telling: a new instance's reconcile sends it once", async () => {
  const state = { incidents: [incident()], deploys: [deploy({ status: "deploying", decidedAt: 1 })] };
  const { runner, sent } = fakeRunner();
  const restarted = notifier(runner, state); // the old instance never sent anything
  await restarted.reconcile();
  await restarted.reconcile();
  assert.deepEqual(sent.map(([id]) => id), ["deploy:7:decision"]);
});

test("a send that fails twice is retried until it lands, without giving up", async () => {
  const state = { incidents: [incident({ status: "deployed" })], deploys: [deploy({ status: "deployed", decidedAt: 1 })] };
  const { runner, sent } = fakeRunner(2);
  const gaveUp: string[] = [];
  const n = notifier(runner, state, gaveUp);
  for (let i = 0; i < 4; i++) await n.reconcile();
  assert.deepEqual(sent.map(([id]) => id), ["deploy:7:decision", "deploy:INC-0001:live"]);
  assert.deepEqual(gaveUp, []);
});

test("after the quick tries fail the incident is told once, and the send still lands when the backend returns", async () => {
  const state = { incidents: [incident()], deploys: [deploy({ status: "declined", decidedAt: 1 })] };
  const { runner, sent } = fakeRunner(5);
  const gaveUp: string[] = [];
  const n = notifier(runner, state, gaveUp);
  for (let i = 0; i < 8; i++) await n.reconcile();
  assert.deepEqual(gaveUp, ["deploy:7:decision"]);
  assert.deepEqual(sent.map(([id]) => id), ["deploy:7:decision"]);
});

test("backoff holds a failed send back until its time, and a delivered message is never sent twice", async () => {
  const state = { incidents: [incident()], deploys: [deploy({ status: "declined", decidedAt: 1 })] };
  const { runner, sent } = fakeRunner(1);
  let clock = 0;
  const n = new Notifier(runner, async () => state, async () => {}, () => 1000);
  await n.reconcile(() => clock); // fails, next try at 1000
  await n.reconcile(() => (clock = 500)); // too early
  assert.equal(sent.length, 0);
  await n.reconcile(() => (clock = 1000));
  await n.reconcile(() => (clock = 5000));
  assert.equal(sent.length, 1);
});
