// Models the agent can run on, all through CLIProxyAPI (the same endpoint and ids as the dpi backend's
// ~/.dpi/models.json). CLIProxyAPI publishes no model metadata, so limits come from that file.
export const curatedModels = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", tier: "S+", icon: "anthropic.png", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"] },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", tier: "S+", icon: "anthropic.png", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"] },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", tier: "S+", icon: "openai.png", contextWindow: 400000, maxTokens: 128000, input: ["text", "image"], reasoning: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", tier: "S+", icon: "openai.png", contextWindow: 400000, maxTokens: 128000, input: ["text", "image"], reasoning: true },
  { id: "grok-4.7", name: "Grok 4.7", tier: "S", icon: "grok.png", contextWindow: 256000, maxTokens: 32000, input: ["text", "image"] },
  { id: "opencode-go/kimi-k2.7-code", name: "Kimi K2.7 Code", tier: "A", icon: "kimi.png", contextWindow: 256000, maxTokens: 32000, input: ["text"] },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", tier: "B", icon: "gemini.png", contextWindow: 1000000, maxTokens: 65536, input: ["text", "image"] },
] as const;
export const defaultModelId = "claude-sonnet-5-5";
