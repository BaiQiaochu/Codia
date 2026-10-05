import { describe, expect, it } from "vitest";
import { normalizeProviderPayload } from "../../core/provider-compat.js";
import * as zhipu from "../../core/provider-compat/zhipu.js";

const zhipuModel = {
  id: "glm-5.1",
  provider: "zhipu",
  api: "openai-completions",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  reasoning: true,
  maxTokens: 131072,
};

describe("provider-compat/zhipu - matches", () => {
  it("matches official provider and BigModel OpenAI-compatible endpoints", () => {
    expect(zhipu.matches({ provider: "zhipu" })).toBe(true);
    expect(zhipu.matches({
      provider: "custom",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    })).toBe(true);
  });

  it("tolerates missing model fields", () => {
    expect(zhipu.matches(null)).toBe(false);
    expect(zhipu.matches(undefined)).toBe(false);
    expect(zhipu.matches({ provider: "custom" })).toBe(false);
  });
});

describe("provider-compat/zhipu - apply", () => {
  it("chat thinking mode restores reasoning_content for assistant tool-call history", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "查一下最新资料" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to search first.", thinkingSignature: "reasoning_content" },
          ],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
        { role: "tool", tool_call_id: "call_1", content: "search result" },
      ],
      tools: [{ type: "function", function: { name: "web_search" } }],
    };

    const result = normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result.thinking).toEqual({ type: "enabled", clear_thinking: false });
    expect(result.messages[1]).toMatchObject({
      content: "",
      reasoning_content: "Need to search first.",
    });
    expect(payload.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("chat thinking mode fails closed when tool-call history lost reasoning_content", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "查一下最新资料" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      tools: [{ type: "function", function: { name: "web_search" } }],
    };

    expect(() => normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "high",
    })).toThrow(/Zhipu.*reasoning_content.*tool_calls/);
  });

  it("chat thinking mode can clear unreplayable historical reasoning for recovery requests", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "continue" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "stale thinking",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      enable_thinking: true,
    };

    const result = normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "high",
      reasoningReplay: "clear",
    });

    expect(result.thinking).toEqual({ type: "enabled", clear_thinking: true });
    expect(result.messages[1].content).toBe("");
    expect(result.messages[1]).not.toHaveProperty("reasoning_content");
    expect(result).not.toHaveProperty("enable_thinking");
  });

  it("chat thinking off disables GLM thinking and strips stale reasoning_content", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        { role: "user", content: "继续" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "previous thinking",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, zhipuModel, {
      mode: "chat",
      reasoningLevel: "off",
    });

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[1]).not.toHaveProperty("reasoning_content");
  });

  it("utility mode disables GLM thinking and strips stale reasoning_content", () => {
    const payload = {
      model: "glm-5.1",
      messages: [
        {
          role: "assistant",
          content: "",
          reasoning_content: "previous thinking",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "web_search", arguments: "{}" },
          }],
        },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(payload, zhipuModel, { mode: "utility" });

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });
});
