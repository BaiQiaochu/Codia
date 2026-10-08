import { describe, expect, it } from "vitest";
import { estimatePreparationTokens, truncateTextHeadTail } from "../core/compaction-utils.js";

describe("compaction utils", () => {
  it("truncates long text with head and tail preserved", () => {
    const text = "a".repeat(200);
    const result = truncateTextHeadTail(text, {
      maxBytes: 60,
      headBytes: 20,
      tailBytes: 20,
    });
    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(200);
    expect(result.text.startsWith("a".repeat(20))).toBe(true);
    expect(result.text.endsWith("a".repeat(20))).toBe(true);
    expect(result.text).toContain("omitted");
  });

  it("estimates split-turn compaction by worst single LLM call", () => {
    const preparation = {
      messagesToSummarize: [
        { role: "user", content: "short" },
      ],
      isSplitTurn: true,
      turnPrefixMessages: [
        { role: "toolResult", content: "x".repeat(1000) },
      ],
    };
    expect(estimatePreparationTokens(preparation)).toBeGreaterThan(estimatePreparationTokens({
      messagesToSummarize: preparation.messagesToSummarize,
    }));
  });
});
