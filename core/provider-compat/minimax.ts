import { MINIMAX_SAFE_OUTPUT_TOKENS, positiveInteger } from "../model-token-limits.ts";

const TOKEN_LIMIT_FIELDS = ["max_completion_tokens", "max_tokens", "max_output_tokens"];

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function matches(model) {
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

function clampTokenLimits(payload) {
  let changed = false;
  const next = { ...payload };

  for (const field of TOKEN_LIMIT_FIELDS) {
    const current = positiveInteger(next[field]);
    if (!current || current <= MINIMAX_SAFE_OUTPUT_TOKENS) continue;
    next[field] = MINIMAX_SAFE_OUTPUT_TOKENS;
    changed = true;
  }

  return changed ? next : payload;
}

function stripUnsupportedReasoning(payload) {
  let next = payload;
  for (const field of ["thinking", "reasoning", "reasoning_effort", "output_config"]) {
    if (!hasOwn(next, field)) continue;
    if (next === payload) next = { ...payload };
    delete next[field];
  }
  return next;
}

export function apply(payload) {
  if (!payload || typeof payload !== "object") return payload;
  let next = clampTokenLimits(payload);
  next = stripUnsupportedReasoning(next);
  return next;
}
