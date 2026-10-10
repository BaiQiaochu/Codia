import { describe, expect, it } from "vitest";
import { enrichModelFromKnownMetadata } from "../core/model-known-enrichment.js";

describe("enrichModelFromKnownMetadata", () => {
  it("adds Codia metadata to Pi built-in Kimi models without dropping request headers", () => {
    const model = {
      id: "kimi-for-coding",
      name: "Kimi For Coding",
      api: "anthropic-messages",
      provider: "kimi-coding",
      baseUrl: "https://api.kimi.com/coding",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 32768,
    };

    const enriched = enrichModelFromKnownMetadata(model);

    expect(enriched.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
    expect(enriched.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
    });
  });

  it("projects verified thinking levels for current models into runtime metadata", () => {
    const enriched = enrichModelFromKnownMetadata({
      id: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 128000,
    });

    expect(enriched.thinkingLevels).toEqual(["low", "medium", "high", "max"]);
    expect(enriched.xhigh).toBe(true);
  });
});
