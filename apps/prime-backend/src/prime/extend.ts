// Prime's real capabilities in dpi's Extend and Tools tabs: skills (daemon), continual-harness entries (harness_state.json),
// MCP servers (daemon roster + settings.json) and the session's tools (get_tool_definition). Read-only: the daemon has no
// command that switches a skill, MCP server or settings flag, and Prime's files are never written from here.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDetail, AgentExtensions, HarnessExtensionInfo } from "../../../dpi-sdk/src/api.js";
import { invalid } from "../errors.js";
import type { DaemonClient } from "./client.js";

export interface ExtendContext {
  client: Pick<DaemonClient, "request">;
  agentDir: string;
  /** The daemon's id for the live session. */
  activeSessionId: string;
  /** The session file id: names <agent_dir>/session-artifacts/<id>/. */
  sessionId: string;
}

type Prompt = NonNullable<HarnessExtensionInfo["prompts"]>[number];

const KINDS = ["prompt", "memory", "skill", "subagent", "factory"] as const;
// Prime's model-facing tools. The daemon only answers get_tool_definition by name (no list command), so probe these;
// python_repl is always active, the others when the session selects them.
const TOOL_NAMES = ["python_repl", "bash", "edit"];
const WRITING_TOOLS = new Set(["python_repl", "bash", "edit"]);

export async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

const readText = (path: string) => readFile(path, "utf8").catch(() => undefined);

const oneLine = (s: unknown, max = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The daemon builds a session's engine lazily and answers get_tool_definition / get_resource_snapshot empty until it is built; get_commands builds it. */
const warm = (c: ExtendContext) => c.client.request({ type: "get_commands", activeSessionId: c.activeSessionId }).catch(() => undefined);

const stripFrontmatter = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

export async function skillsGroup(c: ExtendContext): Promise<HarnessExtensionInfo> {
  await warm(c);
  const snap = await c.client.request({ type: "get_resource_snapshot", activeSessionId: c.activeSessionId }).catch(() => undefined);
  const prompts: Prompt[] = await Promise.all(
    ((snap?.skills ?? []) as any[]).map(async (s) => {
      const body = s.filePath ? await readText(s.filePath) : undefined;
      return {
        id: `skill:${s.name}`,
        title: String(s.name),
        description: oneLine(s.description),
        enabled: true,
        text: body ? stripFrontmatter(body) : String(s.filePath ?? ""),
      };
    }),
  );
  return {
    name: "skills",
    title: "Skills",
    description: "Skills Prime discovered for this session. Always available to the agent; Prime has no per-skill switch.",
    enabled: true,
    prompts,
  };
}

export async function harnessGroups(agentDir: string, sessionId: string): Promise<HarnessExtensionInfo[]> {
  const settings = await readJson(join(agentDir, "settings.json"));
  const masterOn = settings?.harnessRefinements !== false; // Prime's default is on
  const states: [string, any][] = [
    ["global", await readJson(join(agentDir, "harness", "harness_state.json"))],
    ["local", await readJson(join(agentDir, "session-artifacts", sessionId, "harness", "harness_state.json"))],
  ];
  const groups: HarnessExtensionInfo[] = [];
  for (const kind of KINDS) {
    const prompts: Prompt[] = [];
    for (const [scope, state] of states)
      for (const [key, e] of Object.entries<any>(state?.entries?.[kind] ?? {}))
        prompts.push({
          id: `harness:${kind}:${scope}:${key}`,
          title: String(e?.title || e?.id || key),
          description: oneLine(`${scope}${e?.source ? ` · ${e.source}` : ""}${e?.updated_at ? ` · ${e.updated_at}` : ""}${e?.version ? ` · v${e.version}` : ""}`),
          enabled: masterOn,
          text: String(e?.content ?? ""),
        });
    if (prompts.length)
      groups.push({
        name: `harness-${kind}`,
        title: `harness: ${kind}`,
        description: `Continual-harness ${kind} entries Prime refined for itself (global and this session). The global harnessRefinements setting turns them all on or off; Prime has no daemon command to change it.`,
        enabled: masterOn,
        prompts,
      });
  }
  return groups;
}

/** Server -> redacted config text: env values and tokens are never shown, only their names. */
const serverText = (cfg: any) => {
  if (!cfg || typeof cfg !== "object") return "";
  const { type, url, bearerTokenEnvVar, oauth, command, args, cwd, env } = cfg;
  return JSON.stringify({ type, url, bearerTokenEnvVar, oauth, command, args, cwd, env: env ? Object.keys(env) : undefined }, null, 2);
};

export async function mcpGroup(c: ExtendContext): Promise<HarnessExtensionInfo> {
  const configured: Record<string, any> = (await readJson(join(c.agentDir, "settings.json")))?.mcpServers ?? {};
  let roster: any[] | undefined;
  try {
    roster = (await c.client.request({ type: "get_mcp_connections", activeSessionId: c.activeSessionId }))?.connections ?? [];
  } catch {} // no MCP manager in this session, or the daemon is down: settings.json alone still lists the servers
  const rows = new Map<string, { label: string; status: string; detail: string }>();
  // Built-in services that are not connected are Prime's catalog, not this agent's servers.
  for (const r of (roster ?? []).filter((r: any) => r.connected || r.userDeclared))
    rows.set(r.server, { label: r.label || r.server, status: r.connected ? "connected" : "not connected", detail: [r.transport, r.authKind, r.userDeclared ? "user" : "built-in"].filter(Boolean).join(" · ") });
  for (const [name, cfg] of Object.entries(configured))
    if (!rows.has(name)) rows.set(name, { label: name, status: roster ? "not loaded" : "status unknown", detail: [cfg?.type, "user"].filter(Boolean).join(" · ") });
  const prompts: Prompt[] = [...rows].map(([server, r]) => ({
    id: `mcp:${server}`,
    title: r.label,
    description: oneLine(`${r.status} · ${r.detail}`),
    enabled: r.status === "connected",
    text: serverText(configured[server]) || `${server}: built-in connection (no settings.json entry)`,
  }));
  return {
    name: "mcp",
    title: "MCP servers",
    description: "MCP servers this agent has: connected ones and the ones in settings.json mcpServers. Prime has no daemon command to connect or disconnect one without deleting its credential.",
    enabled: prompts.some((p) => p.enabled),
    prompts,
  };
}

export async function extensions(c: ExtendContext): Promise<AgentExtensions> {
  const [skills, harness, mcp] = await Promise.all([skillsGroup(c), harnessGroups(c.agentDir, c.sessionId), mcpGroup(c)]);
  return { extensions: [skills, ...harness, mcp], builtIn: [] };
}

/** Prime exposes no switch for anything listed here, so a valid target gets a 400 that says why; an unknown one gets a 400 that says so. */
export async function patch(c: ExtendContext, body: { name?: string; prompt?: string; enabled?: boolean }): Promise<AgentExtensions> {
  if (typeof body?.enabled !== "boolean" || (typeof body.name !== "string") === (typeof body.prompt !== "string"))
    throw invalid("Send {name, enabled} or {prompt, enabled}");
  const all = (await extensions(c)).extensions;
  const group = body.name !== undefined ? all.find((g) => g.name === body.name) : all.find((g) => g.prompts?.some((p) => p.id === body.prompt));
  if (!group) throw invalid(`Unknown ${body.name !== undefined ? "extension" : "item"} ${body.name ?? body.prompt}`);
  const why = group.name === "skills"
    ? "Prime has no skill enable/disable command"
    : group.name === "mcp"
      ? "Prime has no MCP connect/disconnect command (only remove_mcp_connection, which deletes the credential)"
      : "harnessRefinements is a Prime setting with no daemon command to change it";
  throw invalid(`${why}.`);
}

export async function tools(c: ExtendContext): Promise<AgentDetail["tools"]> {
  await warm(c);
  const found = await Promise.all(
    TOOL_NAMES.map((name) => c.client.request({ type: "get_tool_definition", activeSessionId: c.activeSessionId, name }).then((r) => r?.toolDefinition, () => undefined)),
  );
  return found.flatMap((d) =>
    d ? [{ name: String(d.name), description: String(d.description ?? ""), replay: "unsafe" as const, parameters: d.parameters, writes: WRITING_TOOLS.has(d.name), offered: true }] : [],
  );
}
