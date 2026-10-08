import { describe, expect, it } from "vitest";

import { normalizeProviderPayload } from "../../core/provider-compat.ts";
import * as agnes from "../../core/provider-compat/agnes.ts";

const AGNES_MODEL = {
  provider: "agnes",
  id: "agnes-2.0-flash",
  api: "openai-completions",
  baseUrl: "https://apihub.agnes-ai.com/v1",
  reasoning: false,
};

describe("provider-compat/agnes", () => {
  it("matches only Agnes provider models and official Agnes base URLs", () => {
    expect(agnes.matches(null)).toBe(false);
    expect(agnes.matches({ provider: "agnes", id: "agnes-2.0-flash" })).toBe(true);
    expect(agnes.matches({ provider: "custom", baseUrl: "https://apihub.agnes-ai.com/v1" })).toBe(true);
    expect(agnes.matches({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).toBe(false);
  });

  it("strips stale thinking controls in chat mode without mutating the payload", () => {
    const payload = {
      model: "agnes-2.0-flash",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      thinking: { type: "enabled" },
      reasoning: { effort: "high" },
    };

    const result = normalizeProviderPayload(payload, AGNES_MODEL, { mode: "chat", reasoningLevel: "high" });

    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("reasoning");
    expect(payload).toHaveProperty("reasoning_effort", "high");
    expect(payload).toHaveProperty("thinking");
    expect(payload).toHaveProperty("reasoning");
  });

  it("strips replayed reasoning_content from utility calls", () => {
    const payload = {
      model: "agnes-2.0-flash",
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private scratch" },
      ],
      reasoning_effort: "medium",
    };

    const result = normalizeProviderPayload(payload, AGNES_MODEL, { mode: "utility", reasoningLevel: "medium" });

    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
    expect(payload.messages[0]).toHaveProperty("reasoning_content", "private scratch");
  });
});
