// Prime's automatic-compaction settings in dpi's shape. `enabled` and `reserveTokens` are session-only: the daemon's
// set_compaction_settings changes the live engine and never writes settings.json. keepRecentTokens is the file's value.
// backgroundTokens is kept per session here (acp-driver.ts starts the early compaction); Prime has no such setting.
import { join } from "node:path";
import type { CompactionSettings } from "../../../dpi-sdk/src/api.js";
import { invalid } from "../errors.js";
import type { DaemonClient } from "./client.js";
import { readJson, readMaxTokens, readModels } from "./models.js";

/** What the session keeps between calls: the daemon's live compaction values and dpi's backgroundTokens (Prime has no such setting). */
export interface CompactionStore {
  live?: { reserveTokens?: number | null; keepRecentTokens?: number; thresholdPercent?: number };
  backgroundTokens: number;
}

export interface CompactionContext {
  client: Pick<DaemonClient, "request">;
  agentDir: string;
  activeSessionId: string;
  /** The agent's model: its window and output budget place Prime's trigger. */
  model?: { provider: string; modelId: string };
  store?: CompactionStore;
}

// pa-core session_engine/compaction.rs defaults
const RESERVE_TOKENS = 16_384;
const KEEP_RECENT_TOKENS = 20_000;

/**
 * Prime's settings in dpi's shape. dpi's `reserveTokens` is the margin below the model window where compaction starts, so it
 * is the margin of Prime's own trigger (compaction.rs compaction_threshold: 95% of the window, floored by retention, capped
 * so the output budget still fits). Without a known model it stays Prime's raw reserve. The session's live values (set by
 * set_compaction_settings, never in settings.json) win over the file.
 */
export function compactionSettings(agentDir: string, model: CompactionContext["model"], enabled: boolean, store?: CompactionStore): CompactionSettings {
  const saved = readJson(join(agentDir, "settings.json")).compaction;
  const live = store?.live;
  const reserve: number = live?.reserveTokens ?? saved?.reserveTokens ?? RESERVE_TOKENS;
  const keep: number = live?.keepRecentTokens ?? saved?.keepRecentTokens ?? KEEP_RECENT_TOKENS;
  const window = model ? readModels(agentDir).find((m) => m.provider === model.provider && m.id === model.modelId)?.contextWindow : undefined;
  let margin = reserve;
  if (window && model) {
    const p = live?.thresholdPercent ?? saved?.thresholdPercent;
    const pct = p >= 1 && p <= 100 ? p : 95;
    const percentage = Math.max(Math.floor((window * pct) / 100), keep + 2 * reserve + 1);
    // shortcut: no thinking-budget fold (anthropic/bedrock apis only); add it if models of those apis go in models.json
    const combined = Math.max(0, window - readMaxTokens(agentDir, model.provider, model.modelId) - Math.max(reserve, 4096));
    margin = window - Math.min(percentage, combined);
  }
  return { enabled, reserveTokens: margin, backgroundTokens: store?.backgroundTokens ?? 0, keepRecentTokens: keep };
}

/** The Prime reserve whose trigger margin is `margin` (the inverse of the combined cap above); the 95% cap still floors the margin. */
function reserveForMargin(c: CompactionContext, margin: number): number {
  const known = c.model && readModels(c.agentDir).some((m) => m.provider === c.model!.provider && m.id === c.model!.modelId);
  return known && c.model ? Math.max(0, margin - readMaxTokens(c.agentDir, c.model.provider, c.model.modelId)) : margin;
}

export async function compaction(c: CompactionContext): Promise<CompactionSettings> {
  const state = await c.client.request({ type: "get_connection_state", activeSessionId: c.activeSessionId });
  // An empty set_compaction_settings reads the engine's live values; a daemon without the command keeps the file's.
  const live = await c.client.request({ type: "set_compaction_settings", activeSessionId: c.activeSessionId }).catch(() => undefined);
  const store = c.store ?? { backgroundTokens: 0 };
  if (live) store.live = live;
  return compactionSettings(c.agentDir, c.model, state?.autoCompactionEnabled !== false, store);
}

export async function setCompaction(c: CompactionContext, body: Record<string, unknown>): Promise<CompactionSettings> {
  if (body.keepRecentTokens !== undefined) throw invalid(`Prime has no command to change keepRecentTokens; it is compaction.keepRecentTokens in settings.json.`);
  const count = (key: string) => {
    const v = body[key];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) throw invalid(`${key} must be a non-negative integer`);
    return v as number | undefined;
  };
  const margin = count("reserveTokens");
  const background = count("backgroundTokens");
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw invalid("enabled must be a boolean");
  if (margin !== undefined || body.enabled !== undefined)
    await c.client.request({
      type: "set_compaction_settings",
      activeSessionId: c.activeSessionId,
      ...(margin !== undefined ? { reserveTokens: reserveForMargin(c, margin) } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });
  if (background !== undefined && c.store) c.store.backgroundTokens = background;
  return compaction(c);
}
