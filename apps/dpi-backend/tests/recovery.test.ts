import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("SIGKILL restart resumes a durable job from its checkpoint with no client attached", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Crash recovery", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "change-watch", input: { checks: 4, interval_seconds: 2 } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => ((await run())?.phases[1].progress?.done ?? 0) >= 1, 15000, "first check");
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await run())?.status === "completed", 30000, "completion after SIGKILL");
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done"]);
    assert.equal(done.phases[1].steps.filter((s) => s.kind === "checkpoint" && s.status === "done").length, 4);
    const history = await main.entries({ scope: "all" });
    assert.equal(history.items.filter((e) => e.kind === "demo.job").length, 1);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("SIGKILL mid-script: a codemode script resumes after restart; finished calls are not re-run, the in-flight bash call resolves as interrupted and the result names it", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Code crash", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    await main.setExtension({ name: "codemode", enabled: true });
    // Five sequential bash calls, each ~1.2 s; each appends one line to a marker file before it sleeps. bash is
    // replay-unsafe, so the call in flight at the kill settles as interrupted. No try/catch: the host prelude resolves
    // that call as { interrupted: true } and the script goes on.
    const code = `
      const out = [];
      for (let i = 1; i <= 5; i++) {
        const r = await tools.bash({ command: "echo step" + i + " >> marks.txt; sleep 1.2; echo ok" + i });
        out.push(r.interrupted ? "INT" + i : r.output.trim());
      }
      return out.join(",");
    `;
    const sent = await main.send(`code:${code}`);
    const submissionId = sent.submissionId as number;
    const { readFile } = await import("node:fs/promises");
    const lines = async () => (await readFile(join(t.work, "marks.txt"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
    await until(async () => (await lines()).length >= 2, 15000, "two steps started");
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await client.session(s.id).submission(submissionId)).status === "done", 40000, "script completion after SIGKILL");
    // Every step's marker appears exactly once: finished calls were not re-run, the interrupted one was not retried.
    assert.deepEqual(await lines(), ["step1", "step2", "step3", "step4", "step5"]);
    const history = await main.entries({ scope: "all" });
    const results = history.items.filter((e) => e.kind === "pi.tool-result");
    assert.equal(results.length, 1, "one tool result: the script's");
    const text = JSON.stringify(results[0]);
    assert.match(text, /ok1,INT2,ok3,ok4,ok5/);
    assert.match(text, /Script completed/);
    // The trailer names the interrupted call for the agent, even though the script swallowed the value.
    assert.match(
      text,
      /1 call\(s\) were interrupted by a restart and resolved as \{ interrupted: true \}; they may have partially run and were not re-run: c2 bash \{\\"command\\":\\"echo step2/,
    );
    const details = JSON.stringify((results[0] as unknown as { model: { details?: unknown }[] }).model[0].details);
    assert.match(details, /"id":2,"name":"bash".*"status":"error".*was interrupted/);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
