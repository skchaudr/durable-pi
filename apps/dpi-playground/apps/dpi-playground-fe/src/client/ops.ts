// The proactive demo's ops service, through the hub's /api/ops proxy: incidents and deploy approvals,
// kept live from its SSE stream (an `init` snapshot, then `incident` / `deploy` upserts).
import { ref } from "vue";
import { readSse } from "@sdk/sse";
import type { Deploy, Incident } from "../../../../../proactive-dpi-demo/shared/types";
import { call, message } from "./hub";
import { network, select } from "./store";

export type Review = { ahead: number; head: string | null; log: string; diffStat: string; diff: string };

export const STEPS = ["starting", "investigating", "root_cause_found", "fix_in_progress", "ready_for_review", "deployed"];
export const STATUS_LABELS: Record<string, string> = {
  starting: "Detected",
  investigating: "Investigating",
  root_cause_found: "Root cause found",
  fix_in_progress: "Fixing",
  ready_for_review: "Ready for review",
  deployed: "Deployed",
  blocked: "Blocked",
};

export const incidents = ref<Incident[]>([]);
export const deploys = ref<Deploy[]>([]);
export const opsState = ref<"connecting" | "live" | "down">("connecting");
export const opsError = ref("");

const upsert = <T extends { id: string | number }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

/** Follow the stream until `signal` aborts, reconnecting after a pause. */
export async function followOps(signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      opsState.value = "connecting";
      const r = await fetch("/api/ops/api/stream", { signal });
      if (!r.ok || !r.body) {
        const error = ((await r.json().catch(() => undefined)) as { error?: { message?: string } } | undefined)?.error;
        throw Error(error?.message ?? `${r.status} ${r.statusText}`);
      }
      for await (const m of readSse(r.body)) {
        opsState.value = "live";
        opsError.value = "";
        const data = JSON.parse(m.data);
        if (m.event === "init") {
          incidents.value = data.incidents ?? [];
          deploys.value = data.deploys ?? [];
        } else if (m.event === "incident") incidents.value = upsert(incidents.value, data);
        else if (m.event === "deploy") deploys.value = upsert(deploys.value, data);
      }
    } catch (e) {
      if (signal.aborted) return;
      opsError.value = message(e);
    }
    opsState.value = "down";
    await new Promise((done) => setTimeout(done, 3000));
  }
}

export const reviewOf = (id: string) => call<Review>("GET", `/ops/api/incidents/${encodeURIComponent(id)}/review`);
export const decideDeploy = (id: number, approved: boolean) =>
  call<{ ok: true }>("POST", `/ops/api/deploys/${id}/decide`, { approved });

/** The hub device that holds an incident agent's session, if this hub knows that device. */
export const remoteDevice = (sessionId: string) =>
  network.devices.value.find((d) => d.tree?.sessions.some((s) => s.id === sessionId));

export function openRemote(remote: NonNullable<Incident["remote"]>) {
  const d = remoteDevice(remote.sessionId);
  if (d) select({ deviceId: d.id, sessionId: remote.sessionId, agentId: Number(remote.agentId) });
}
