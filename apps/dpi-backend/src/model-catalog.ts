// Source: https://agenticengineer.com/model-stack, retrieved 2026-10-05.
// Active S+, S, A and B models, matched to https://openrouter.ai/api/v1/models.
// Gemini 4 Argon is rolling out and has no OpenRouter listing at this snapshot.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CuratedModel {
  id: string;
  name: string;
  tier: string;
  icon: string;
  /** pi-ai provider id: "openrouter" (built-in) or an operator provider from models.json. */
  provider: string;
}

/** An extra OpenAI-compatible endpoint (models.json "providers"), e.g. a local CLIProxyAPI. */
export interface OperatorProvider {
  id: string;
  name?: string;
  baseUrl: string;
  /** Env var holding the bearer token; the provider is skipped when it is unset. */
  apiKeyEnv: string;
}

/** An operator-added model (see loadOperatorModels). The extra fields only matter when pi-ai's
 *  OpenRouter snapshot lacks the id and the store has to synthesize a catalog entry for it. */
export interface OperatorModel extends CuratedModel {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  cost?: { input: number; output: number };
}

const builtinModels: Omit<CuratedModel, "provider">[] = [
  {
    id: "anthropic/claude-opus-5.5",
    name: "Claude Opus 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "anthropic/claude-fable-5.1",
    name: "Claude Fable 5.1",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-astra",
    name: "GPT-6 Astra",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-opus-5",
    name: "Opus 5",
    tier: "S+",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    tier: "S+",
    icon: "openai.png",
  },
  {
    id: "anthropic/claude-fable-5",
    name: "Fable 5",
    tier: "S",
    icon: "anthropic.png",
  },
  {
    id: "meta/muse-spark-1.3",
    name: "Muse Spark 1.3",
    tier: "S",
    icon: "meta.png",
  },
  {
    id: "openai/gpt-6-sol",
    name: "GPT-6 Sol",
    tier: "S",
    icon: "openai.png",
  },
  {
    id: "x-ai/grok-4.7",
    name: "Grok 4.7",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "xiaomi/mimo-v2.6-pro",
    name: "MiMo-V2.6-Pro",
    tier: "S",
    icon: "xiaomi.png",
  },
  {
    id: "x-ai/grok-4.6",
    name: "Grok 4.6",
    tier: "S",
    icon: "grok.png",
  },
  {
    id: "z-ai/glm-5.3",
    name: "GLM-5.3",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "moonshotai/kimi-k3",
    name: "Kimi K3",
    tier: "A",
    icon: "kimi.png",
  },
  {
    id: "openai/gpt-5.6-terra",
    name: "GPT 5.6 Terra",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "google/gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "qwen/qwen3.8-2.4t-a95b",
    name: "Qwen3.8-2.4T-A95B",
    tier: "A",
    icon: "qwen.png",
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "google/gemini-3.7-flash",
    name: "Gemini 3.7 Flash",
    tier: "A",
    icon: "gemini.png",
  },
  {
    id: "anthropic/claude-sonnet-5",
    name: "Sonnet 5",
    tier: "A",
    icon: "anthropic.png",
  },
  {
    id: "openai/gpt-6-luna",
    name: "GPT-6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "xiaomi/mimo-v2.6-flash",
    name: "MiMo-V2.6-Flash",
    tier: "A",
    icon: "xiaomi.png",
  },
  {
    id: "openai/gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    tier: "A",
    icon: "openai.png",
  },
  {
    id: "deepseek/deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro 0813",
    tier: "A",
    icon: "deepseek.png",
  },
  {
    id: "z-ai/glm-5.2",
    name: "GLM-5.2",
    tier: "A",
    icon: "zai.png",
  },
  {
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3-Flash",
    tier: "B",
    icon: "zai.png",
  },
  {
    id: "google/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    tier: "B",
    icon: "gemini.png",
  },
  {
    id: "minimax/minimax-m3",
    name: "MiniMax-M3",
    tier: "B",
    icon: "minimax.png",
  },
  {
    id: "google/gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash-Lite",
    tier: "B",
    icon: "gemini.png",
  },
];

/** Models clients may pick: operator additions first, then the built-in list. */
export const curatedModels: CuratedModel[] = builtinModels.map((m) => ({ ...m, provider: "openrouter" }));
/** Live binding: loadOperatorModels() may reassign it. */
export let defaultModelId = "anthropic/claude-sonnet-5.5";

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

/**
 * Operator overrides, read once by the Store before it checks the OpenRouter catalog. Idempotent.
 *   $DPI_MODELS_FILE (default $DPI_HOME/models.json):
 *     { "default"?: id, "providers"?: OperatorProvider[], "models"?: OperatorModel[] }
 *   $DPI_DEFAULT_MODEL: wins over the file's "default".
 * A model's "provider" defaults to "openrouter"; any other value must name an entry in "providers".
 * Returns the file's models and providers so the store can register them with pi-ai.
 */
export function loadOperatorModels(env: NodeJS.ProcessEnv = process.env): {
  models: OperatorModel[];
  providers: OperatorProvider[];
} {
  const home = expand(env.DPI_HOME ?? join(homedir(), ".dpi"));
  const file = expand(env.DPI_MODELS_FILE ?? join(home, "models.json"));
  let extras: OperatorModel[] = [];
  let providers: OperatorProvider[] = [];
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      default?: string;
      providers?: Partial<OperatorProvider>[];
      models?: Partial<OperatorModel>[];
    };
    providers = (parsed.providers ?? []).map((p) => {
      const { id, baseUrl, apiKeyEnv } = p ?? {};
      if (typeof id !== "string" || typeof baseUrl !== "string" || typeof apiKeyEnv !== "string")
        throw Error(`${file}: every provider needs id, baseUrl and apiKeyEnv`);
      if (id === "openrouter" || id === "faux") throw Error(`${file}: provider id ${id} is reserved`);
      return { ...p, id, baseUrl, apiKeyEnv };
    });
    extras = (parsed.models ?? []).map((m) => {
      const { id, name } = m ?? {};
      if (typeof id !== "string" || typeof name !== "string") throw Error(`${file}: every model needs id and name`);
      const provider = m.provider ?? "openrouter";
      if (provider !== "openrouter" && !providers.some((p) => p.id === provider))
        throw Error(`${file}: model ${id} names provider ${provider}, which is not in "providers"`);
      return { ...m, id, name, provider, tier: m.tier ?? "T", icon: m.icon ?? "lab.png" };
    });
    for (const m of extras) {
      const i = curatedModels.findIndex((c) => c.id === m.id);
      if (i >= 0) curatedModels.splice(i, 1);
    }
    curatedModels.unshift(...extras);
    if (parsed.default) defaultModelId = parsed.default;
  }
  if (env.DPI_DEFAULT_MODEL) defaultModelId = env.DPI_DEFAULT_MODEL;
  if (!curatedModels.some((c) => c.id === defaultModelId))
    throw Error(`Default model ${defaultModelId} is not in the model list (built-in or ${file})`);
  return { models: extras, providers };
}
