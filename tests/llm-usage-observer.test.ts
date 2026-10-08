// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import {
  buildUsageDebugRecord,
  logLlmUsage,
  normalizeLlmUsage,
} from "../lib/llm/usage-observer.js";

describe("LLM usage observer", () => {
  it("normalizes Pi SDK usage and marks cache hits", () => {
    const usage = normalizeLlmUsage({
      input: 1200,
      output: 300,
      cacheRead: 900,
      cacheWrite: 150,
      totalTokens: 2550,
      cost: { total: 0.042 },
    });

    expect(usage).toEqual({
      input: { totalTokens: 2250, uncachedTokens: 1200 },
      output: { totalTokens: 300, reasoningTokens: null },
      cache: {
        readTokens: 900,
        writeTokens: 150,
        missTokens: null,
        hit: true,
        created: true,
        hitRatio: 0.4,
        writeRatio: 150 / 2250,
        freshRatio: 1200 / 2250,
        support: "reported",
      },
      totalTokens: 2550,
      costTotal: 0.042,
    });
  });

  it("normalizes Anthropic raw usage fields", () => {
    const usage = normalizeLlmUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 40,
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 220, uncachedTokens: 100 },
      output: { totalTokens: 20, reasoningTokens: null },
      cache: {
        readTokens: 80,
        writeTokens: 40,
        hit: true,
        created: true,
        hitRatio: 80 / 220,
        writeRatio: 40 / 220,
        freshRatio: 100 / 220,
        support: "reported",
      },
      totalTokens: 240,
    });
  });

  it("normalizes OpenAI-compatible usage with cached prompt token details", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 250,
      completion_tokens: 50,
      total_tokens: 300,
      prompt_tokens_details: { cached_tokens: 180 },
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 250, uncachedTokens: 70 },
      output: { totalTokens: 50, reasoningTokens: null },
      cache: {
        readTokens: 180,
        writeTokens: 0,
        hit: true,
        created: false,
        hitRatio: 0.72,
        writeRatio: 0,
        freshRatio: 0.28,
        support: "reported",
      },
      totalTokens: 300,
    });
  });

  it("normalizes DeepSeek cache hit and miss token fields", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 1000,
      completion_tokens: 120,
      total_tokens: 1120,
      prompt_cache_hit_tokens: 720,
      prompt_cache_miss_tokens: 280,
    });

    expect(usage).toMatchObject({
      input: { totalTokens: 1000, uncachedTokens: 280 },
      output: { totalTokens: 120, reasoningTokens: null },
      cache: {
        readTokens: 720,
        writeTokens: 0,
        missTokens: 280,
        hit: true,
        created: false,
        hitRatio: 0.72,
        writeRatio: 0,
        freshRatio: 0.28,
        support: "reported",
      },
      totalTokens: 1120,
    });
  });

  it("preserves unknown cache support instead of treating it as zero", () => {
    const usage = normalizeLlmUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
    }, { cacheSupport: "not_reported" });

    expect(usage).toMatchObject({
      input: { totalTokens: 10, uncachedTokens: null },
      output: { totalTokens: 5, reasoningTokens: null },
      cache: {
        readTokens: null,
        writeTokens: null,
        missTokens: null,
        hit: null,
        created: null,
        hitRatio: null,
        writeRatio: null,
        freshRatio: null,
        support: "not_reported",
      },
      totalTokens: 15,
    });
  });

  it("builds a structured debug record without request content", () => {
    const record = buildUsageDebugRecord({
      source: "utility",
      api: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 0,
      },
    });

    expect(record).toEqual({
      source: "utility",
      api: "anthropic-messages",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      inputTokens: 180,
      inputUncachedTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      totalTokens: 200,
      costTotal: null,
      cacheHit: true,
      cacheCreated: false,
      cacheHitRatio: 80 / 180,
      cacheWriteRatio: 0,
      cacheFreshRatio: 100 / 180,
    });
  });

  it("writes model usage as one structured debug log line", () => {
    const logger = { log: vi.fn() };

    logLlmUsage({
      logger,
      source: "chat",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      usage: { input: 10, output: 2, cacheRead: 8, cacheWrite: 0 },
    });

    expect(logger.log).toHaveBeenCalledWith(
      "llm-usage",
      "model_usage {\"source\":\"chat\",\"api\":null,\"provider\":\"anthropic\",\"modelId\":\"claude-opus-4-5\",\"inputTokens\":18,\"inputUncachedTokens\":10,\"outputTokens\":2,\"cacheReadTokens\":8,\"cacheWriteTokens\":0,\"totalTokens\":20,\"costTotal\":null,\"cacheHit\":true,\"cacheCreated\":false,\"cacheHitRatio\":0.4444444444444444,\"cacheWriteRatio\":0,\"cacheFreshRatio\":0.5555555555555556}"
    );
  });
});
