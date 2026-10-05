import { describe, expect, it, vi } from "vitest";

import { callTextWithLengthContract } from "../core/output-length-contract.ts";

describe("output length contract", () => {
  it("repairs overlong text with the same request config and no output cap", async () => {
    const callText = vi.fn()
      .mockResolvedValueOnce("This is a clearly overlong summary that goes far beyond the target length and needs another pass.")
      .mockResolvedValueOnce("Short summary");

    const result = await callTextWithLengthContract({
      callText,
      request: {
        api: "openai",
        model: "utility",
        apiKey: "key",
        baseUrl: "https://example.test",
        messages: [{ role: "user", content: "summarize" }],
        temperature: 0.3,
        maxTokens: 10,
        outputBudgetSource: "system",
      },
      contract: {
        label: "test summary",
        target: 2,
        unit: "words",
        min: 1,
        max: 3,
      },
    });

    expect(result.text).toBe("Short summary");
    expect(callText).toHaveBeenCalledTimes(2);
    expect(callText.mock.calls[0][0]).not.toHaveProperty("maxTokens");
    expect(callText.mock.calls[0][0]).not.toHaveProperty("outputBudgetSource");
    expect(callText.mock.calls[1][0]).toMatchObject({
      api: "openai",
      model: "utility",
      apiKey: "key",
      baseUrl: "https://example.test",
      temperature: 0.3,
    });
    expect(callText.mock.calls[1][0]).not.toHaveProperty("maxTokens");
    expect(callText.mock.calls[1][0].messages.at(-1).content).toContain("target length");
  });

  it("returns the closest candidate instead of truncating when repairs miss the range", async () => {
    const longest = "This answer is much too long and keeps adding detail after detail after detail.";
    const closest = "Still slightly long";
    const callText = vi.fn()
      .mockResolvedValueOnce(longest)
      .mockResolvedValueOnce("This repaired answer is still too verbose")
      .mockResolvedValueOnce(closest);

    const result = await callTextWithLengthContract({
      callText,
      request: {
        messages: [{ role: "user", content: "summarize" }],
        max_tokens: 5,
        max_completion_tokens: 5,
      },
      contract: {
        label: "test summary",
        target: 2,
        unit: "words",
        min: 1,
        max: 2,
        maxRepairAttempts: 2,
      },
    });

    expect(result.text).toBe(closest);
    expect(result.text).not.toBe(closest.slice(0, 2));
    expect(callText).toHaveBeenCalledTimes(3);
    for (const [request] of callText.mock.calls) {
      expect(request).not.toHaveProperty("max_tokens");
      expect(request).not.toHaveProperty("max_completion_tokens");
    }
  });
});
