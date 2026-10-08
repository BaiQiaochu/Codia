// @ts-nocheck
export const DEFAULT_SESSION_RESERVE_TOKENS = 16_384;
export const DEFAULT_SESSION_KEEP_RECENT_TOKENS = 20_000;
export const THIRD_PARTY_SAFE_OUTPUT_TOKENS = 8_192;
export const MINIMAX_SAFE_OUTPUT_TOKENS = 1_024;
export const DEEPSEEK_SAFE_CONTEXT_WINDOW = 128_000;
export const DEEPSEEK_SAFE_OUTPUT_TOKENS = 8_192;

const MIN_OUTPUT_TOKENS = 1_024;
const LOW_CONTEXT_RATIO = 0.5;

const LOCAL_OR_COMPAT_PROVIDERS = new Set([
  "custom",
  "local",
  "localai",
  "lmstudio",
  "lm-studio",
  "ollama",
  "openai-compatible",
  "openai-compat",
  "sglang",
  "vllm",
  "xinference",
]);

const FIRST_PARTY_PROVIDERS = new Set([
  "anthropic",
  "azure-openai",
  "bedrock",
  "dashscope",
  "deepseek",
  "gemini",
  "github-copilot",
  "google",
  "google-gemini-cli",
  "google-vertex",
  "mistral",
  "openai",
  "openai-codex",
  "zai",
]);

export function positiveInteger(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isLocalBaseUrl(baseUrl) {
  const value = lower(baseUrl);
  return value.includes("localhost")
    || value.includes("127.0.0.1")
    || value.includes("0.0.0.0")
    || value.includes("[::1]");
}

export function isMiniMaxModel(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  const id = lower(model.id || model.model);
  return provider === "minimax"
    || provider === "minimax-token-plan"
    || baseUrl.includes("api.minimaxi.com")
    || baseUrl.includes("api.minimax.io")
    || id.startsWith("minimax-m2");
}

export function isOfficialDeepSeekModel(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const baseUrl = lower(model.baseUrl || model.base_url);
  return provider === "deepseek" || baseUrl.includes("api.deepseek.com");
}

export function getModelContextWindow(model) {
  const declared = positiveInteger(
    model?.contextWindow
    ?? model?.context
    ?? model?.max_model_len
    ?? model?.maxTotalTokens
    ?? model?.max_total_tokens,
  );
  if (!declared) return null;
  if (isOfficialDeepSeekModel(model)) return Math.min(declared, DEEPSEEK_SAFE_CONTEXT_WINDOW);
  return declared;
}

export function getModelDeclaredMaxOutput(model) {
  return positiveInteger(
    model?.maxOutput
    ?? model?.maxOutputTokens
    ?? model?.maxTokens,
  );
}

export function isThirdPartyCompatibleModel(model) {
  if (!model || typeof model !== "object") return false;
  const provider = lower(model.provider);
  const api = lower(model.api);
  const baseUrl = lower(model.baseUrl || model.base_url);

  if (LOCAL_OR_COMPAT_PROVIDERS.has(provider)) return true;
  if (isLocalBaseUrl(baseUrl)) return true;

  return api === "openai-completions"
    && provider
    && !FIRST_PARTY_PROVIDERS.has(provider);
}

export function getSafeMaxOutputTokens(model, options = {}) {
  const caps = [];
  const declaredMax = getModelDeclaredMaxOutput(model);
  const contextWindow = getModelContextWindow(model);
  const defaultLimit = positiveInteger(options.defaultLimit);
  const thirdPartyFallback = positiveInteger(options.thirdPartyFallback)
    ?? THIRD_PARTY_SAFE_OUTPUT_TOKENS;

  if (declaredMax) caps.push(declaredMax);

  if (isMiniMaxModel(model)) {
    caps.push(MINIMAX_SAFE_OUTPUT_TOKENS);
  }

  if (contextWindow && contextWindow <= DEFAULT_SESSION_RESERVE_TOKENS) {
    caps.push(Math.max(MIN_OUTPUT_TOKENS, Math.floor(contextWindow * LOW_CONTEXT_RATIO)));
  }

  if (isThirdPartyCompatibleModel(model) && (!declaredMax || declaredMax === DEFAULT_SESSION_RESERVE_TOKENS)) {
    caps.push(thirdPartyFallback);
  }

  if (defaultLimit) caps.push(defaultLimit);
  if (caps.length === 0) return null;

  return Math.max(MIN_OUTPUT_TOKENS, Math.min(...caps));
}

export function getSafeSessionTokenSettings(model) {
  const reserveTokens = getSafeMaxOutputTokens(model, {
    defaultLimit: DEFAULT_SESSION_RESERVE_TOKENS,
    thirdPartyFallback: THIRD_PARTY_SAFE_OUTPUT_TOKENS,
  }) ?? DEFAULT_SESSION_RESERVE_TOKENS;
  const contextWindow = getModelContextWindow(model);

  let keepRecentTokens = DEFAULT_SESSION_KEEP_RECENT_TOKENS;
  if (contextWindow) {
    const inputBudget = Math.max(MIN_OUTPUT_TOKENS, contextWindow - reserveTokens - MIN_OUTPUT_TOKENS);
    keepRecentTokens = Math.min(keepRecentTokens, inputBudget);
  }

  return { reserveTokens, keepRecentTokens };
}
