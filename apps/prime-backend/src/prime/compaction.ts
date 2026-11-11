// Prime's automatic-compaction settings in dpi's shape. `enabled` is the daemon's set_auto_compaction; reserveTokens and
// keepRecentTokens are settings.json `compaction` values Prime reads itself, and Prime has no background compaction.
import { join } from "node:path";
import type { CompactionSettings } from "../../../dpi-sdk/src/api.js";
import { invalid } from "../errors.js";
import type { DaemonClient } from "./client.js";
import { readJson } from "./extend.js";

export interface CompactionContext {
  client: Pick<DaemonClient, "request">;
  agentDir: string;
  activeSessionId: string;
}

// pa-core session_engine/compaction.rs defaults
const RESERVE_TOKENS = 16_384;
const KEEP_RECENT_TOKENS = 20_000;

export async function compaction(c: CompactionContext): Promise<CompactionSettings> {
  const state = await c.client.request({ type: "get_connection_state", activeSessionId: c.activeSessionId });
  const saved = (await readJson(join(c.agentDir, "settings.json")))?.compaction;
  return {
    enabled: state?.autoCompactionEnabled !== false,
    reserveTokens: saved?.reserveTokens ?? RESERVE_TOKENS,
    backgroundTokens: 0,
    keepRecentTokens: saved?.keepRecentTokens ?? KEEP_RECENT_TOKENS,
  };
}

export async function setCompaction(c: CompactionContext, body: Record<string, unknown>): Promise<CompactionSettings> {
  for (const key of ["reserveTokens", "backgroundTokens", "keepRecentTokens"])
    if (body[key] !== undefined)
      throw invalid(key === "backgroundTokens" ? "Prime has no background compaction." : `Prime has no command to change ${key}; it is compaction.${key} in settings.json.`);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
    await c.client.request({ type: "set_auto_compaction", activeSessionId: c.activeSessionId, enabled: body.enabled });
  }
  return compaction(c);
}
