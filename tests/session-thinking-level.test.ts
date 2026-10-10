import { describe, expect, it } from "vitest";

import {
  modelSupportsAnthropicMaxEffort,
  modelSupportsXhigh,
  normalizePiSdkThinkingLevel,
  normalizeRequestThinkingLevel,
  normalizeSessionThinkingLevel,
  normalizeThinkingLevelForModel,
} from "../core/session-thinking-level.js";

describe("session thinking level capabilities", () => {
  it("canonicalizes legacy auto to medium at runtime boundaries", () => {
    expect(normalizeSessionThinkingLevel("auto")).toBe("medium");
    expect(normalizeSessionThinkingLevel("AUTO")).toBe("medium");
    expect(normalizeSessionThinkingLevel("bad-value")).toBe("medium");
    expect(normalizeRequestThinkingLevel("auto", "off")).toBe("medium");
    expect(normalizeRequestThinkingLevel("bad-value", "auto")).toBe("medium");
    expect(normalizeRequestThinkingLevel("bad-value", "off")).toBe("off");
  });

  it("preserves max for Pi SDK 1.1 at the SDK boundary", () => {
    expect(normalizePiSdkThinkingLevel("max")).toBe("max");
    expect(normalizePiSdkThinkingLevel("xhigh")).toBe("xhigh");
    expect(normalizePiSdkThinkingLevel("auto")).toBe("medium");
  });

  it("shows the unified Max level for GPT-5.5", () => {
    const model = { id: "gpt-5.5", provider: "openai", reasoning: true };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });

  it("shows the unified Max level for the GPT-5 family", () => {
    const models = [
      { id: "gpt-5", provider: "openai", reasoning: true },
      { id: "gpt-5.1-codex", provider: "openai", reasoning: true },
      { id: "openai/gpt-5.2-codex", provider: "openrouter", reasoning: true },
      { id: "GPT5.5", provider: "gppt", reasoning: true },
      { id: "gppt / gpt 5.5", provider: "gppt", reasoning: true },
    ];

    for (const model of models) {
      expect(modelSupportsXhigh(model)).toBe(true);
      expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
    }
  });

  it("uses GPT display names when a provider exposes a generic model id", () => {
    const models = [
      { id: "chat-model-1", name: "GPT-5.5", provider: "gppt", reasoning: true },
      { id: "default", displayName: "gppt / gpt 5.5", provider: "relay", reasoning: true },
    ];

    for (const model of models) {
      expect(modelSupportsXhigh(model)).toBe(true);
      expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
    }
  });

  it("shows the unified Max level for Claude models with Anthropic max effort", () => {
    const models = [
      { id: "claude-opus-4-7", provider: "anthropic", reasoning: true },
      { id: "claude-opus-4-6", provider: "anthropic", reasoning: true },
      { id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true },
      { id: "claude-fable-5", provider: "anthropic", api: "anthropic-messages", reasoning: true },
      { id: "claude-mythos-5", provider: "anthropic", api: "anthropic-messages", reasoning: true },
      { id: "anthropic/claude-opus-4-7", provider: "vercel-ai-gateway", api: "anthropic-messages", reasoning: true },
    ];

    for (const model of models) {
      expect(modelSupportsXhigh(model)).toBe(true);
      expect(modelSupportsAnthropicMaxEffort(model)).toBe(true);
      expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
    }
  });

  it("does not infer Anthropic max effort for non-Anthropic wire formats by model name alone", () => {
    const model = {
      id: "anthropic/claude-opus-4-7",
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    };

    expect(modelSupportsAnthropicMaxEffort(model)).toBe(false);
  });

  it("allows unified Max for OpenRouter Claude adaptive-only models without Anthropic max effort", () => {
    const model = {
      id: "anthropic/claude-fable-5",
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    };

    expect(modelSupportsXhigh(model)).toBe(true);
    expect(modelSupportsAnthropicMaxEffort(model)).toBe(false);
    expect(normalizeThinkingLevelForModel("xhigh", model)).toBe("xhigh");
  });
});
