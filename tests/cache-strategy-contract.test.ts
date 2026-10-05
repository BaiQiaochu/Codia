import { describe, expect, it } from "vitest";
import {
  CACHE_STRATEGIES,
  buildCacheStrategyMetadata,
  normalizeCacheStrategy,
} from "../lib/llm/cache-strategy-contract.js";

describe("cache strategy contract", () => {
  it("accepts only explicit cache strategy names", () => {
    expect(normalizeCacheStrategy("session_snapshot")).toBe(CACHE_STRATEGIES.SESSION_SNAPSHOT);
    expect(normalizeCacheStrategy("utility_template")).toBe(CACHE_STRATEGIES.UTILITY_TEMPLATE);
    expect(normalizeCacheStrategy("cache_recovery")).toBe(CACHE_STRATEGIES.CACHE_RECOVERY);
    expect(() => normalizeCacheStrategy("cache_snapshot")).toThrow("unknown cache strategy");
    expect(() => normalizeCacheStrategy("")).toThrow("unknown cache strategy");
  });

  it("records strict session snapshot metadata separately from recovery", () => {
    const strict = buildCacheStrategyMetadata({
      cacheStrategy: "session_snapshot",
      cacheGroup: "compaction.history",
      templateVersion: "v1",
      cachePrefixHash: "b".repeat(64),
      parentCachePrefixHash: "a".repeat(64),
      strict: true,
    });
    expect(strict).toMatchObject({
      cacheStrategy: "session_snapshot",
      cacheGroup: "compaction.history",
      templateVersion: "v1",
      strict: true,
      cachePrefixHash: "b".repeat(64),
      parentCachePrefixHash: "a".repeat(64),
    });

    const recovery = buildCacheStrategyMetadata({
      cacheStrategy: "cache_recovery",
      cacheGroup: "compaction.history",
      templateVersion: "v1",
      strict: false,
      degradeReason: "zhipu_reasoning_replay_missing",
    });
    expect(recovery).toMatchObject({
      cacheStrategy: "cache_recovery",
      strict: false,
      degradeReason: "zhipu_reasoning_replay_missing",
    });
  });
});
