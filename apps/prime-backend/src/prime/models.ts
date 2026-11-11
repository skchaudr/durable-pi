// models()/defaultModel() from <agent_dir>/models.json (crates/pa-core/src/models/custom.rs:95-153) and settings.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo } from "../../../dpi-sdk/src/api.js";

export const FALLBACK_DEFAULT_MODEL = "gpt-6.1-sol";

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

const icon = (id: string) =>
  /gpt|^o\d|codex/i.test(id) ? "openai.png"
  : /claude|opus|sonnet|haiku|fable/i.test(id) ? "anthropic.png"
  : /gemini/i.test(id) ? "gemini.png"
  : /grok/i.test(id) ? "grok.png"
  : /deepseek/i.test(id) ? "deepseek.png"
  : /kimi/i.test(id) ? "kimi.png"
  : /qwen/i.test(id) ? "qwen.png"
  : /glm/i.test(id) ? "zai.png"
  : /minimax/i.test(id) ? "minimax.png"
  : "lab.png";

export function readModels(agentDir: string): ModelInfo[] {
  const providers = readJson(join(agentDir, "models.json")).providers ?? {};
  const out: ModelInfo[] = [];
  for (const [provider, cfg] of Object.entries<any>(providers))
    for (const m of cfg?.models ?? [])
      if (m?.id)
        out.push({
          id: m.id,
          provider,
          name: m.name ?? m.id,
          tier: "A",
          icon: icon(m.id),
          contextWindow: m.contextWindow ?? 128000,
          reasoning: m.reasoning ?? false,
          cost: { input: m.cost?.input ?? 0, output: m.cost?.output ?? 0 },
        });
  return out;
}

/** settings.json `defaultModel` (bare id or provider/id) if listed, else gpt-6.1-sol if listed, else the first model. */
export function readDefaultModel(agentDir: string, models: ModelInfo[]): string {
  const saved = String(readJson(join(agentDir, "settings.json")).defaultModel ?? "");
  const ids = new Set(models.map((m) => m.id));
  for (const c of [saved, saved.split("/").slice(1).join("/"), FALLBACK_DEFAULT_MODEL]) if (c && ids.has(c)) return c;
  return models[0]?.id ?? FALLBACK_DEFAULT_MODEL;
}
