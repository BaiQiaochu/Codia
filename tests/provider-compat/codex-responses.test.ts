import { describe, expect, it } from "vitest";

import { normalizeProviderPayload } from "../../core/provider-compat.ts";
import * as codexResponses from "../../core/provider-compat/codex-responses.ts";

const CODEX_MODEL = {
  id: "gpt-5.5",
  provider: "openai-codex-oauth",
  api: "openai-codex-responses",
};

describe("provider-compat/codex-responses", () => {
  it("matches only Codex Responses API models", () => {
    expect(codexResponses.matches(null)).toBe(false);
    expect(codexResponses.matches(CODEX_MODEL)).toBe(true);
    expect(codexResponses.matches({
      id: "gpt-5.5",
      provider: "openai-codex",
      api: "openai-codex-responses",
    })).toBe(true);
    expect(codexResponses.matches({
      id: "gpt-5.5",
      provider: "openai-codex-oauth",
      api: "openai-responses",
    })).toBe(false);
    expect(codexResponses.matches({
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-codex-responses",
    })).toBe(false);
  });

  it("strips unsupported Codex Responses request fields without mutating payload", () => {
    const payload = {
      model: "gpt-5.5",
      store: false,
      stream: true,
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 1000,
      max_completion_tokens: 1000,
      max_tokens: 1000,
      maxOutputTokens: 1000,
      temperature: 0,
    };

    const result = normalizeProviderPayload(payload, CODEX_MODEL, { mode: "utility" });

    expect(result).not.toBe(payload);
    expect(result).toMatchObject({
      model: "gpt-5.5",
      store: false,
      stream: true,
      input: [{ role: "user", content: "hi" }],
    });
    expect(result).not.toHaveProperty("max_output_tokens");
    expect(result).not.toHaveProperty("max_completion_tokens");
    expect(result).not.toHaveProperty("max_tokens");
    expect(result).not.toHaveProperty("maxOutputTokens");
    expect(result).not.toHaveProperty("temperature");
    expect(payload).toHaveProperty("max_output_tokens", 1000);
    expect(payload).toHaveProperty("temperature", 0);
  });

  it("does not strip the same fields for non-Codex providers", () => {
    const payload = {
      model: "gpt-5",
      input: [{ role: "user", content: "hi" }],
      max_output_tokens: 1000,
      max_completion_tokens: 1000,
      max_tokens: 1000,
      maxOutputTokens: 1000,
      temperature: 0,
    };

    const result = normalizeProviderPayload(payload, {
      id: "gpt-5",
      provider: "openai",
      api: "openai-responses",
    }, { mode: "utility" });

    expect(result).toBe(payload);
    expect(result).toMatchObject({
      max_output_tokens: 1000,
      max_completion_tokens: 1000,
      max_tokens: 1000,
      maxOutputTokens: 1000,
      temperature: 0,
    });
  });
});
