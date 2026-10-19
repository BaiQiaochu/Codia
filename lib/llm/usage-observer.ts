// @ts-nocheck
import { debugLog } from "../debug-log.ts";

function numberOrNull(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return 0;
}

function maybeNumber(...values) {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
}

function cacheCreationTokens(usage) {
  const direct = maybeNumber(usage?.cacheWrite, usage?.cacheWriteTokens, usage?.cache_creation_input_tokens);
  if (direct !== null) return direct;

  const creation = usage?.cache_creation;
  if (!creation || typeof creation !== "object") return 0;
  return firstNumber(creation.ephemeral_5m_input_tokens)
    + firstNumber(creation.ephemeral_1h_input_tokens);
}

function usesInclusivePromptTokenAccounting(usage) {
  return maybeNumber(usage?.prompt_tokens) !== null;
}

function costTotalFromUsage(usage) {
  return maybeNumber(usage?.costTotal, usage?.cost?.total);
}

/** SDKs initialize usage to zero before receiving any provider usage. Zero counters
 * alone do not prove an observed zero-token/free request; retain its reservation. */
export function hasObservedUsageTokens(normalized) {
  return [normalized?.input?.totalTokens, normalized?.input?.uncachedTokens,
    normalized?.output?.totalTokens, normalized?.output?.reasoningTokens,
    normalized?.cache?.readTokens, normalized?.cache?.writeTokens, normalized?.totalTokens]
    .some(value => numberOrNull(value) > 0);
}

export function costTotalFromRates(normalized, costRates) {
  if (!costRates || typeof costRates !== "object") return null;
  if (numberOrNull(normalized.input?.totalTokens) === null || numberOrNull(normalized.output?.totalTokens) === null || numberOrNull(normalized.totalTokens) === null) return null;
  const inputTokens = normalized.input.uncachedTokens ?? normalized.input.totalTokens ?? 0;
  const outputTokens = normalized.output.totalTokens ?? 0;
  const cacheReadTokens = normalized.cache.readTokens ?? 0;
  const cacheWriteTokens = normalized.cache.writeTokens ?? 0;
  if (costRates.currency && costRates.currency !== "USD" || costRates.needsReview) return null;
  const components = [[inputTokens, costRates.input], [outputTokens, costRates.output], [cacheReadTokens, costRates.cacheRead], [cacheWriteTokens, costRates.cacheWrite]];
  if (components.some(([tokens, rate]) => tokens > 0 && numberOrNull(rate) === null)) return null;
  if (!components.some(([,rate]) => numberOrNull(rate) > 0) && costRates.zeroCostConfirmed !== true) return null;
  const [input, output, cacheRead, cacheWrite] = components.map(([tokens, rate]) => tokens * (numberOrNull(rate) ?? 0) / 1_000_000);
  const total = input + output + cacheRead + cacheWrite;
  return Number.isFinite(total) ? total : null;
}

function cacheSupport(options) {
  const support = options?.cacheSupport;
  if (support === "not_reported" || support === "not_supported") return support;
  return "reported";
}

function reasoningTokens(usage) {
  return maybeNumber(
    usage?.reasoningTokens,
    usage?.reasoning_tokens,
    usage?.completion_tokens_details?.reasoning_tokens,
    usage?.output_tokens_details?.reasoning_tokens
  );
}

function uncachedTokens(rawInputTokens, inputTotalTokens, cacheReadTokens, cacheWriteTokens, cacheMissTokens, support, inclusivePromptTokens) {
  if (support !== "reported") return null;
  if (cacheMissTokens !== null) return cacheMissTokens;
  if (rawInputTokens === null) return null;
  if (inclusivePromptTokens) {
    return Math.max(0, inputTotalTokens - firstNumber(cacheReadTokens) - firstNumber(cacheWriteTokens));
  }
  return rawInputTokens;
}

function ratio(partTokens, totalTokens, support) {
  if (support !== "reported") return null;
  if (totalTokens === null || partTokens === null || totalTokens <= 0) return null;
  return partTokens / totalTokens;
}

/**
 * Normalize provider-specific usage payloads into the Pi SDK token vocabulary.
 *
 * Supported inputs:
 * - Pi SDK: { input, output, cacheRead, cacheWrite, totalTokens, cost }
 * - Anthropic: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 * - OpenAI-compatible: { prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details.cached_tokens }
 */
export function normalizeLlmUsage(usage, options = {}) {
  if (!usage || typeof usage !== "object") return null;
  if (![usage.input, usage.inputTokens, usage.input_tokens, usage.prompt_tokens, usage.output, usage.outputTokens, usage.output_tokens, usage.completion_tokens, usage.totalTokens, usage.total_tokens].some(value => numberOrNull(value) !== null)) return null;

  const rawInputTokens = maybeNumber(usage.input, usage.inputTokens, usage.input_tokens, usage.prompt_tokens);
  const outputTokens = maybeNumber(usage.output, usage.outputTokens, usage.output_tokens, usage.completion_tokens);
  const cacheMissTokens = maybeNumber(usage.cacheMiss, usage.cacheMissTokens, usage.prompt_cache_miss_tokens);
  const support = cacheSupport(options);
  const inclusivePromptTokens = usesInclusivePromptTokenAccounting(usage);
  const cacheReadTokens = support === "reported"
    ? firstNumber(
      usage.cacheRead,
      usage.cacheReadTokens,
      usage.cache_read_input_tokens,
      usage.prompt_cache_hit_tokens,
      usage.prompt_tokens_details?.cached_tokens,
      usage.input_tokens_details?.cached_tokens
    )
    : null;
  const cacheWriteTokens = support === "reported" ? cacheCreationTokens(usage) : null;
  const inputTokens = rawInputTokens === null ? null : support === "reported" && !inclusivePromptTokens
    ? rawInputTokens + firstNumber(cacheReadTokens) + firstNumber(cacheWriteTokens)
    : rawInputTokens;
  const inputUncachedTokens = uncachedTokens(
    rawInputTokens,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
    support,
    inclusivePromptTokens
  );
  const fallbackTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  const reportedTotal = maybeNumber(usage.totalTokens, usage.total_tokens, fallbackTotal);
  const totalTokens = fallbackTotal !== null && reportedTotal !== null && reportedTotal < fallbackTotal ? null : reportedTotal;
  const normalized = {
    input: {
      totalTokens: inputTokens,
      uncachedTokens: inputUncachedTokens,
    },
    output: {
      totalTokens: outputTokens,
      reasoningTokens: reasoningTokens(usage),
    },
    cache: {
      readTokens: cacheReadTokens,
      writeTokens: cacheWriteTokens,
      missTokens: support === "reported" ? cacheMissTokens : null,
      hit: support === "reported" ? cacheReadTokens > 0 : null,
      created: support === "reported" ? cacheWriteTokens > 0 : null,
      hitRatio: ratio(cacheReadTokens, inputTokens, support),
      writeRatio: ratio(cacheWriteTokens, inputTokens, support),
      freshRatio: ratio(inputUncachedTokens, inputTokens, support),
      support,
    },
    totalTokens,
  };
  if (!hasObservedUsageTokens(normalized)) return null;
  const explicitCost = costTotalFromUsage(usage);
  const estimatedCost = costTotalFromRates(normalized, options.costRates);
  const costTotal = options.costRates ? estimatedCost : explicitCost;

  return {
    costTotal,
    ...normalized,
  };
}

export function flattenNormalizedUsage(normalized) {
  if (!normalized) return null;
  const flat = {
    inputTokens: normalized.input?.totalTokens ?? 0,
    ...(normalized.input?.uncachedTokens != null ? { inputUncachedTokens: normalized.input.uncachedTokens } : {}),
    outputTokens: normalized.output?.totalTokens ?? 0,
    cacheReadTokens: normalized.cache?.readTokens ?? 0,
    cacheWriteTokens: normalized.cache?.writeTokens ?? 0,
    totalTokens: normalized.totalTokens ?? 0,
    costTotal: normalized.costTotal ?? null,
    cacheHit: normalized.cache?.hit ?? false,
    cacheCreated: normalized.cache?.created ?? false,
  };
  if (normalized.cache?.missTokens != null) flat.cacheMissTokens = normalized.cache.missTokens;
  if (normalized.cache?.hitRatio != null) flat.cacheHitRatio = normalized.cache.hitRatio;
  if (normalized.cache?.writeRatio != null) flat.cacheWriteRatio = normalized.cache.writeRatio;
  if (normalized.cache?.freshRatio != null) flat.cacheFreshRatio = normalized.cache.freshRatio;
  return flat;
}

export function buildUsageDebugRecord({
  source,
  api = null,
  provider = null,
  modelId = null,
  usage,
  costRates = null,
} = {}) {
  const normalized = normalizeLlmUsage(usage, { costRates });
  if (!normalized) return null;

  return {
    source: source ?? null,
    api: api ?? null,
    provider: provider ?? null,
    modelId: modelId ?? null,
    ...flattenNormalizedUsage(normalized),
  };
}

export function logLlmUsage({
  logger = debugLog(),
  source,
  api = null,
  provider = null,
  modelId = null,
  usage,
  costRates = null,
} = {}) {
  const record = buildUsageDebugRecord({ source, api, provider, modelId, usage, costRates });
  if (!record || !logger || typeof logger.log !== "function") return record;

  try {
    logger.log("llm-usage", `model_usage ${JSON.stringify(record)}`);
  } catch {
    // Debug logging must never affect model calls.
  }

  return record;
}
