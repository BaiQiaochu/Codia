import { describe, expect, it } from "vitest";
import {
  getModelContextWindow,
  getSafeMaxOutputTokens,
  getSafeSessionTokenSettings,
} from "../core/model-token-limits.js";

describe("model token limits", () => {
  it("keeps MiniMax context window while clamping output tokens", () => {
    const model = {
      id: "MiniMax-M2.7",
      provider: "minimax",
      contextWindow: 204800,
      maxTokens: 204800,
    };

    expect(getModelContextWindow(model)).toBe(204800);
    expect(getSafeMaxOutputTokens(model)).toBe(1024);
    expect(getSafeSessionTokenSettings(model)).toEqual({
      reserveTokens: 1024,
      keepRecentTokens: 20000,
    });
  });
});
