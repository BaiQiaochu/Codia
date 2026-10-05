import { describe, expect, it } from "vitest";
import { getProviderPromptPatches } from "../core/provider-prompt-patches.js";

describe("getProviderPromptPatches", () => {
  it("adds the DeepSeek reasoning output contract for v4 reasoning models", () => {
    const patches = getProviderPromptPatches(
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true },
      { reasoningLevel: "medium", locale: "zh-CN" },
    );

    expect(patches).toHaveLength(1);
    expect(patches[0]).toContain("DeepSeek reasoning model");
    expect(patches[0]).toContain("final assistant message");
  });

  it("returns no patch when reasoning is disabled", () => {
    const patches = getProviderPromptPatches(
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true },
      { reasoningLevel: "off", locale: "zh-CN" },
    );

    expect(patches).toEqual([]);
  });

  it("returns no patch for non-DeepSeek models", () => {
    const patches = getProviderPromptPatches(
      { id: "gpt-4o", provider: "openai" },
      { reasoningLevel: "medium", locale: "zh-CN" },
    );

    expect(patches).toEqual([]);
  });
});
