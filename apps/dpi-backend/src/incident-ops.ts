// The incident-ops add-on: the proactive demo's incident tools as thin proxies to the ops service
// (apps/proactive-dpi-demo), which holds the incidents, the git worktrees and the deploys. The schemas mirror
// the ops service's tool specs (extensions.ts there); each tool also takes the incident_id from the agent's brief.
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export interface OpsEndpoint {
  url: string;
  token: string;
}

const incident = { incident_id: Type.String({ description: "Your incident id, from your brief" }) };
const TOOLS: { name: string; description: string; parameters: Record<string, TSchema> }[] = [
  {
    name: "query_logs",
    description:
      "Search the production log stream (Google Cloud Logging, Cloud Run, project lumen-market-prod). Every row carries the Jev verdict the watcher gave it. Returns newest first. Use full=true for the complete JSON entry, including stack traces.",
    parameters: {
      since_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "Default 30" })),
      service: Type.Optional(Type.String({ description: "checkout-api, catalog-api, cart-api, auth-api, payments-webhook" })),
      route: Type.Optional(Type.String({ description: "Route template, such as /v1/checkout" })),
      min_severity: Type.Optional(Type.Union(["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR"].map((s) => Type.Literal(s)))),
      status: Type.Optional(Type.Integer({ description: "HTTP status" })),
      revision: Type.Optional(Type.String()),
      text: Type.Optional(Type.String({ description: "Substring of the raw entry: message, error, stack trace, customer fields" })),
      jev: Type.Optional(Type.Union([Type.Literal("normal"), Type.Literal("suspicious"), Type.Literal("incident")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Default 30" })),
      full: Type.Optional(Type.Boolean()),
    },
  },
  {
    name: "log_summary",
    description:
      "Aggregate the log stream: rows, errors, 5xx, and Jev verdicts per minute; traffic per revision; deploy notices; and the fingerprints Jev flagged. Use it to size impact and line the start of a failure up with a deploy.",
    parameters: {
      since_minutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440, description: "Default 15" })),
      service: Type.Optional(Type.String()),
    },
  },
  { name: "list_incidents", description: "List incidents the watcher opened, with status, branch, and report.", parameters: {} },
  {
    name: "update_incident",
    description:
      "Move your incident to its next stage on the timeline the engineer watches: investigating, then root_cause_found, then fix_in_progress. Stages go in order and none can be skipped. Use blocked if you cannot proceed. submit_fix and deploy finish the timeline.",
    parameters: {
      status: Type.Union([
        Type.Literal("investigating"),
        Type.Literal("root_cause_found"),
        Type.Literal("fix_in_progress"),
        Type.Literal("blocked"),
      ]),
      summary: Type.String({ description: "One or two sentences for the engineer" }),
      root_cause: Type.Optional(Type.String()),
    },
  },
  {
    name: "submit_fix",
    description:
      "Move the incident to ready_for_review after fix_in_progress. Proves the fix: the changed tests under test/ must fail on main's code and the whole suite must pass on your branch. Then it commits everything on your incident branch. If verification fails it explains why and changes nothing; fix the problem and call it again.",
    parameters: {
      summary: Type.String({ description: "One or two sentences for the engineer" }),
      root_cause: Type.String(),
      fix: Type.String({ description: "What the change does" }),
      commit_message: Type.String({ description: "fix(<area>): <what> (<incident id>)" }),
    },
  },
  {
    name: "deploy",
    description:
      "Ship the fix on your incident branch to production. Asks the on-call engineer to approve and returns at once with status awaiting_approval; the engineer's decision arrives later as a message from the ops service. Call it only after submit_fix. If the engineer declines, do not call it again until they ask.",
    parameters: { summary: Type.String({ description: "One sentence: what ships and why it is safe" }) },
  },
];

export function createIncidentOps(ops: OpsEndpoint | undefined) {
  return defineExtension({
    name: "incident-ops",
    tools: TOOLS.map((t) =>
      defineTool({
        name: t.name,
        description: t.description,
        parameters: Type.Object({ ...incident, ...t.parameters }),
        replay: "safe",
        execute: async (args) => {
          if (!ops?.token) throw Error("incident-ops is not configured: set OPS_TOOL_TOKEN (and OPS_URL) for this backend");
          const { incident_id, ...rest } = args as { incident_id: string };
          const response = await fetch(`${ops.url}/api/tools/${t.name}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${ops.token}` },
            body: JSON.stringify({ incidentId: incident_id, args: rest }),
            signal: AbortSignal.timeout(120_000),
          });
          const body = (await response.json().catch(() => ({}))) as { error?: string; text?: string };
          if (!response.ok) throw Error(body.error ?? `Ops service answered ${response.status}`);
          return { output: [{ type: "text", text: Object.keys(body).length === 1 && body.text !== undefined ? body.text : JSON.stringify(body) }] };
        },
      }),
    ),
  });
}
