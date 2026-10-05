// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildFreshCompactMetaPatch,
  buildFreshCompactSnapshot,
  getFreshCompactDate,
  shouldRunFreshCompact,
} from "../lib/fresh-compact/policy.js";

describe("fresh compact policy", () => {
  it("uses the shared logical day boundary", () => {
    expect(getFreshCompactDate(new Date(2026, 4, 15, 3, 30))).toBe("2026-05-14");
    expect(getFreshCompactDate(new Date(2026, 4, 15, 4, 0))).toBe("2026-05-15");
  });

  it("requests daily fresh compact when the stored date is stale", () => {
    expect(shouldRunFreshCompact({
      meta: { lastFreshCompactDate: "2026-05-14" },
      now: new Date(2026, 4, 15, 9, 0),
    })).toEqual({ run: true, reason: "daily" });
  });

  it("does not run when the logical date is current", () => {
    expect(shouldRunFreshCompact({
      meta: { lastFreshCompactDate: "2026-05-15" },
      now: new Date(2026, 4, 15, 9, 0),
    })).toEqual({ run: false, reason: null });
  });

  it("builds stable metadata patches", () => {
    const snapshot = buildFreshCompactSnapshot({
      systemPrompt: "system",
      state: { b: 2, a: 1 },
    });

    expect(buildFreshCompactMetaPatch({
      snapshot,
      reason: "manual",
      now: new Date("2026-05-15T09:00:00.000Z"),
      usage: { tokensBefore: 1000, tokensAfter: 400, contextWindow: 128000 },
    })).toMatchObject({
      lastFreshCompactDate: "2026-05-15",
      lastFreshCompactedAt: "2026-05-15T09:00:00.000Z",
      freshCompactPromptHash: snapshot.promptHash,
      freshCompactStateHash: snapshot.stateHash,
      freshCompactReason: "manual",
      freshCompactTokensBefore: 1000,
      freshCompactTokensAfter: 400,
      freshCompactContextWindow: 128000,
    });
  });
});
