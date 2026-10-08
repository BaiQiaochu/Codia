import { describe, expect, it } from "vitest";
import {
  buildAnthropicModelsUrl,
  buildAnthropicMessagesUrl,
  normalizeProviderBaseUrl,
  shouldUseBearerAuth,
} from "../shared/provider-endpoints.ts";

describe("provider endpoint normalization", () => {
  it("projects bare Ollama OpenAI-compatible base URLs to the /v1 runtime API root", () => {
    expect(normalizeProviderBaseUrl({
      provider: "ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:51434",
    })).toBe("http://localhost:51434/v1");
  });

  it("does not duplicate /v1 for Ollama OpenAI-compatible base URLs", () => {
    expect(normalizeProviderBaseUrl({
      provider: "ollama",
      api: "openai-completions",
      baseUrl: "http://localhost:51434/v1/",
    })).toBe("http://localhost:51434/v1");
  });

  it("trims pasted base URLs before provider-specific normalization", () => {
    expect(normalizeProviderBaseUrl({
      provider: "openai",
      api: "openai-completions",
      baseUrl: "  https://api.example.com/v1/  ",
    })).toBe("https://api.example.com/v1");
  });

  it("projects bare OpenAI-compatible base URLs to the /v1 runtime API root", () => {
    expect(normalizeProviderBaseUrl({
      api: "openai-completions",
      baseUrl: "https://llm.example.com",
    })).toBe("https://llm.example.com/v1");
  });

  it("normalizes MiniMax Anthropic-compatible chat URLs without changing the regional host", () => {
    const base = normalizeProviderBaseUrl({
      provider: "minimax-token-plan",
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/v1",
    });

    expect(base).toBe("https://api.minimaxi.com/anthropic");
    expect(buildAnthropicMessagesUrl(base)).toBe("https://api.minimaxi.com/anthropic/v1/messages");
  });

  it("uses the MiniMax Anthropic model discovery path with Anthropic x-api-key auth", () => {
    expect(buildAnthropicModelsUrl("https://api.minimaxi.com/anthropic", {
      provider: "minimax-token-plan",
      api: "anthropic-messages",
    })).toBe("https://api.minimaxi.com/anthropic/v1/models?limit=1000");
    expect(shouldUseBearerAuth({
      provider: "minimax-token-plan",
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
    })).toBe(false);
  });

  it("keeps providerless MiniMax URLs on generic Anthropic-compatible auth", () => {
    const base = normalizeProviderBaseUrl({
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
    });

    expect(base).toBe("https://api.minimaxi.com/anthropic");
    expect(shouldUseBearerAuth({
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
    })).toBe(false);
  });

  it("uses Bearer auth for Kimi Coding Anthropic-compatible requests", () => {
    expect(shouldUseBearerAuth({
      provider: "kimi-coding",
      api: "anthropic-messages",
      baseUrl: "https://api.kimi.com/coding/",
    })).toBe(true);
  });
});
