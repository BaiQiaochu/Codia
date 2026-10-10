// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { callText } from "../core/llm-client.js";

describe("callText provider compat", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes legacy model id plus quirks through qwen utility compat", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: "qwen3.5-plus",
      quirks: ["enable_thinking"],
      messages: [{ role: "user", content: "hi" }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.enable_thinking).toBe(false);
  });

  it("omits temperature from utility requests unless the caller sets it explicitly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "kimi-k2.5", provider: "moonshot", input: ["text", "image"] },
      messages: [{ role: "user", content: "hi" }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("temperature");
  });

  it("does not synthesize utility output caps from model capability metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-small-output",
        provider: "openai-compatible",
        api: "openai-completions",
        maxTokens: 512,
      },
      messages: [{ role: "user", content: "hi" }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("keeps explicit utility output caps as task-owned request budgets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "custom-small-output",
        provider: "openai-compatible",
        api: "openai-completions",
        maxTokens: 512,
      },
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 80,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(80);
  });

  it("serializes image content for OpenAI-compatible chat completions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "qwen-vl", provider: "dashscope", input: ["text", "image"] },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Describe this image." },
      { type: "image_url", image_url: { url: "data:image/png;base64,BASE64" } },
    ]);
  });

  it("serializes audio content for OpenAI-compatible chat completions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: {
        id: "gpt-audio-mini",
        provider: "openai",
        api: "openai-completions",
        input: ["text"],
        audio: true,
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Transcribe this." },
          { type: "audio", data: "AUDIO_BASE64", mimeType: "audio/wav" },
        ],
      }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Transcribe this." },
      { type: "input_audio", input_audio: { data: "AUDIO_BASE64", format: "wav" } },
    ]);
  });

  it("normalizes OpenAI Responses utility message roles to lowercase before sending", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        output_text: "ok",
      }),
    });

    await callText({
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      model: { id: "gpt-5.5", provider: "openai", api: "openai-responses" },
      messages: [
        { role: "System", content: "Keep answers short." },
        { role: "User", content: "Hi" },
        { role: "Assistant", content: "Hello" },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe("https://example.test/v1/responses");
    expect(body.instructions).toBe("Keep answers short.");
    expect(body.input).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("serializes image content for Anthropic messages", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-sonnet", provider: "anthropic", input: ["text", "image"] },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image", data: "BASE64", mimeType: "image/jpeg" },
        ],
      }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Describe this image." },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: "BASE64",
        },
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("adds cache_control to Anthropic utility system prompts when the model omits api metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://example.test",
      model: { id: "claude-opus-4-5", provider: "anthropic" },
      systemPrompt: "Stable writing system prompt",
      messages: [{ role: "user", content: "write" }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.system).toEqual([
      {
        type: "text",
        text: "Stable writing system prompt",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("strips image_url blocks before calling DeepSeek V4 text-only utility models", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      model: { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          { type: "image_url", image_url: { url: "data:image/png;base64,BASE64" } },
          { type: "input_image", image_url: "data:image/png;base64,BASE642" },
        ],
      }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    const payload = JSON.stringify(body.messages);
    expect(payload).not.toContain("image_url");
    expect(payload).not.toContain("input_image");
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "Describe this." },
      { type: "text", text: "[image omitted: current model does not support image input]" },
    ]);
  });

  it("strips images for DeepSeek even when local config incorrectly marks vision true", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      model: {
        id: "deepseek-v4-pro",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        input: ["text", "image"],
        vision: true,
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      }],
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(JSON.stringify(body.messages)).not.toContain("image_url");
    expect(body.messages[0].content[1]).toEqual({
      type: "text",
      text: "[image omitted: current model does not support image input]",
    });
  });

  it("applies DeepSeek V4 utility compat for legacy string model ids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      provider: "deepseek",
      model: "deepseek-v4",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 80,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("clamps oversized SGLang utility requests before sending", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    await callText({
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:30000/v1",
      model: {
        id: "qwen3-32b",
        provider: "sglang",
        api: "openai-completions",
        maxTokens: 16384,
      },
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16384,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(8192);
  });

  it("clamps MiniMax utility requests and keeps known M2.7 image content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
      model: {
        id: "MiniMax-M2.7",
        provider: "minimax",
        api: "anthropic-messages",
        baseUrl: "https://api.minimaxi.com/anthropic",
        input: ["text", "image"],
        vision: true,
        maxTokens: 65536,
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      }],
      maxTokens: 65536,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages[0].content[1]).toEqual({
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: "BASE64",
      },
    });
  });

  it("strips MiniMax image content when explicit image override marks the model text-only", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await callText({
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
      model: {
        id: "MiniMax-M2.7",
        provider: "minimax",
        api: "anthropic-messages",
        baseUrl: "https://api.minimaxi.com/anthropic",
        input: ["text", "image"],
        image: false,
        vision: true,
        maxTokens: 65536,
        compat: { supportsImageInput: false },
      },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this." },
          { type: "image", data: "BASE64", mimeType: "image/png" },
        ],
      }],
      maxTokens: 65536,
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(1024);
    expect(JSON.stringify(body.messages)).not.toContain("BASE64");
    expect(body.messages[0].content[1]).toEqual({
      type: "text",
      text: "[image omitted: current model does not support image input]",
    });
  });

  it("normalizes MiniMax Anthropic utility endpoint and uses x-api-key auth", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await callText({
      api: "anthropic-messages",
      apiKey: "sk-test",
      baseUrl: "https://api.minimaxi.com/v1",
      provider: "minimax-token-plan",
      model: "MiniMax-M2.7",
      messages: [{ role: "user", content: "hi" }],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(init.headers["x-api-key"]).toBe("sk-test");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("uses Bearer auth for Kimi Coding Anthropic utility requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    await callText({
      api: "anthropic-messages",
      apiKey: "sk-kimi",
      baseUrl: "https://api.kimi.com/coding/",
      provider: "kimi-coding",
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.kimi.com/coding/v1/messages");
    expect(init.headers.Authorization).toBe("Bearer sk-kimi");
    expect(init.headers["x-api-key"]).toBeUndefined();
  });

  it("calls Gemini native generateContent with x-goog-api-key for utility text", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      }),
    });

    const text = await callText({
      api: "google-generative-ai",
      apiKey: "gemini-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: { id: "gemini-3.1-pro-preview", provider: "gemini", api: "google-generative-ai" },
      systemPrompt: "Be concise.",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(text).toBe("ok");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("gemini-key");
    expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.systemInstruction.parts).toEqual([{ text: "Be concise." }]);
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
    expect(body.generationConfig.maxOutputTokens).toBe(16);
  });

  it("strips inline thinking tags from non-streaming responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "<THINKING>hidden</THINKING>\n</think>\nvisible" } }],
      }),
    });

    const text = await callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(text).toBe("visible");
  });

  it("rejects tagged thinking-only utility responses instead of exposing them as visible text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{ message: { content: "<think<|message|>fallback reasoning</think>" } }],
      }),
    });

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: "qwen3.5-plus",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      context: { reason: "empty_after_thinking" },
    });
  });

  it("rejects structured thinking-only utility responses instead of exposing reasoning_content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: "",
            reasoning_content: "I need to inspect the selected skill.",
          },
          finish_reason: "stop",
        }],
      }),
    });

    await expect(callText({
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      model: { id: "qwen3.6-27b", provider: "dashscope", quirks: ["enable_thinking"] },
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toMatchObject({
      code: "LLM_EMPTY_RESPONSE",
      context: { reason: "empty_after_thinking" },
    });
  });

  it("strips unsupported Codex Responses utility controls through provider compat", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ output_text: "Codex OK" }),
    });

    await callText({
      api: "openai-codex-responses",
      apiKey: "oauth-token",
      baseUrl: "https://chatgpt.com/backend-api",
      model: {
        id: "gpt-5.5",
        provider: "openai-codex-oauth",
        api: "openai-codex-responses",
        accountId: "acct_123",
      },
      messages: [{ role: "user", content: "Reply OK." }],
      maxTokens: 1234,
      temperature: 0,
      timeoutMs: 5_000,
    } as any);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("maxOutputTokens");
    expect(body).not.toHaveProperty("temperature");
    expect(body.input).toEqual([{ role: "user", content: "Reply OK." }]);
  });
});
