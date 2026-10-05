import { describe, expect, it } from "vitest";
import {
  getThinkingFormat,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";

const volcengineModel = {
  id: "doubao-seed-2-0-pro-260215",
  provider: "volcengine",
  api: "openai-completions",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  reasoning: true,
};

describe("provider-compat/volcengine", () => {
  it("declares the Volcengine thinking contract", () => {
    expect(getThinkingFormat(volcengineModel)).toBe("volcengine");
    expect(getThinkingFormat({
      ...volcengineModel,
      provider: "custom",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    })).toBe("volcengine");
  });

  it("enables thinking while mapping unsupported max effort to high", () => {
    const result = normalizeProviderPayload({
      model: "doubao-seed-2-0-pro-260215",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "max",
    }, volcengineModel, {
      mode: "chat",
      reasoningLevel: "max",
    });

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.reasoning_effort).toBe("high");
  });

  it("does not treat omitted reasoning level as off for reasoning models", () => {
    const result = normalizeProviderPayload({
      model: "doubao-seed-2-0-pro-260215",
      messages: [{ role: "user", content: "hi" }],
    }, volcengineModel, { mode: "chat" });

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("disables thinking and strips stale reasoning history for utility requests", () => {
    const result = normalizeProviderPayload({
      model: "doubao-seed-2-0-pro-260215",
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private" },
        { role: "user", content: "summarize" },
      ],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    }, volcengineModel, { mode: "utility" });

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });
});
