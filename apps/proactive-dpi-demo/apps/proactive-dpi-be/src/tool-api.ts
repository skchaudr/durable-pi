// The ops service's tool API for remote incident agents. POST /api/tools/:name is what the dpi backend's
// incident-ops add-on calls; POST /mcp serves the same tools to Prime, which reaches tools only through MCP.
// Both need the bearer token (OPS_TOOL_TOKEN).
import { timingSafeEqual } from "node:crypto";
import type { Express, RequestHandler } from "express";
import { NotFound } from "./extensions.ts";

export type ToolHost = {
  callTool(name: string, incidentId: string, args: unknown): Promise<{ text?: string }>;
  toolInfo(): { name: string; description: string; inputSchema: unknown }[];
};

export const bearer = (token: string): RequestHandler => (req, res, next) => {
  const given = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const want = Buffer.from(token);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(401).json({ error: "Invalid or missing bearer token" });
    return;
  }
  next();
};

/** What a model reads: plain text for most tools, the whole JSON for results that carry a status (deploy). */
const render = (r: { text?: string }) => (Object.keys(r).length === 1 && r.text !== undefined ? r.text : JSON.stringify(r));

export function mountToolApi(app: Express, host: ToolHost, token: string) {
  const auth = bearer(token);
  app.post("/api/tools/:name", auth, async (req, res) => {
    const { incidentId, args } = req.body ?? {};
    if (typeof incidentId !== "string") {
      res.status(400).json({ error: "incidentId is required" });
      return;
    }
    try {
      res.json(await host.callTool(String(req.params.name), incidentId, args));
    } catch (e) {
      res.status(e instanceof NotFound ? 404 : 400).json({ error: (e as Error).message });
    }
  });

  // Streamable HTTP MCP, JSON responses only: initialize, tools/list and tools/call. The tools take incident_id in
  // their arguments because no session says which incident is the caller's.
  app.get("/mcp", auth, (_req, res) => void res.status(405).end());
  app.post("/mcp", auth, async (req, res) => {
    const { id, method, params } = req.body ?? {};
    if (id === undefined) return void res.status(202).end(); // a notification
    const ok = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return void ok({
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "incident-ops", version: "1" },
        });
      case "ping":
        return void ok({});
      case "tools/list":
        return void ok({ tools: host.toolInfo() });
      case "tools/call": {
        const { incident_id, ...args } = params?.arguments ?? {};
        try {
          return void ok({ content: [{ type: "text", text: render(await host.callTool(String(params?.name), String(incident_id ?? ""), args)) }] });
        } catch (e) {
          return void ok({ content: [{ type: "text", text: (e as Error).message }], isError: true });
        }
      }
      default:
        return void res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  });
}

/** Read-only lists for other services (the playground hub): every incident and every deploy request. */
export function mountReadApi(app: Express, host: { incidents(): Promise<unknown[]>; deploys(): Promise<unknown[]> }) {
  app.get("/api/incidents", async (_req, res) => void res.json(await host.incidents()));
  app.get("/api/deploys", async (_req, res) => void res.json(await host.deploys()));
}
