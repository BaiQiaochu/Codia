import { lookupKnown } from "./known-models.ts";

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

const LEGACY_VIDEO_INPUT_COMPAT_KEY = ["h", "ana", "VideoInput"].join("");
const LEGACY_AUDIO_INPUT_COMPAT_KEY = ["h", "ana", "AudioInput"].join("");
const LEGACY_AUDIO_TRANSPORT_COMPAT_KEY = ["h", "ana", "AudioTransport"].join("");
const LEGACY_VISION_OUTPUT_FORMAT = ["h", "anako"].join("");

function getApi(model, context: any = {}) {
  return lower(model?.api || context.api);
}

function getProvider(model, context: any = {}) {
  return lower(model?.provider || context.provider);
}

function getProviderRaw(model, context: any = {}) {
  const value = model?.provider || context.provider;
  return typeof value === "string" ? value : "";
}

function getBaseUrl(model, context: any = {}) {
  return lower(model?.baseUrl || model?.base_url || context.baseUrl || context.base_url);
}

function getBaseHost(model, context: any = {}) {
  const raw = model?.baseUrl || model?.base_url || context.baseUrl || context.base_url;
  if (typeof raw !== "string" || raw.length === 0) return "";
  const text = raw.trim();
  try {
    return new URL(text).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${text}`).hostname.toLowerCase();
    } catch {
      return lower(text).split(/[/?#]/)[0].replace(/:\d+$/, "");
    }
  }
}

function getModelId(model, context: any = {}) {
  return lower(model?.id || context.id || context.modelId || context.model);
}

function getModelIdRaw(model, context: any = {}) {
  const value = model?.id || model?.model || model?.modelId || context.id || context.modelId || context.model;
  return typeof value === "string" ? value : "";
}

function getModelText(model, context: any = {}) {
  return [
    model?.id,
    model?.name,
    model?.model,
    model?.modelId,
    context.id,
    context.name,
    context.model,
    context.modelId,
  ].map(lower).filter(Boolean).join(" ");
}

function normalizeBoolean(value) {
  return value === true;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()))];
}

export function lookupKnownModelMetadata(model, context = {}) {
  if (!isPlainObject(model) && !isPlainObject(context)) return null;
  const provider = getProviderRaw(model, context);
  const modelId = getModelIdRaw(model, context);
  if (!modelId) return null;

  const providers = uniqueStrings([provider, lower(provider)]);
  const modelIds = uniqueStrings([modelId, lower(modelId)]);
  for (const providerCandidate of providers) {
    for (const modelCandidate of modelIds) {
      const known = lookupKnown(providerCandidate, modelCandidate);
      if (known) return known;
    }
  }
  for (const modelCandidate of modelIds) {
    const known = lookupKnown("", modelCandidate);
    if (known) return known;
  }
  return null;
}

function knownImageSupport(model, context = {}) {
  const known = lookupKnownModelMetadata(model, context);
  if (!known) return undefined;
  if (known.image !== undefined) return known.image === true;
  if (known.vision !== undefined) return known.vision === true;
  return undefined;
}

function compatSupportsImageInput(model) {
  const compat = model?.compat;
  return compat?.supportsVision === true
    || compat?.vision === true
    || compat?.supportsImageInput === true
    || compat?.supports_image_input === true;
}

function compatDisablesImageInput(model) {
  const compat = model?.compat;
  return compat?.supportsVision === false
    || compat?.vision === false
    || compat?.supportsImageInput === false
    || compat?.supports_image_input === false;
}

function normalizedInputModalities(model) {
  if (!Array.isArray(model?.input)) return [];
  return uniqueStrings(model.input.map(lower));
}

function isOfficialDeepSeekEndpoint(model, context = {}) {
  return getProvider(model, context) === "deepseek"
    || getBaseUrl(model, context).includes("api.deepseek.com");
}

function isOpenRouterEndpoint(model, context = {}) {
  if (getProvider(model, context) === "openrouter") return true;
  const host = getBaseHost(model, context);
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function isOfficialDeepSeekImageEndpoint(model, context = {}) {
  const host = getBaseHost(model, context);
  if (host) return host === "api.deepseek.com";
  return getProvider(model, context) === "deepseek";
}

const OFFICIAL_MIMO_PROVIDERS = new Set([
  "mimo",
  "mimo-token-plan",
  "xiaomi",
  "xiaomi-token",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "xiaomi-token-plan-cn-ams",
  "xiaomi-token-plan-sgp-ams",
]);

const MODEL_THINKING_FORMATS = new Set([
  "anthropic",
  "qwen",
  "qwen-chat-template",
  "zhipu",
  "deepseek",
  "openrouter",
  "kimi",
  "volcengine",
]);

const MODEL_REASONING_PROFILES = new Set([
  "anthropic-adaptive-only",
  "deepseek-v4-anthropic",
  "deepseek-v4-openai",
  "mimo-openai",
  "openrouter-anthropic-adaptive",
  "zhipu-openai",
  "kimi-openai",
]);

const TOOL_USE_DIALECTS = new Set([
  "openai",
  "anthropic",
  "gemini",
  "mistral",
  "none",
]);

const TOOL_RESULT_FORMATS = new Set([
  "message",
  "content_block",
  "part",
]);

const OUTPUT_CAP_FIELDS = new Set([
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "maxOutputTokens",
]);

export function normalizeModelProtocolCompat(value: any): Record<string, any> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, any> = {};

  const thinkingFormat = lower(value.thinkingFormat);
  if (MODEL_THINKING_FORMATS.has(thinkingFormat)) {
    out.thinkingFormat = thinkingFormat;
  }

  const reasoningProfile = lower(value.reasoningProfile || value.thinkingProfile);
  if (MODEL_REASONING_PROFILES.has(reasoningProfile)) {
    out.reasoningProfile = reasoningProfile;
  }

  if (value.codiaVideoInput === true || value[LEGACY_VIDEO_INPUT_COMPAT_KEY] === true) out.codiaVideoInput = true;
  if (value.codiaAudioInput === true || value[LEGACY_AUDIO_INPUT_COMPAT_KEY] === true) out.codiaAudioInput = true;
  if (value.outputCapRequired === true) out.outputCapRequired = true;
  if (typeof value.outputCapField === "string" && OUTPUT_CAP_FIELDS.has(value.outputCapField)) {
    out.outputCapField = value.outputCapField;
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function normalizeToolUseContract(value: any): Record<string, any> | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.supportsTools !== "boolean") return null;

  const dialect = lower(value.dialect);
  if (!TOOL_USE_DIALECTS.has(dialect)) return null;
  const toolResultFormat = lower(value.toolResultFormat);
  if (!TOOL_RESULT_FORMATS.has(toolResultFormat)) return null;

  const out: Record<string, any> = {
    supportsTools: value.supportsTools,
    dialect,
    toolResultFormat,
  };
  if (typeof value.supportsParallelToolCalls === "boolean") {
    out.supportsParallelToolCalls = value.supportsParallelToolCalls;
  }
  if (typeof value.supportsForcedToolChoice === "boolean") {
    out.supportsForcedToolChoice = value.supportsForcedToolChoice;
  }
  if (typeof value.supportsServerTools === "boolean") {
    out.supportsServerTools = value.supportsServerTools;
  }
  return out;
}

export function isOfficialMimoEndpoint(model, context = {}) {
  const provider = getProvider(model, context);
  if (OFFICIAL_MIMO_PROVIDERS.has(provider)) return true;

  const host = getBaseHost(model, context);
  return host === "xiaomimimo.com" || host.endsWith(".xiaomimimo.com");
}

function isDeepSeekV4ModelId(id) {
  return id === "deepseek-v4" || id.startsWith("deepseek-v4-") || id.startsWith("deepseek-v4.");
}

function isDeepSeekThinkingModelId(id) {
  return id === "deepseek-reasoner" || isDeepSeekV4ModelId(id);
}

function isAnthropicAdaptiveOnlyModelId(id) {
  return id === "claude-fable-5"
    || id === "claude-mythos-5"
    || id.endsWith("/claude-fable-5")
    || id.endsWith("/claude-mythos-5");
}

function isOpenAIReasoningApi(model, context: any = {}) {
  const api = getApi(model, context);
  return api === "openai-completions" || api === "openai-responses" || api === "";
}

function isOfficialKimiOpenAIEndpoint(model, context: any = {}) {
  if (!isOpenAIReasoningApi(model, context)) return false;

  const provider = getProvider(model, context);
  if (provider === "kimi-coding" || provider === "moonshot") return true;

  const host = getBaseHost(model, context);
  const baseUrl = getBaseUrl(model, context);
  return (
    host === "api.kimi.com"
    && baseUrl.includes("/coding/v1")
  ) || host === "api.moonshot.cn";
}

function isOfficialVolcengineEndpoint(model, context: any = {}) {
  if (!isOpenAIReasoningApi(model, context)) return false;

  const provider = getProvider(model, context);
  if (provider === "volcengine" || provider === "volcengine-coding") return true;

  const host = getBaseHost(model, context);
  return host === "ark.cn-beijing.volces.com" || host.endsWith(".volces.com");
}

export function isDeepSeekFamilyModel(model, context = {}) {
  if (!isPlainObject(model)) return false;
  const provider = getProvider(model, context);
  const baseUrl = getBaseUrl(model, context);
  const text = getModelText(model, context);
  return provider === "deepseek"
    || provider.includes("deepseek")
    || baseUrl.includes("api.deepseek.com")
    || text.includes("deepseek-ai/")
    || text.includes("deepseek/")
    || text.includes("deepseek-");
}

export function isDeepSeekReasoningModel(model, context = {}) {
  if (!isDeepSeekFamilyModel(model, context)) return false;
  if (model.reasoning === true) return true;
  if (getThinkingFormat(model, context) || getReasoningProfile(model, context)) return true;

  const text = getModelText(model, context);
  return text.includes("deepseek-reasoner")
    || text.includes("deepseek-r1")
    || text.includes("deepseek-v4");
}

export function modelSupportsImageInput(model, context = {}) {
  if (!isPlainObject(model)) return false;

  const knownImage = knownImageSupport(model, context);
  const inputHasImage = normalizedInputModalities(model).includes("image");
  const explicitImageSupport = model.image === true
    || model.vision === true
    || inputHasImage
    || compatSupportsImageInput(model);
  if (model.image === false) return false;
  if (knownImage === true) return true;
  if (knownImage === false) {
    if (model.image === true) return true;
    if (isDeepSeekFamilyModel(model, context) && explicitImageSupport) return true;
    return false;
  }
  if (compatDisablesImageInput(model)) return false;

  if (
    isOfficialDeepSeekEndpoint(model, context)
    && !explicitImageSupport
    && knownImage !== true
  ) {
    return false;
  }

  return explicitImageSupport;
}

export const MODEL_IMAGE_TRANSPORTS = Object.freeze({
  NONE: "none",
  OPENAI_IMAGE_URL: "openai-image-url",
  OPENAI_INPUT_IMAGE: "openai-input-image",
  ANTHROPIC_IMAGE: "anthropic-image",
  UNSUPPORTED: "unsupported",
});

export function resolveModelImageInputTransport(model, context = {}) {
  if (!modelSupportsImageInput(model, context)) return MODEL_IMAGE_TRANSPORTS.NONE;

  if (isOfficialDeepSeekImageEndpoint(model, context)) {
    return MODEL_IMAGE_TRANSPORTS.UNSUPPORTED;
  }

  const api = getApi(model, context);
  if (api === "anthropic-messages") return MODEL_IMAGE_TRANSPORTS.ANTHROPIC_IMAGE;
  if (api === "openai-responses" || api === "openai-codex-responses") {
    return MODEL_IMAGE_TRANSPORTS.OPENAI_INPUT_IMAGE;
  }
  return MODEL_IMAGE_TRANSPORTS.OPENAI_IMAGE_URL;
}

export function modelSupportsDirectImageInput(model, context = {}) {
  const transport = resolveModelImageInputTransport(model, context);
  return transport !== MODEL_IMAGE_TRANSPORTS.NONE
    && transport !== MODEL_IMAGE_TRANSPORTS.UNSUPPORTED;
}

export function resolveModelInputModalities(model, context = {}) {
  const input = normalizedInputModalities(model);
  const out = input.length > 0 ? input : ["text"];
  if (!out.includes("text")) out.unshift("text");

  const supportsImage = modelSupportsImageInput(model, context);
  const supportsVideo = modelSupportsVideoInput(model, context);
  const supportsAudio = modelSupportsAudioInput(model, context);
  const normalized = out.filter((item) => item !== "image" && item !== "video" && item !== "audio");
  if (supportsImage) {
    normalized.push("image");
  }
  if (supportsVideo) {
    normalized.push("video");
  }
  if (supportsAudio) {
    normalized.push("audio");
  }

  return normalized.length > 0 ? normalized : ["text"];
}

function knownVideoSupport(model, context = {}) {
  const known = lookupKnownModelMetadata(model, context);
  if (!known) return undefined;
  if (known.video !== undefined) return known.video === true;
  return undefined;
}

export function modelSupportsVideoInput(model, context = {}) {
  if (!isPlainObject(model)) return false;

  if (model.video === false) return false;
  if (model.video === true) return true;
  if (model.compat?.codiaVideoInput === true || model.compat?.[LEGACY_VIDEO_INPUT_COMPAT_KEY] === true) return true;

  const knownVideo = knownVideoSupport(model, context);
  if (knownVideo === false) return false;
  if (knownVideo === true) return true;

  return normalizedInputModalities(model).includes("video");
}

export const MODEL_VIDEO_TRANSPORTS = Object.freeze({
  NONE: "none",
  GEMINI_INLINE_DATA: "gemini-inline-data",
  OPENAI_VIDEO_URL: "openai-video-url",
  UNSUPPORTED: "unsupported",
});

export function resolveModelVideoInputTransport(model, context = {}) {
  if (!modelSupportsVideoInput(model, context)) return MODEL_VIDEO_TRANSPORTS.NONE;

  const api = getApi(model, context);
  if (api === "google-generative-ai") return MODEL_VIDEO_TRANSPORTS.GEMINI_INLINE_DATA;

  if (api === "openai-completions" && usesOpenAiVideoUrlTransport(model, context)) {
    return MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL;
  }

  return MODEL_VIDEO_TRANSPORTS.UNSUPPORTED;
}

export function modelSupportsDirectVideoInput(model, context = {}) {
  const transport = resolveModelVideoInputTransport(model, context);
  return transport === MODEL_VIDEO_TRANSPORTS.GEMINI_INLINE_DATA
    || transport === MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL;
}

function knownAudioSupport(model, context = {}) {
  const known = lookupKnownModelMetadata(model, context);
  if (!known) return undefined;
  if (known.audio !== undefined) return known.audio === true;
  return undefined;
}

function compatSupportsAudioInput(model) {
  const compat = model?.compat;
  return compat?.codiaAudioInput === true
    || compat?.[LEGACY_AUDIO_INPUT_COMPAT_KEY] === true
    || compat?.supportsAudioInput === true
    || compat?.supports_audio_input === true;
}

function compatDisablesAudioInput(model) {
  const compat = model?.compat;
  return compat?.supportsAudioInput === false
    || compat?.supports_audio_input === false
    || compat?.codiaAudioInput === false
    || compat?.[LEGACY_AUDIO_INPUT_COMPAT_KEY] === false;
}

export function modelSupportsAudioInput(model, context = {}) {
  if (!isPlainObject(model)) return false;

  if (model.audio === false) return false;
  if (compatDisablesAudioInput(model)) return false;
  if (model.audio === true) return true;
  if (compatSupportsAudioInput(model)) return true;
  if (isOfficialMimoAudioInputModel(model, context)) return true;

  const knownAudio = knownAudioSupport(model, context);
  if (knownAudio === true) return true;
  if (knownAudio === false) return false;

  return normalizedInputModalities(model).includes("audio");
}

export const MODEL_AUDIO_TRANSPORTS = Object.freeze({
  NONE: "none",
  MIMO_INPUT_AUDIO: "mimo-input-audio",
  OPENAI_INPUT_AUDIO: "openai-input-audio",
  UNSUPPORTED: "unsupported",
});

export function resolveModelAudioInputTransport(model, context = {}) {
  if (!modelSupportsAudioInput(model, context)) return MODEL_AUDIO_TRANSPORTS.NONE;

  const compat = isPlainObject(model?.compat) ? model.compat : {};
  const explicit = lower(
    compat.codiaAudioTransport
      || compat[LEGACY_AUDIO_TRANSPORT_COMPAT_KEY]
      || compat.audioTransport,
  );
  if (explicit) {
    if ((Object.values(MODEL_AUDIO_TRANSPORTS) as string[]).includes(explicit)) return explicit;
    return MODEL_AUDIO_TRANSPORTS.UNSUPPORTED;
  }

  if (isOfficialMimoAudioInputModel(model, context)) {
    return MODEL_AUDIO_TRANSPORTS.MIMO_INPUT_AUDIO;
  }

  const api = getApi(model, context);
  const provider = getProvider(model, context);
  if (api === "openai-completions" && provider === "openai") {
    return MODEL_AUDIO_TRANSPORTS.OPENAI_INPUT_AUDIO;
  }

  return MODEL_AUDIO_TRANSPORTS.UNSUPPORTED;
}

export function modelSupportsDirectAudioInput(model, context = {}) {
  const transport = resolveModelAudioInputTransport(model, context);
  return transport === MODEL_AUDIO_TRANSPORTS.MIMO_INPUT_AUDIO
    || transport === MODEL_AUDIO_TRANSPORTS.OPENAI_INPUT_AUDIO;
}

function isOfficialMimoAudioInputModel(model, context = {}) {
  if (!isOfficialMimoEndpoint(model, context)) return false;
  const id = getModelId(model, context);
  return id === "mimo-v2.5" || id === "mimo-v2-omni";
}

function usesOpenAiVideoUrlTransport(model, context = {}) {
  return isDashScopeEndpoint(model, context)
    || isMoonshotEndpoint(model, context)
    || isOfficialMimoEndpoint(model, context);
}

function isDashScopeEndpoint(model, context = {}) {
  const provider = getProvider(model, context);
  const baseUrl = getBaseUrl(model, context);
  return provider === "dashscope"
    || provider === "dashscope-coding"
    || baseUrl.includes("dashscope");
}

function isMoonshotEndpoint(model, context = {}) {
  const provider = getProvider(model, context);
  const baseUrl = getBaseUrl(model, context);
  return provider === "moonshot"
    || provider === "kimi"
    || baseUrl.includes("moonshot.cn")
    || baseUrl.includes("moonshot.ai");
}

export function withCodiaVideoInputCompat(model, enabled) {
  if (!isPlainObject(model) || enabled !== true) return model;

  const compat = isPlainObject(model.compat) ? model.compat : {};
  if (compat.codiaVideoInput === true && compat[LEGACY_VIDEO_INPUT_COMPAT_KEY] !== true) return model;
  const nextCompat = { ...compat };
  delete nextCompat[LEGACY_VIDEO_INPUT_COMPAT_KEY];

  return {
    ...model,
    compat: {
      ...nextCompat,
      codiaVideoInput: true,
    },
  };
}

export function withCodiaAudioInputCompat(model, enabled) {
  if (!isPlainObject(model) || enabled !== true) return model;

  const compat = isPlainObject(model.compat) ? model.compat : {};
  if (compat.codiaAudioInput === true && compat[LEGACY_AUDIO_INPUT_COMPAT_KEY] !== true) return model;
  const nextCompat = { ...compat };
  delete nextCompat[LEGACY_AUDIO_INPUT_COMPAT_KEY];

  return {
    ...model,
    compat: {
      ...nextCompat,
      codiaAudioInput: true,
    },
  };
}

/**
 * Resolve the request-side thinking control format declared by a model.
 *
 * Precedence:
 * 1. Explicit model.compat.thinkingFormat
 * 2. Protocol quirks projected from known-models.json
 * 3. Legacy/runtime derivation for already-projected model objects
 */
export function getThinkingFormat(model, context = {}) {
  if (!isPlainObject(model)) return null;

  const explicit = lower(model.compat?.thinkingFormat);
  if (explicit) return explicit;

  const quirks = Array.isArray(model.quirks) ? model.quirks : [];
  if (quirks.includes("enable_thinking")) return "qwen";

  const api = getApi(model, context);
  const provider = getProvider(model, context);
  const modelId = getModelId(model, context);

  if (model.reasoning === true && api === "anthropic-messages") {
    return "anthropic";
  }

  if (provider === "anthropic" && model.reasoning !== false) {
    return "anthropic";
  }

  if (
    isOpenRouterEndpoint(model, context)
    && model.reasoning === true
    && (api === "openai-completions" || api === "")
  ) {
    return "openrouter";
  }

  if (isOfficialKimiOpenAIEndpoint(model, context) && model.reasoning === true) {
    return "kimi";
  }

  if (isOfficialVolcengineEndpoint(model, context) && model.reasoning === true) {
    return "volcengine";
  }

  if (
    isOfficialDeepSeekEndpoint(model, context)
    && (model.reasoning === true || isDeepSeekThinkingModelId(modelId))
  ) {
    return "deepseek";
  }

  if (isOfficialMimoEndpoint(model, context) && model.reasoning === true) {
    return "qwen-chat-template";
  }

  return null;
}

export function getReasoningProfile(model, context = {}) {
  if (!isPlainObject(model)) return null;

  const explicit = lower(model.compat?.reasoningProfile || model.compat?.thinkingProfile);
  if (explicit) return explicit;

  const modelId = getModelId(model, context);
  if (model.reasoning === true && isAnthropicAdaptiveOnlyModelId(modelId)) {
    if (isOpenRouterEndpoint(model, context)) return "openrouter-anthropic-adaptive";
    if (getThinkingFormat(model, context) === "anthropic") return "anthropic-adaptive-only";
  }

  if (isOfficialMimoEndpoint(model, context) && model.reasoning === true) {
    const api = getApi(model, context);
    if (api === "openai-completions" || api === "openai-responses" || api === "") {
      return "mimo-openai";
    }
  }

  if (isOfficialKimiOpenAIEndpoint(model, context) && model.reasoning === true) {
    return "kimi-openai";
  }

  if (!isOfficialDeepSeekEndpoint(model, context)) return null;

  if (!isDeepSeekV4ModelId(modelId)) return null;

  const api = getApi(model, context);
  if (api === "anthropic-messages") return "deepseek-v4-anthropic";
  if (api === "openai-completions" || api === "openai-responses" || api === "") {
    return "deepseek-v4-openai";
  }

  return null;
}

export function withThinkingFormatCompat(model, context = {}) {
  if (!isPlainObject(model)) return model;

  const format = getThinkingFormat(model, context);
  const profile = getReasoningProfile(model, context);
  if (!format && !profile) return model;

  const compat = isPlainObject(model.compat) ? model.compat : {};
  if (
    (!format || lower(compat.thinkingFormat) === format)
    && (!profile || lower(compat.reasoningProfile) === profile)
  ) {
    return model;
  }

  return {
    ...model,
    compat: {
      ...compat,
      ...(format ? { thinkingFormat: format } : {}),
      ...(profile ? { reasoningProfile: profile } : {}),
    },
  };
}

export function normalizeVisionCapabilities(value) {
  if (!isPlainObject(value)) return null;
  if (!normalizeBoolean(value.grounding) && !normalizeBoolean(value.visualGrounding)) return null;

  const coordinateSpace = value.coordinateSpace === undefined || value.coordinateSpace === "norm-1000"
    ? "norm-1000"
    : null;
  let boxOrder = null;
  if (value.boxOrder === undefined || value.boxOrder === "xyxy") boxOrder = "xyxy";
  if (value.boxOrder === "yxyx") boxOrder = "yxyx";
  const boxes = value.boxes === false ? false : true;
  const points = value.points === true;
  const rawOutputFormat = lower(value.outputFormat);
  const outputFormat = rawOutputFormat === LEGACY_VISION_OUTPUT_FORMAT
    ? "codia"
    : (["gemini", "qwen", "anchor", "codia"].includes(rawOutputFormat) ? rawOutputFormat : "codia");
  const groundingMode = ["native", "prompted"].includes(lower(value.groundingMode))
    ? lower(value.groundingMode)
    : "native";

  if (!coordinateSpace || !boxOrder) return null;
  if (!boxes && !points) return null;

  return {
    grounding: true,
    boxes,
    points,
    coordinateSpace,
    boxOrder,
    outputFormat,
    groundingMode,
  };
}

export function getVisionCapabilities(model) {
  if (!isPlainObject(model)) return null;
  return normalizeVisionCapabilities(model.visionCapabilities);
}

export function modelSupportsVisualGrounding(model) {
  return getVisionCapabilities(model)?.grounding === true;
}
