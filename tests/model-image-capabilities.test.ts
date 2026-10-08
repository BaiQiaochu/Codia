import { describe, expect, it } from "vitest";

import {
  MODEL_IMAGE_TRANSPORTS,
  modelSupportsDirectImageInput,
  modelSupportsImageInput,
  resolveModelImageInputTransport,
} from "../shared/model-capabilities.ts";

describe("model image capability transport", () => {
  it("marks official DeepSeek chat completions as image capable but not direct image transport capable", () => {
    const model = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      input: ["text", "image"],
      baseUrl: "https://api.deepseek.com",
    };

    expect(modelSupportsImageInput(model)).toBe(true);
    expect(resolveModelImageInputTransport(model)).toBe(MODEL_IMAGE_TRANSPORTS.UNSUPPORTED);
    expect(modelSupportsDirectImageInput(model)).toBe(false);
  });

  it("keeps user-declared image support direct for unknown providers", () => {
    const model = {
      id: "custom-vision",
      provider: "custom",
      api: "openai-completions",
      input: ["text", "image"],
      baseUrl: "https://api.example.com/v1",
    };

    expect(modelSupportsImageInput(model)).toBe(true);
    expect(resolveModelImageInputTransport(model)).toBe(MODEL_IMAGE_TRANSPORTS.OPENAI_IMAGE_URL);
    expect(modelSupportsDirectImageInput(model)).toBe(true);
  });

  it("keeps custom DeepSeek-compatible endpoints direct when they declare image support", () => {
    const model = {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      api: "openai-completions",
      input: ["text", "image"],
      baseUrl: "https://vision-proxy.example.com/v1",
    };

    expect(modelSupportsImageInput(model)).toBe(true);
    expect(resolveModelImageInputTransport(model)).toBe(MODEL_IMAGE_TRANSPORTS.OPENAI_IMAGE_URL);
    expect(modelSupportsDirectImageInput(model)).toBe(true);
  });
});
