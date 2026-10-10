import { describe, expect, it } from "vitest";
import {
  getReasoningProfile,
  getThinkingFormat,
  isAnthropicModel,
  isDeepSeekModel,
  normalizeProviderContextMessages,
  normalizeProviderPayload,
} from "../core/provider-compat.js";

describe("provider compat", () => {
  it("detects only DeepSeek provider/baseUrl as DeepSeek", () => {
    expect(isDeepSeekModel({ provider: "deepseek" })).toBe(true);
    expect(isDeepSeekModel({ baseUrl: "https://api.deepseek.com/v1" })).toBe(true);
    expect(isDeepSeekModel({ provider: "openrouter", id: "deepseek/deepseek-v3.2" })).toBe(false);
  });

  it("uses declared thinking format and projected qwen quirks", () => {
    expect(getThinkingFormat({ compat: { thinkingFormat: "anthropic" } })).toBe("anthropic");
    expect(getThinkingFormat({ quirks: ["enable_thinking"] })).toBe("qwen");
  });

  it("derives OpenRouter thinking format for OpenRouter-hosted reasoning models", () => {
    expect(getThinkingFormat({
      id: "deepseek/deepseek-v3.2",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    })).toBe("openrouter");

    expect(getThinkingFormat({
      id: "xiaomi/mimo-v2-flash",
      provider: "relay",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      compat: { supportsDeveloperRole: false },
    })).toBe("openrouter");
  });

  it("detects Anthropic models from provider and thinking format", () => {
    expect(isAnthropicModel({ provider: "anthropic" })).toBe(true);
    expect(isAnthropicModel({ compat: { thinkingFormat: "anthropic" } })).toBe(true);
    expect(isAnthropicModel({ provider: "openai" })).toBe(false);
  });

  it("maps xhigh to Anthropic max effort and lifts Pi's implicit output cap", () => {
    const result = normalizeProviderPayload({
      model: "claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
      max_tokens: 42666,
    }, {
      id: "claude-opus-4-7",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 128000,
    }, { mode: "chat", reasoningLevel: "xhigh" });

    expect(result.output_config).toEqual({ effort: "max" });
    expect(result.max_tokens).toBe(64000);
  });

  it("derives adaptive-only Anthropic reasoning for Claude Fable and Mythos", () => {
    for (const id of ["claude-fable-5", "claude-mythos-5"]) {
      expect(getReasoningProfile({
        id,
        provider: "anthropic",
        api: "anthropic-messages",
        reasoning: true,
      })).toBe("anthropic-adaptive-only");
    }
  });

  it("normalizes Claude adaptive-only Anthropic payloads", () => {
    const result = normalizeProviderPayload({
      model: "claude-fable-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", display: "full" },
      reasoning_effort: "high",
      max_tokens: 42666,
    }, {
      id: "claude-fable-5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 128000,
    }, { mode: "chat", reasoningLevel: "xhigh" });

    expect(result.thinking).toEqual({ type: "adaptive", display: "full" });
    expect(result.output_config).toEqual({ effort: "max" });
    expect(result.max_tokens).toBe(64000);
    expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("rejects disabled thinking for Claude adaptive-only Anthropic payloads", () => {
    expect(() => normalizeProviderPayload({
      model: "claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    }, {
      id: "claude-mythos-5",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "high" })).toThrow(/does not support disabling adaptive thinking/);
  });

  it("normalizes OpenRouter-hosted Claude adaptive-only payloads", () => {
    expect(getReasoningProfile({
      id: "anthropic/claude-fable-5",
      provider: "openrouter",
      api: "openai-completions",
      reasoning: true,
    })).toBe("openrouter-anthropic-adaptive");

    const result = normalizeProviderPayload({
      model: "anthropic/claude-fable-5",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      reasoning_effort: "high",
      reasoning: { effort: "high", max_tokens: 1024 },
    }, {
      id: "anthropic/claude-fable-5",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "xhigh" });

    expect(result.verbosity).toBe("max");
    expect(result.reasoning).toEqual({ enabled: true });
    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("reasoning_effort");
  });

  it("rejects disabled thinking for OpenRouter-hosted Claude adaptive-only payloads", () => {
    expect(() => normalizeProviderPayload({
      model: "anthropic/claude-mythos-5",
      messages: [{ role: "user", content: "hi" }],
    }, {
      id: "anthropic/claude-mythos-5",
      provider: "openrouter",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "off" })).toThrow(/does not support disabling adaptive thinking/);
  });

  it("does not overwrite explicit non-default Anthropic output caps", () => {
    const result = normalizeProviderPayload({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
      max_tokens: 12000,
    }, {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      api: "anthropic-messages",
      reasoning: true,
      maxTokens: 64000,
    }, { mode: "chat", reasoningLevel: "xhigh" });

    expect(result.output_config).toEqual({ effort: "max" });
    expect(result.max_tokens).toBe(12000);
  });

  it("projects DeepSeek v4 Anthropic reasoning profile from the upstream model shape", () => {
    expect(getReasoningProfile({
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      reasoning: true,
    })).toBe("deepseek-v4-anthropic");
  });

  it("strips empty tools without mutating the original payload", () => {
    const payload = {
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const result = normalizeProviderPayload(payload, { provider: "dashscope" });
    expect(result).not.toHaveProperty("tools");
    expect(payload.tools).toEqual([]);
  });

  it("normalizes outbound provider message roles to lowercase without mutating the original payload", () => {
    const payload = {
      model: "gpt-5.5",
      input: [
        { role: "User", content: "hi" },
        { role: "Assistant", content: "hello" },
      ],
      messages: [
        { role: "System", content: "rules" },
        { role: "Developer", content: "dev rules" },
        {
          role: "Assistant",
          content: "",
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          }],
        },
        { role: "Tool", tool_call_id: "call_1", content: "tool result" },
      ],
    };

    const result = normalizeProviderPayload(
      payload,
      { id: "gpt-5.5", provider: "openai", api: "openai-responses" },
      { mode: "chat" },
    );

    expect(result).not.toBe(payload);
    expect(result.input.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.messages.map((message) => message.role)).toEqual(["system", "developer", "assistant", "tool"]);
    expect(payload.input.map((message) => message.role)).toEqual(["User", "Assistant"]);
    expect(payload.messages.map((message) => message.role)).toEqual(["System", "Developer", "Assistant", "Tool"]);
  });

  it("removes disabled reasoning_effort from GPT-5.5 OpenAI-compatible chat payloads", () => {
    const payload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "none",
    };

    const result = normalizeProviderPayload(payload, {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-completions",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "none" });

    expect(result).not.toBe(payload);
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(payload.reasoning_effort).toBe("none");
  });

  it("normalizes legacy auto reasoning_effort before provider-specific compat runs", () => {
    const payload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "auto",
    };

    const result = normalizeProviderPayload(payload, {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-completions",
      reasoning: true,
    }, { mode: "chat", reasoningLevel: "auto" });

    expect(result.reasoning_effort).toBe("medium");
    expect(payload.reasoning_effort).toBe("auto");
  });

  it("forces qwen-style utility calls to disable thinking", () => {
    const result = normalizeProviderPayload(
      { model: "qwen3.5-plus", messages: [{ role: "user", content: "hi" }] },
      { id: "qwen3.5-plus", provider: "dashscope", quirks: ["enable_thinking"] },
      { mode: "utility" },
    );
    expect(result.enable_thinking).toBe(false);
  });

  it("keeps qwen3.6-27b chat requests fast by disabling default medium thinking", () => {
    const result = normalizeProviderPayload(
      {
        model: "qwen3.6-27b",
        messages: [{ role: "user", content: "hi" }],
        enable_thinking: true,
      },
      {
        id: "qwen3.6-27b",
        provider: "dashscope",
        reasoning: true,
        quirks: ["enable_thinking"],
      },
      { mode: "chat", reasoningLevel: "medium" },
    );

    expect(result.enable_thinking).toBe(false);
  });

  it("disables qwen thinking for selected skill invocations even when high thinking is selected", () => {
    const result = normalizeProviderPayload(
      {
        model: "qwen3.6-27b",
        messages: [
          {
            role: "user",
            content: "<selected-skills>\n- karpathy-guidelines\n</selected-skills>\nFix this bug.",
          },
        ],
        enable_thinking: true,
      },
      {
        id: "qwen3.6-27b",
        provider: "dashscope",
        reasoning: true,
        quirks: ["enable_thinking"],
      },
      { mode: "chat", reasoningLevel: "high" },
    );

    expect(result.enable_thinking).toBe(false);
  });

  it("normalizes DeepSeek chat thinking payload", () => {
    const result = normalizeProviderPayload(
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        reasoning_effort: "xhigh",
        max_completion_tokens: 32000,
      },
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true, maxTokens: 384000 },
      { mode: "chat", reasoningLevel: "xhigh" },
    );
    expect(result).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      max_tokens: 131072,
    });
    expect(result).not.toHaveProperty("max_completion_tokens");
  });

  it("injects the debranded DeepSeek roleplay reasoning marker only when explicitly enabled", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(
      payload,
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true, maxTokens: 384000 },
      {
        mode: "chat",
        reasoningLevel: "high",
        locale: "en",
        deepseekRoleplayReasoningPatch: true,
        deepseekRoleplayReasoningContext: {
          agentName: "Codia",
          agentDescription: "Project assistant.",
        },
      },
    );

    expect(result.messages[0].content).toContain("[Role immersion instruction]");
    expect(result.messages[0].content).toContain("Current agent: Codia");
    expect(result.messages[0].content).toContain("Roster description: Project assistant.");
    expect(payload.messages[0].content).toBe("hello");
  });

  it("preserves empty DeepSeek reasoning_content for tool-call history", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "what time" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "should not overwrite" }],
          reasoning_content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
      ],
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(
      payload,
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true, maxTokens: 384000 },
      { mode: "chat", reasoningLevel: "high" },
    );

    expect(result.messages[1].reasoning_content).toBe("");
    expect(result.messages[1].content).toBe("");
  });

  it("normalizes DeepSeek assistant tool-call content and removes unsupported tool_choice", () => {
    const payload = {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "what time" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "Need date tool.",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "date", arguments: "{}" } }],
        },
      ],
      tools: [{ type: "function", function: { name: "date" } }],
      tool_choice: "auto",
      reasoning_effort: "high",
    };

    const result = normalizeProviderPayload(
      payload,
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true, maxTokens: 384000 },
      { mode: "chat", reasoningLevel: "high" },
    );

    expect(result.messages[1].content).toBe("");
    expect(result.messages[1].reasoning_content).toBe("Need date tool.");
    expect(result).not.toHaveProperty("tool_choice");
    expect(payload.messages[1].content).toBeNull();
    expect(payload.tool_choice).toBe("auto");
  });

  it("maps unified medium reasoning to DeepSeek low effort", () => {
    const result = normalizeProviderPayload(
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        max_completion_tokens: 8192,
      },
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true, maxTokens: 65536 },
      { mode: "chat", reasoningLevel: "medium" },
    );

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.reasoning_effort).toBe("low");
    expect(result.max_tokens).toBe(65536);
    expect(result).not.toHaveProperty("max_completion_tokens");
  });

  it("uses DeepSeek low effort for unified medium reasoning", () => {
    const result = normalizeProviderPayload(
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 65536,
      },
      { id: "deepseek-v4-pro", provider: "deepseek", reasoning: true, maxTokens: 65536 },
      { mode: "chat", reasoningLevel: "medium" },
    );

    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result.reasoning_effort).toBe("low");
    expect(result.max_tokens).toBe(65536);
  });

  it("disables DeepSeek thinking on utility calls without expanding max_tokens", () => {
    const result = normalizeProviderPayload(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 80,
      },
      { id: "deepseek-v4-flash", provider: "deepseek", reasoning: true, maxTokens: 384000 },
      { mode: "utility" },
    );
    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.max_tokens).toBe(80);
  });

  it("treats exact DeepSeek V4 id as a thinking model", () => {
    const result = normalizeProviderPayload(
      {
        model: "deepseek-v4",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 80,
      },
      { id: "deepseek-v4", provider: "deepseek" },
      { mode: "utility" },
    );

    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.max_tokens).toBe(80);
  });

  it("normalizes DeepSeek v4 Anthropic payload without leaking OpenAI reasoning_effort", () => {
    const result = normalizeProviderPayload(
      {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
        thinking: { type: "enabled", budget_tokens: 8192, display: "summarized" },
        reasoning_effort: "high",
        max_tokens: 32000,
      },
      {
        id: "deepseek-v4-pro",
        provider: "deepseek",
        api: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
        reasoning: true,
        compat: { thinkingFormat: "anthropic", reasoningProfile: "deepseek-v4-anthropic" },
      },
      { mode: "chat", reasoningLevel: "xhigh" },
    );

    expect(result.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(result.output_config).toEqual({ effort: "max" });
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(result.max_tokens).toBe(32000);
  });

  it("clamps SGLang output tokens to avoid local max_model_len failures", () => {
    const payload = {
      model: "qwen3-32b",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 16384,
    };
    const result = normalizeProviderPayload(
      payload,
      { id: "qwen3-32b", provider: "sglang", maxTokens: 16384 },
      { mode: "chat" },
    );

    expect(result.max_completion_tokens).toBe(8192);
    expect(payload.max_completion_tokens).toBe(16384);
  });

  it("clamps MiniMax output tokens and strips unsupported reasoning fields", () => {
    const payload = {
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 65536,
      thinking: { type: "enabled", budget_tokens: 8192 },
      output_config: { effort: "max" },
      reasoning_effort: "high",
    };
    const result = normalizeProviderPayload(
      payload,
      {
        id: "MiniMax-M2.7",
        provider: "minimax",
        api: "anthropic-messages",
        maxTokens: 65536,
        compat: { thinkingFormat: "anthropic" },
      },
      { mode: "chat" },
    );

    expect(result.max_tokens).toBe(1024);
    expect(result).not.toHaveProperty("thinking");
    expect(result).not.toHaveProperty("output_config");
    expect(result).not.toHaveProperty("reasoning_effort");
    expect(payload.max_tokens).toBe(65536);
    expect(payload).toHaveProperty("thinking");
  });

  it("clamps MiniMax max_completion_tokens without mutating the original payload", () => {
    const payload = {
      model: "MiniMax-M2.7-highspeed",
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 65536,
    };
    const result = normalizeProviderPayload(
      payload,
      { id: "MiniMax-M2.7-highspeed", provider: "minimax", maxTokens: 65536 },
      { mode: "chat" },
    );

    expect(result.max_completion_tokens).toBe(1024);
    expect(payload.max_completion_tokens).toBe(65536);
  });

  it("adds cache_control to Anthropic utility system prompts", () => {
    const result = normalizeProviderPayload(
      {
        model: "claude-sonnet-4-5",
        system: "Stable writing system prompt",
        messages: [{ role: "user", content: "write" }],
      },
      { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" },
      { mode: "utility" },
    );

    expect(result.system).toEqual([
      {
        type: "text",
        text: "Stable writing system prompt",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("adds cache_control to the last Anthropic user content block", () => {
    const result = normalizeProviderPayload(
      {
        model: "claude-sonnet-4-5",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe this image." },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "BASE64" },
            },
          ],
        }],
      },
      { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" },
      { mode: "utility" },
    );

    expect(result.messages[0].content).toEqual([
      { type: "text", text: "Describe this image." },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "BASE64" },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("does not duplicate existing Anthropic cache_control markers", () => {
    const payload = {
      model: "claude-sonnet-4-5",
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "Already cached",
          cache_control: { type: "ephemeral" },
        }],
      }],
    };

    const result = normalizeProviderPayload(
      payload,
      { id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" },
      { mode: "utility" },
    );

    expect(result).toBe(payload);
  });

  it("keeps extra room when a small context window is declared", () => {
    const result = normalizeProviderPayload(
      {
        model: "qwen3-32b",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16384,
      },
      { id: "qwen3-32b", provider: "sglang", contextWindow: 8192, maxTokens: 16384 },
      { mode: "chat" },
    );

    expect(result.max_tokens).toBe(4096);
  });

  it("respects explicit higher third-party output limits", () => {
    const result = normalizeProviderPayload(
      {
        model: "qwen3-32b",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32768,
      },
      { id: "qwen3-32b", provider: "sglang", maxTokens: 32768 },
      { mode: "chat" },
    );

    expect(result.max_tokens).toBe(32768);
  });

  it("fails closed when DeepSeek Anthropic tool replay is missing non-empty thinking content", () => {
    const messages = [
      { role: "user", content: "look up date" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", thinkingSignature: "sig" },
          { type: "toolCall", id: "call_1", name: "date", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "date", content: [{ type: "text", text: "ok" }] },
    ];

    expect(() => normalizeProviderContextMessages(messages, {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      reasoning: true,
      compat: { thinkingFormat: "anthropic", reasoningProfile: "deepseek-v4-anthropic" },
    }, {
      mode: "chat",
      reasoningLevel: "high",
    })).toThrow(/DeepSeek.*Anthropic.*thinking.*tool/);
  });

  it("converts DashScope video data URLs from image_url to video_url", () => {
    const payload = {
      model: "qwen3-vl-plus",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "watch this" },
          { type: "image_url", image_url: { url: "data:video/mp4;base64,AAAA" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "qwen3-vl-plus",
      provider: "dashscope",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    }, { mode: "chat" });

    expect(result).not.toBe(payload);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "watch this" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
    ]);
    expect(payload.messages[0].content[1].type).toBe("image_url");
  });

  it("converts MiMo official video data URLs from image_url to video_url", () => {
    const payload = {
      model: "mimo-v2.5",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "watch this" },
          { type: "image_url", image_url: { url: "data:video/mp4;base64,AAAA" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "mimo-v2.5",
      provider: "mimo-token-plan",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    }, { mode: "chat" });

    expect(result).not.toBe(payload);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "watch this" },
      { type: "video_url", video_url: { url: "data:video/mp4;base64,AAAA" } },
    ]);
    expect(payload.messages[0].content[1].type).toBe("image_url");
  });

  it("composes DashScope video conversion with utility enable_thinking=false", () => {
    const result = normalizeProviderPayload({
      model: "qwen3-vl-plus",
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:video/webm;base64,AAAA" } },
        ],
      }],
    }, {
      id: "qwen3-vl-plus",
      provider: "dashscope",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      quirks: ["enable_thinking"],
    }, { mode: "utility" });

    expect(result.enable_thinking).toBe(false);
    expect(result.messages[0].content[0]).toEqual({
      type: "video_url",
      video_url: { url: "data:video/webm;base64,AAAA" },
    });
  });
});

describe("normalizeProviderContextMessages - MCP resource projection", () => {
  it("projects toolResult resource.text blocks into model-visible text without mutating input", () => {
    const textBlock = { type: "text", text: "plain tool output" };
    const resourceBlock = {
      type: "resource",
      resource: {
        uri: "file:///workspace/note.md",
        name: "note.md",
        mimeType: "text/markdown",
        text: "# Notes\nUse this context.",
      },
    };
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_resource",
        content: [textBlock, resourceBlock],
      },
    ];

    const result = normalizeProviderContextMessages(messages, {
      id: "gpt-5",
      provider: "openai",
      api: "openai-responses",
    }, { mode: "chat" });

    expect(result).not.toBe(messages);
    expect(result[0]).not.toBe(messages[0]);
    expect(result[0].content[0]).toBe(textBlock);
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: expect.stringContaining("# Notes\nUse this context."),
    });
    expect(result[0].content[1].text).toContain("uri: file:///workspace/note.md");
    expect(result[0].content[1].text).toContain("name: note.md");
    expect(result[0].content[1].text).toContain("mimeType: text/markdown");
    expect(messages[0].content[1]).toBe(resourceBlock);
  });

  it("uses a text placeholder for resource.blob without injecting base64", () => {
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read_resource",
        content: [{
          type: "resource",
          resource: {
            uri: "file:///workspace/pixel.png",
            name: "pixel.png",
            mimeType: "image/png",
            blob: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
          },
        }],
      },
    ];

    const result = normalizeProviderContextMessages(messages, null, { mode: "chat" });
    const text = result[0].content[0].text;

    expect(result).not.toBe(messages);
    expect(text).toContain("uri: file:///workspace/pixel.png");
    expect(text).toContain("name: pixel.png");
    expect(text).toContain("mimeType: image/png");
    expect(text).toContain("binary resource omitted");
    expect(text).not.toContain("iVBORw0KGgo");
    expect(messages[0].content[0].resource.blob).toContain("iVBORw0KGgo");
  });

  it("leaves non-toolResult resource blocks untouched", () => {
    const messages = [
      {
        role: "user",
        content: [{
          type: "resource",
          resource: {
            uri: "file:///workspace/user.md",
            name: "user.md",
            mimeType: "text/markdown",
            text: "do not project here",
          },
        }],
      },
    ];

    expect(normalizeProviderContextMessages(messages, null, { mode: "chat" })).toBe(messages);
  });
});
