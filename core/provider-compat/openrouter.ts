import { getReasoningProfile } from "../../shared/model-capabilities.ts";

const ADAPTIVE_THINKING_DISABLED_ERROR =
  "Claude Fable/Mythos 5 does not support disabling adaptive thinking.";

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function matches(model) {
  if (!model || typeof model !== "object") return false;
  return getReasoningProfile(model) === "openrouter-anthropic-adaptive";
}

function isThinkingOff(value) {
  if (value === false) return true;
  const normalized = lower(value);
  return normalized === "off"
    || normalized === "none"
    || normalized === "disabled";
}

function adaptiveEffortForLevel(level) {
  if (level === "xhigh" || level === "max") return "max";
  if (level === "low" || level === "medium" || level === "high") return level;
  return "high";
}

function hasDisabledReasoning(payload) {
  if (hasOwn(payload, "reasoning_effort") && isThinkingOff(payload.reasoning_effort)) return true;
  if (payload.thinking?.type === "disabled") return true;
  if (!isPlainObject(payload.reasoning)) return false;
  if (payload.reasoning.enabled === false) return true;
  return isThinkingOff(payload.reasoning.effort);
}

function normalizeReasoning(reasoning) {
  const next = isPlainObject(reasoning) ? { ...reasoning } : {};
  delete next.effort;
  delete next.max_tokens;
  delete next.maxTokens;
  next.enabled = true;
  return next;
}

export function apply(payload, model, options: Record<string, any> = {}) {
  if (isThinkingOff(options?.reasoningLevel) || hasDisabledReasoning(payload)) {
    throw new Error(ADAPTIVE_THINKING_DISABLED_ERROR);
  }

  const next = { ...payload };
  delete next.thinking;
  delete next.reasoning_effort;
  next.reasoning = normalizeReasoning(payload.reasoning);
  next.verbosity = adaptiveEffortForLevel(options?.reasoningLevel);
  return next;
}
