// Prime's automatic-compaction settings in dpi's shape. `enabled` is the daemon's set_auto_compaction; reserveTokens and
// keepRecentTokens are settings.json `compaction` values Prime reads itself, and Prime has no background compaction.
import { join } from "node:path";
import type { CompactionSettings } from "../../../dpi-sdk/src/api.js";
import { invalid } from "../errors.js";
import type { DaemonClient } from "./client.js";
import { readJson, readMaxTokens, readModels } from "./models.js";

export interface CompactionContext {
  client: Pick<DaemonClient, "request">;
  agentDir: string;
  activeSessionId: string;
  /** The agent's model: its window and output budget place Prime's trigger. */
  model?: { provider: string; modelId: string };
}

// pa-core session_engine/compaction.rs defaults
const RESERVE_TOKENS = 16_384;
const KEEP_RECENT_TOKENS = 20_000;

/**
 * Prime's settings in dpi's shape. dpi's `reserveTokens` is the margin below the model window where compaction starts, so it
 * is the margin of Prime's own trigger (compaction.rs compaction_threshold: 95% of the window, floored by retention, capped
 * so the output budget still fits). Without a known model it stays Prime's raw reserve.
 */
export function compactionSettings(agentDir: string, model: CompactionContext["model"], enabled: boolean): CompactionSettings {
  const saved = readJson(join(agentDir, "settings.json")).compaction;
  const reserve: number = saved?.reserveTokens ?? RESERVE_TOKENS;
  const keep: number = saved?.keepRecentTokens ?? KEEP_RECENT_TOKENS;
  const window = model ? readModels(agentDir).find((m) => m.provider === model.provider && m.id === model.modelId)?.contextWindow : undefined;
  let margin = reserve;
  if (window && model) {
    const pct = saved?.thresholdPercent >= 1 && saved?.thresholdPercent <= 100 ? saved.thresholdPercent : 95;
    const percentage = Math.max(Math.floor((window * pct) / 100), keep + 2 * reserve + 1);
    // shortcut: no thinking-budget fold (anthropic/bedrock apis only); add it if models of those apis go in models.json
    const combined = Math.max(0, window - readMaxTokens(agentDir, model.provider, model.modelId) - Math.max(reserve, 4096));
    margin = window - Math.min(percentage, combined);
  }
  return { enabled, reserveTokens: margin, backgroundTokens: 0, keepRecentTokens: keep };
}

export async function compaction(c: CompactionContext): Promise<CompactionSettings> {
  const state = await c.client.request({ type: "get_connection_state", activeSessionId: c.activeSessionId });
  return compactionSettings(c.agentDir, c.model, state?.autoCompactionEnabled !== false);
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
