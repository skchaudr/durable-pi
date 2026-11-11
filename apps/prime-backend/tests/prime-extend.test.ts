// Unit: hand-built harness_state.json / skills / MCP JSON -> AgentExtensions. Integration: the daemon commands extend.ts uses,
// against an isolated pa-daemon supervisor (no API keys in its env; nothing is ever prompted).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ApiFault } from "../src/errors.js";
import { DaemonClient } from "../src/prime/client.js";
import { extensions, patch, tools, type ExtendContext } from "../src/prime/extend.js";

const root = mkdtempSync("/tmp/pbt-ext-");
const agentDir = join(root, "agent");
const SID = "01a1cae3-efc8-7244-9b57-1c5cf3f67bbb";
const entry = (kind: string, id: string, title: string, content: string, extra: object = {}) => ({ id, kind, title, content, source: "refine", updated_at: "2026-11-11T00:00:00Z", version: 2, ...extra });
const writeJson = (path: string, v: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(v));
};
after(() => rmSync(root, { recursive: true, force: true }));

const skillFile = join(root, "skills", "demo", "SKILL.md");
const fake = (answers: Record<string, any>): ExtendContext => ({
  agentDir,
  activeSessionId: "act",
  sessionId: SID,
  client: {
    request: async (cmd: any) => {
      const a = answers[cmd.type === "get_tool_definition" ? `${cmd.type}:${cmd.name}` : cmd.type];
      if (a instanceof Error) throw a;
      return a;
    },
  } as ExtendContext["client"],
});

before(() => {
  writeJson(join(agentDir, "settings.json"), {
    harnessRefinements: true,
    mcpServers: { files: { type: "stdio", command: "npx", args: ["srv"], env: { TOKEN: "sekret" } }, ghost: { type: "http", url: "http://x/mcp" } },
  });
  writeJson(join(agentDir, "harness", "harness_state.json"), { schema: 1, entries: { prompt: {}, memory: { m1: entry("memory", "m1", "Likes tabs", "Use tabs.") }, skill: {}, subagent: {}, factory: {} }, refinements: [] });
  writeJson(join(agentDir, "session-artifacts", SID, "harness", "harness_state.json"), { schema: 1, entries: { memory: { m2: entry("memory", "m2", "Local note", "Only here.") }, factory: { f1: entry("factory", "f1", "Tool", "def x(): pass") } }, refinements: [] });
  mkdirSync(join(skillFile, ".."), { recursive: true });
  writeFileSync(skillFile, "---\nname: demo\ndescription: A demo\n---\n\n# Demo\nBody text.\n");
});

const answers = {
  get_resource_snapshot: { skills: [{ name: "demo", description: "A demo", filePath: skillFile }, { name: "nofile", filePath: "/nonexistent/SKILL.md" }] },
  get_mcp_connections: { connections: [{ server: "files", label: "Files", connected: true, transport: "stdio", authKind: "stdio", userDeclared: true }, { server: "linear", label: "Linear", connected: false, transport: "http", authKind: "subscription", userDeclared: false }] },
};

test("skills become one group; text is the SKILL.md body, falling back to the path", async () => {
  const g = (await extensions(fake(answers))).extensions.find((e) => e.name === "skills")!;
  assert.equal(g.enabled, true);
  assert.deepEqual(g.prompts!.map((p) => [p.id, p.title, p.description, p.text]), [
    ["skill:demo", "demo", "A demo", "# Demo\nBody text."],
    ["skill:nofile", "nofile", "", "/nonexistent/SKILL.md"],
  ]);
});

test("harness entries group per non-empty kind, global and local together", async () => {
  const all = (await extensions(fake(answers))).extensions;
  const names = all.map((e) => e.name);
  assert.deepEqual(names, ["skills", "harness-memory", "harness-factory", "mcp"]);
  const mem = all.find((e) => e.name === "harness-memory")!;
  assert.equal(mem.title, "harness: memory");
  assert.deepEqual(mem.prompts!.map((p) => [p.id, p.title, p.text, p.enabled]), [
    ["harness:memory:global:m1", "Likes tabs", "Use tabs.", true],
    ["harness:memory:local:m2", "Local note", "Only here.", true],
  ]);
  assert.match(mem.prompts![0].description, /^global · refine · .* · v2$/);
});

test("harnessRefinements:false shows every harness entry off", async () => {
  writeJson(join(agentDir, "settings.json"), { harnessRefinements: false });
  try {
    const mem = (await extensions(fake(answers))).extensions.find((e) => e.name === "harness-memory")!;
    assert.equal(mem.enabled, false);
    assert.ok(mem.prompts!.every((p) => !p.enabled));
  } finally {
    writeJson(join(agentDir, "settings.json"), { harnessRefinements: true, mcpServers: { files: { type: "stdio", command: "npx", args: ["srv"], env: { TOKEN: "sekret" } }, ghost: { type: "http", url: "http://x/mcp" } } });
  }
});

test("mcp merges the daemon roster with settings.json and never shows env values", async () => {
  const g = (await extensions(fake(answers))).extensions.find((e) => e.name === "mcp")!;
  assert.equal(g.enabled, true);
  assert.deepEqual(g.prompts!.map((p) => [p.id, p.description, p.enabled]), [
    ["mcp:files", "connected · stdio · stdio · user", true],
    ["mcp:linear", "not connected · http · subscription · built-in", false],
    ["mcp:ghost", "not loaded · http · user", false],
  ]);
  assert.match(g.prompts![0].text, /"TOKEN"/);
  assert.doesNotMatch(JSON.stringify(g), /sekret/);
  assert.match(g.prompts![1].text, /built-in/);
});

test("mcp falls back to settings.json when the daemon cannot answer", async () => {
  const g = (await extensions(fake({ ...answers, get_mcp_connections: new Error("no manager") }))).extensions.find((e) => e.name === "mcp")!;
  assert.deepEqual(g.prompts!.map((p) => [p.id, p.description]), [["mcp:files", "status unknown · stdio · user"], ["mcp:ghost", "status unknown · http · user"]]);
  assert.equal(g.enabled, false);
});

test("tools come from get_tool_definition, replay unsafe; absent tools are skipped", async () => {
  const def = { name: "python_repl", label: "python_repl", description: "Run python", parameters: { type: "object", properties: { code: { type: "string" } } } };
  const t = await tools(fake({ "get_tool_definition:python_repl": { toolDefinition: def }, "get_tool_definition:bash": {} }));
  assert.deepEqual(t, [{ name: "python_repl", description: "Run python", replay: "unsafe", parameters: def.parameters, writes: true, offered: true }]);
});

test("patch: every real target is a 400 invalid with a one-line reason; bad bodies and unknown targets too", async () => {
  const c = fake(answers);
  const bad = (body: any, re: RegExp) => assert.rejects(patch(c, body), (e: ApiFault) => e.code === "invalid" && re.test(e.message) && !e.message.includes("\n"));
  await bad({ name: "skills", enabled: false }, /no skill enable\/disable/);
  await bad({ prompt: "skill:demo", enabled: false }, /no skill enable\/disable/);
  await bad({ name: "mcp", enabled: false }, /no MCP connect\/disconnect/);
  await bad({ prompt: "mcp:files", enabled: false }, /remove_mcp_connection/);
  await bad({ name: "harness-memory", enabled: false }, /harnessRefinements/);
  await bad({ prompt: "harness:memory:local:m2", enabled: true }, /harnessRefinements/);
  await bad({ name: "nope", enabled: true }, /Unknown extension nope/);
  await bad({ prompt: "nope", enabled: true }, /Unknown item nope/);
  await bad({ name: "skills" }, /Send/);
  await bad({ name: "skills", prompt: "x", enabled: true }, /Send/);
});

// ---- integration: isolated supervisor

const BIN = process.env.PRIME_PA_DAEMON ?? "/Volumes/Mini-SSD/offload/repos/prime-agent-durable/target/release/pa-daemon";
const skip = !existsSync(BIN) && "pa-daemon binary not found";
let sup: ChildProcess | undefined;
let client: DaemonClient | undefined;
const isoRoot = mkdtempSync("/tmp/pbx-");
const isoAgent = join(isoRoot, "agent");
const socketPath = join(isoRoot, "s", "d.sock");
after(async () => {
  client?.close();
  sup?.kill("SIGTERM");
  if (sup && sup.exitCode === null) await new Promise((r) => sup!.once("exit", r));
  rmSync(isoRoot, { recursive: true, force: true });
});

test("integration: skills, mcp and tools against the isolated daemon", { skip }, async () => {
  mkdirSync(join(isoRoot, "s"), { recursive: true });
  mkdirSync(join(isoAgent, "sessions"), { recursive: true });
  const work = join(isoRoot, "work");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(isoAgent, "models.json"), JSON.stringify({ providers: { cliproxy: { baseUrl: "http://127.0.0.1:1/v1", apiKey: "CLIPROXY_API_KEY", api: "openai-completions", models: [{ id: "test-model", name: "Test", reasoning: true, contextWindow: 200000, cost: { input: 1, output: 5 } }] } } }));
  writeFileSync(join(isoAgent, "settings.json"), JSON.stringify({ defaultProvider: "cliproxy", defaultModel: "test-model", mcpServers: { files: { type: "stdio", command: "true" } } }));
  sup = spawn("env", ["-i", `HOME=${isoRoot}`, "PATH=/usr/bin:/bin", BIN, "supervisor", "--socket", socketPath, "--agent-dir", isoAgent], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(existsSync(socketPath), "supervisor socket never appeared");
  client = new DaemonClient(socketPath);
  await client.connect();
  const made = await client.request({ type: "create", lifecycle: "resident", launchEnv: { PATH: "/usr/bin:/bin", HOME: isoRoot }, config: { cwd: work, sessionDir: join(isoAgent, "sessions"), provider: "cliproxy", model: "test-model" } });
  const c: ExtendContext = { client, agentDir: isoAgent, activeSessionId: made.activeSessionId, sessionId: made.sessionId };

  const all = (await extensions(c)).extensions;
  const skills = all.find((e) => e.name === "skills")!;
  assert.ok(skills.prompts!.length > 0, "no skills from get_resource_snapshot");
  assert.ok(skills.prompts!.every((p) => p.id.startsWith("skill:") && p.text.length > 0));
  const mcp = all.find((e) => e.name === "mcp")!;
  assert.ok(mcp.prompts!.some((p) => p.id === "mcp:files"), "settings.json server missing");

  const t = await tools(c);
  assert.ok(t.some((x) => x.name === "python_repl" && x.replay === "unsafe" && x.parameters), `no python_repl in ${JSON.stringify(t.map((x) => x.name))}`);
});
