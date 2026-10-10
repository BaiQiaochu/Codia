import { describe, expect, it } from "vitest";

import {
  MODEL_VIDEO_TRANSPORTS,
  modelSupportsDirectVideoInput,
  modelSupportsVideoInput,
  resolveModelVideoInputTransport,
} from "../shared/model-capabilities.ts";

describe("model video capability transport", () => {
  it("keeps semantic video capability separate from provider transport support", () => {
    const model = {
      id: "kimi-for-coding",
      provider: "kimi-coding",
      api: "anthropic-messages",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
    };

    expect(modelSupportsVideoInput(model)).toBe(true);
    expect(resolveModelVideoInputTransport(model)).toBe(MODEL_VIDEO_TRANSPORTS.UNSUPPORTED);
    expect(modelSupportsDirectVideoInput(model)).toBe(false);
  });

  it("allows native Gemini video through inlineData transport", () => {
    const model = {
      id: "gemini-3-flash-preview",
      provider: "gemini",
      api: "google-generative-ai",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    };

    expect(resolveModelVideoInputTransport(model)).toBe(MODEL_VIDEO_TRANSPORTS.GEMINI_INLINE_DATA);
    expect(modelSupportsDirectVideoInput(model)).toBe(true);
  });

  it("allows high-confidence OpenAI-compatible video_url providers only", () => {
    expect(resolveModelVideoInputTransport({
      id: "qwen3-vl-plus",
      provider: "dashscope",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    })).toBe(MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL);

    expect(resolveModelVideoInputTransport({
      id: "kimi-k2.6",
      provider: "moonshot",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      baseUrl: "https://api.moonshot.cn/v1",
    })).toBe(MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL);
  });

  it("allows official MiMo video models through OpenAI video_url transport", () => {
    expect(resolveModelVideoInputTransport({
      id: "mimo-v2.5",
      provider: "mimo-token-plan",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    })).toBe(MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL);
  });

  it("does not infer video transport for unknown OpenAI-compatible providers", () => {
    expect(resolveModelVideoInputTransport({
      id: "custom-video",
      provider: "custom",
      api: "openai-completions",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
      baseUrl: "https://api.example.com/v1",
    })).toBe(MODEL_VIDEO_TRANSPORTS.UNSUPPORTED);
  });
});
