import { lookupKnown } from "../shared/known-models.ts";

export const DEFAULT_SESSION_THINKING_LEVEL = "medium";
const VALID_THINKING_LEVELS = new Set(["off", "low", "medium", "high", "xhigh", "max"]);
const DEFAULT_VISIBLE_THINKING_LEVELS = ["off", "medium", "high"];
const OPENAI_XHIGH_MODEL_MARKERS = [
  "gpt-6",
  "gpt-5",
  "gpt-5.2",
  "gpt-5.3",
  "gpt-5.4",
  "gpt-5.5",
];
const ANTHROPIC_MAX_EFFORT_MODEL_MARKERS = [
  "fable-5",
  "mythos-5",
  "opus-5-5",
  "opus-5.5",
  "sonnet-5-5",
  "sonnet-5.5",
  "opus-4-6",
  "opus-4.6",
  "opus-4-7",
  "opus-4.7",
  "sonnet-4-6",
  "sonnet-4.6",
];
const ANTHROPIC_ADAPTIVE_ONLY_MODEL_MARKERS = [
  "fable-5",
  "mythos-5",
  "opus-5-5",
  "opus-5.5",
];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function canonicalThinkingLevel(level) {
  const normalized = lower(level);
  if (normalized === "auto") return "medium";
  if (normalized === "ultracode") return "max";
  return VALID_THINKING_LEVELS.has(normalized) ? normalized : null;
}

function visibleThinkingLevel(level) {
  const normalized = canonicalThinkingLevel(level);
  if (!normalized) return null;
  return normalized === "xhigh" ? "max" : normalized;
}

export function normalizeThinkingLevelChoices(levels) {
  if (!Array.isArray(levels)) return null;
  const out = [];
  for (const rawLevel of levels) {
    const normalized = visibleThinkingLevel(rawLevel);
    if (!normalized || out.includes(normalized)) continue;
    out.push(normalized);
  }
  return out.length > 0 ? out : null;
}

export function normalizeSessionThinkingLevel(level) {
  return canonicalThinkingLevel(level) || DEFAULT_SESSION_THINKING_LEVEL;
}

export function normalizeRequestThinkingLevel(level, fallback = "off") {
  return canonicalThinkingLevel(level)
    || canonicalThinkingLevel(fallback)
    || "off";
}

export function normalizePiSdkThinkingLevel(level) {
  return normalizeRequestThinkingLevel(level, "off");
}

function idIncludesAny(id, markers) {
  return markers.some((marker) => id.includes(marker));
}

function modelUsesAnthropicEffortControl(model) {
  const provider = lower(model?.provider);
  const api = lower(model?.api);
  const baseUrl = lower(model?.baseUrl || model?.base_url);
  return provider === "anthropic"
    || api === "anthropic-messages"
    || baseUrl.includes("api.anthropic.com");
}

function modelUsesOpenRouterAdaptiveVerbosity(model) {
  const provider = lower(model?.provider);
  const baseUrl = lower(model?.baseUrl || model?.base_url);
  return provider === "openrouter" || baseUrl.includes("openrouter.ai");
}

export function modelSupportsAnthropicMaxEffort(model) {
  const id = lower(model?.id);
  return modelUsesAnthropicEffortControl(model)
    && idIncludesAny(id, ANTHROPIC_MAX_EFFORT_MODEL_MARKERS);
}

function modelSupportsOpenRouterAnthropicAdaptive(model) {
  if (!modelUsesOpenRouterAdaptiveVerbosity(model)) return false;
  const markerText = lower([
    model?.id,
    model?.name,
    model?.displayName,
    model?.display_name,
  ].filter(Boolean).join(" "));
  return idIncludesAny(markerText, ANTHROPIC_ADAPTIVE_ONLY_MODEL_MARKERS);
}

export function modelSupportsXhigh(model) {
  const markerText = lower([
    model?.id,
    model?.name,
    model?.displayName,
    model?.display_name,
  ].filter(Boolean).join(" "));
  const known = lookupKnown(model?.provider, model?.id);
  const explicitLevels = normalizeThinkingLevelChoices(model?.thinkingLevels);
  return model?.xhigh === true
    || explicitLevels?.includes("max")
    || known?.xhigh === true
    || idIncludesAny(markerText, OPENAI_XHIGH_MODEL_MARKERS)
    || isGpt5FamilyId(markerText)
    || modelSupportsAnthropicMaxEffort(model)
    || modelSupportsOpenRouterAnthropicAdaptive(model);
}

function isGpt5FamilyId(id) {
  const compact = id.replace(/[\s_-]+/g, "");
  return /(^|[^a-z0-9])gpt5($|[^a-z0-9]|[0-9])/.test(compact);
}

export function normalizeThinkingLevelForModel(level, model) {
  const normalized = normalizeSessionThinkingLevel(level);
  const requestsMax = normalized === "xhigh" || normalized === "max";
  if (requestsMax && !modelSupportsXhigh(model)) return "high";
  return normalized;
}

export function getModelThinkingLevels(model) {
  const explicitLevels = normalizeThinkingLevelChoices(model?.thinkingLevels);
  if (explicitLevels) return explicitLevels;
  return modelSupportsXhigh(model)
    ? [...DEFAULT_VISIBLE_THINKING_LEVELS, "max"]
    : [...DEFAULT_VISIBLE_THINKING_LEVELS];
}

export function resolveModelDefaultThinkingLevel(model, fallback = DEFAULT_SESSION_THINKING_LEVEL) {
  const modelLevel = typeof model?.defaultThinkingLevel === "string"
    ? model.defaultThinkingLevel
    : fallback;
  return normalizeThinkingLevelForModel(modelLevel, model);
}

export function resolveThinkingLevelForModel(level, model, resolveThinkingLevel = (value) => value) {
  return resolveThinkingLevel(normalizeThinkingLevelForModel(level, model));
}
