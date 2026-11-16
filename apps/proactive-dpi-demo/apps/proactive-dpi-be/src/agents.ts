// Where an incident's agent runs: in this process (pi-durable) or on a dpi/Prime backend through the dpi HTTP API.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Conversation, Session } from "@earendil-works/pi-durable";
import { DpiClient } from "../../../../dpi-sdk/src/client.ts";
import type { Incident } from "../../../shared/types.ts";
import { config } from "./config.ts";
import { Incidents, playbook } from "./extensions.ts";

export type Remote = NonNullable<Incident["remote"]>;

/** What a runner reports back: where a remote agent lives, and notes for the incident timeline. */
export type StartHooks = { save(remote: Remote): Promise<void>; note(text: string): Promise<void> };

export interface AgentRunner {
  /** Starts the incident's agent on its brief, exactly once per incident. Rejects with the reason when it cannot. */
  start(incident: Incident, brief: string, hooks: StartHooks): Promise<void>;
  /** Posts a message to the agent, exactly once per requestId. Remote agents only: an in-process deploy blocks instead. */
  tell?(incident: Incident, requestId: string, text: string): Promise<void>;
}

/** Adds a line to an incident's timeline. A failure also blocks the incident and becomes its summary. */
export async function recordNote(rt: Pick<Session, "commit">, incidentId: string, text: string, failed = false) {
  return rt.commit(async (tx) => {
    const item = (await tx.doc(Incidents)).items[incidentId];
    if (failed) {
      item.status = "blocked";
      item.summary = text;
    }
    item.updatedAt = Date.now();
    item.timeline.push({ at: item.updatedAt, status: item.status, summary: text });
    return JSON.parse(JSON.stringify(item)) as Incident;
  }, ctx);
}

/** The incident's own pi-durable conversation, opened in the same commit as its record. */
export const inprocRunner = (conversation: (id: number) => Promise<Conversation>): AgentRunner => ({
  async start(incident, brief) {
    const c = await conversation(incident.conversationId);
    await c.submit({ type: "input", content: brief, requestId: `incident:${incident.id}:brief` }, ctx);
  },
});

/**
 * One session on a dpi or Prime backend per incident. They differ only in how the agent gets its tools and
 * instructions: dpi takes instructions in its config and the incident-ops add-on; Prime refuses instructions, so they
 * lead the first message, and its tools come from the incident-ops MCP server in its settings.json.
 */
export function remoteRunner(backend: Remote["backend"], remote: NonNullable<typeof config.remote>): AgentRunner {
  const client = () => new DpiClient(remote.url, remote.token());
  const agent = (r: Remote) => client().agent(r.sessionId, r.agentId);
  return {
    async start(incident, brief, { save, note }) {
      const c = client();
      let r = incident.remote;
      if (!r) {
        const device = await c.device();
        // The device's own catalog decides: the requested model when it lists it, else the device default.
        const listed = device.models.find((m) => m.id === config.model);
        const model = listed ?? device.models.find((m) => m.id === device.defaultModel);
        if (!model) throw Error(`${backend} lists no model to run ${incident.id} on`);
        await note(listed ? `Agent model on ${backend}: ${model.id}` : `Agent model on ${backend}: ${model.id} (the requested ${config.model} is not listed there)`);
        // The key makes a retry after a crash find the session it already made. openedAt keeps INC-0001 of the next take apart.
        const session = await c.createSession(
          {
            name: `${incident.id}: ${incident.title}`.slice(0, 100),
            cwd: incident.worktree,
            model: { provider: model.provider, modelId: model.id },
            thinkingLevel: config.thinking,
          },
          `incident:${incident.id}:${incident.openedAt}:session`,
        );
        r = { backend, sessionId: session.id, agentId: String(session.agents[0].id) };
        await save(r);
      }
      const instructions = `${playbook(backend === "dpi" ? "tools" : "mcp")}\n\nYou own ${incident.id}: ${incident.title}. Your incident_id is ${incident.id}. Your worktree is ${incident.worktree}, on branch ${incident.branch}.`;
      const a = agent(r);
      if (backend === "dpi") {
        await a.configure({ instructions });
        await a.setExtension({ name: "incident-ops", enabled: true });
      }
      // Waiting a few seconds surfaces an agent that cannot run at all (a model the provider does not serve).
      const sent = await a.send(backend === "dpi" ? brief : `${instructions}\n\n${brief}`, "followUp", `incident:${incident.id}:brief`, 15_000);
      if (sent.status === "unanswered") throw Error(`the ${backend} agent could not run the brief: ${sent.reason}`);
    },
    async tell(incident, requestId, text) {
      if (incident.remote) await agent(incident.remote).send(text, "followUp", requestId);
    },
  };
}
