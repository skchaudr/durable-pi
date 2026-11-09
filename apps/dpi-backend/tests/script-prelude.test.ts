import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import { interruptedCalls, interruptedTrailer, INTERRUPTED_CALL, isWrapped, wrapScript } from "../src/script-prelude.js";

/** pi-codemode's wrapper (runtime/vm.js): the prefix shares the script's first line. */
const asVm = (code: string) => `(async (tools, console) => {${code}\n})`;

/** The line a syntax error is reported on, compiled as the sandbox would compile it. */
function errorLine(code: string): number {
  try {
    new Script(asVm(code), { filename: "codemode.js" });
  } catch (e) {
    const match = (e as Error).stack?.match(/codemode\.js:(\d+)/);
    assert.ok(match, `a syntax error with a line: ${(e as Error).stack}`);
    return Number(match[1]);
  }
  assert.fail("expected a syntax error");
}

test("wrapScript: the prelude shares the user's first line, the epilogue follows, wrapping is idempotent", () => {
  const user = `const a = await tools.bash({ command: "ls" });\nreturn a.output;`;
  const wrapped = wrapScript(user);
  assert.ok(isWrapped(wrapped));
  assert.equal(wrapScript(wrapped), wrapped, "a second pass leaves it alone");
  const [first, ...rest] = wrapped.split("\n");
  assert.ok(first.startsWith("/*dpi-prelude*/"), first);
  assert.ok(first.endsWith(`return await (async (tools) => {const a = await tools.bash({ command: "ls" });`), first);
  assert.deepEqual(rest, ["return a.output;", "})(__dpiTools);"]);
  // Valid JavaScript inside the sandbox's own wrapper.
  new Script(asVm(wrapped));
  // Line numbers in the user's code are unchanged: the prelude adds no newline before the user's first line.
  for (const broken of [`const x = ;\nreturn 1;`, `const x = 1;\nreturn )`, `return 1;\n\n\nlet 1a = 2;`])
    assert.equal(errorLine(wrapScript(broken)), errorLine(broken), broken);
});

test("wrapScript: an @options line stays first and pi-codemode still parses it", () => {
  const user = `// @options: {"timeout_ms": 5000}\nconst r = await tools.read({ path: "x" });\nreturn r;`;
  const wrapped = wrapScript(user);
  const lines = wrapped.split("\n");
  assert.equal(lines[0], `// @options: {"timeout_ms": 5000}`);
  assert.ok(lines[1].startsWith("/*dpi-prelude*/") && lines[1].endsWith(`return await (async (tools) => {const r = await tools.read({ path: "x" });`), lines[1]);
  assert.deepEqual(lines.slice(2), ["return r;", "})(__dpiTools);"]);
  const parsed = parseCodemodeSource(wrapped);
  assert.deepEqual(parsed.options, { timeoutMs: 5000 });
  assert.ok(parsed.code.startsWith("\n/*dpi-prelude*/"), "the stripped code keeps its leading newline, as without the prelude");
  // An options line with a syntax error below it reports the same line, with and without the prelude.
  const broken = `// @options: {"timeout_ms": 5000}\nconst r = 1;\nreturn );`;
  assert.equal(errorLine(parseCodemodeSource(wrapScript(broken)).code), errorLine(parseCodemodeSource(broken).code));
  // Indented options lines count too, as in pi-codemode.
  assert.ok(wrapScript(`  // @options: {}\nreturn 1`).startsWith("  // @options: {}\n/*dpi-prelude*/"));
  // A lone options line (no code) is left for pi-codemode to reject.
  assert.equal(isWrapped(wrapScript(`// @options: {}`)), true);
});

test("the prelude resolves an interrupted rejection as a value and leaves every other outcome alone", async () => {
  // The sandbox's `tools`: a frozen object behind a guard that throws for unknown members, as pi-codemode builds it.
  const calls: string[] = [];
  const base = Object.freeze({
    bash: async (args: { command: string }) => {
      calls.push(args.command);
      if (args.command === "boom") throw new Error("Tool bash was interrupted and may have partially run");
      if (args.command === "boom2") throw new Error("Tool bash was interrupted by a restart and may have partially run");
      if (args.command === "fail") throw new Error("exit 1");
      return { output: "ok", exitCode: 0 };
    },
    read: async () => "text",
    sync: () => 42,
  });
  const tools = new Proxy(base, {
    get(o, k) {
      if (typeof k === "string" && !(k in o)) throw new TypeError(`tools.${k} does not exist.`);
      return Reflect.get(o, k);
    },
  });
  const run = new Script(asVm(wrapScript(`
    const a = await tools.bash({ command: "boom" });
    const b = await tools.bash({ command: "boom2" });
    const c = await tools.bash({ command: "echo" });
    const d = await tools.read({ path: "p" });
    const e = tools.sync();
    let f; try { await tools.bash({ command: "fail" }); } catch (err) { f = err.message; }
    let g; try { tools.nope; } catch (err) { g = err.message; }
    return { a, b, c, d, e, f, g, keys: Object.keys(tools).sort(), has: "bash" in tools };
  `))).runInThisContext();
  const result = await run(tools, console);
  assert.deepEqual(result, {
    a: { interrupted: true, output: "Tool bash was interrupted and may have partially run", error: "Tool bash was interrupted and may have partially run" },
    b: { interrupted: true, output: "Tool bash was interrupted by a restart and may have partially run", error: "Tool bash was interrupted by a restart and may have partially run" },
    c: { output: "ok", exitCode: 0 },
    d: "text",
    e: 42,
    f: "exit 1",
    g: "tools.nope does not exist.",
    keys: ["bash", "read", "sync"],
    has: true,
  });
  assert.deepEqual(calls, ["boom", "boom2", "echo", "fail"]);
});

test("interruptedCalls and the trailer pick the rows a restart interrupted", () => {
  const details = {
    calls: [
      { id: 1, name: "bash", args: '{"command":"a"}', status: "ok", durationMs: 3 },
      { id: 2, name: "bash", args: '{"command":"b"}', status: "error", error: "Tool bash was interrupted and may have partially run" },
      { id: 3, name: "read", args: '{"path":"x"}', status: "error", error: "ENOENT" },
      { id: 4, name: "ping_on_call_engineer", args: '{"summary":"s"}', status: "error", error: "Tool ping_on_call_engineer was interrupted by a restart and may have partially run" },
    ],
  };
  const rows = interruptedCalls(details);
  assert.deepEqual(rows.map((r) => r.id), [2, 4]);
  assert.equal(
    interruptedTrailer(rows),
    `\n\n2 call(s) were interrupted by a restart and resolved as { interrupted: true }; they may have partially run and were not re-run: c2 bash {"command":"b"}\nc4 ping_on_call_engineer {"summary":"s"}`,
  );
  assert.equal(interruptedTrailer([]), "");
  assert.deepEqual(interruptedCalls(undefined), []);
  assert.deepEqual(interruptedCalls({ calls: "nope" }), []);
  assert.ok(INTERRUPTED_CALL.test("Tool bash was interrupted and may have partially run"));
  assert.ok(!INTERRUPTED_CALL.test("Tool bash was aborted"));
});
