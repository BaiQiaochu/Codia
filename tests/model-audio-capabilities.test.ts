// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  MODEL_AUDIO_TRANSPORTS,
  modelSupportsAudioInput,
  modelSupportsDirectAudioInput,
  resolveModelAudioInputTransport,
  withCodiaAudioInputCompat,
} from "../shared/model-capabilities.ts";

describe("model audio capabilities", () => {
  it("supports official MiMo v2.5 audio input through read-time endpoint compatibility", () => {
    const model = {
      id: "mimo-v2.5",
      provider: "mimo",
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      input: ["text"],
    };

    expect(modelSupportsAudioInput(model)).toBe(true);
    expect(resolveModelAudioInputTransport(model)).toBe(MODEL_AUDIO_TRANSPORTS.MIMO_INPUT_AUDIO);
    expect(modelSupportsDirectAudioInput(model)).toBe(true);
  });

  it("routes declared OpenAI audio models through OpenAI input_audio transport", () => {
    const model = {
      id: "gpt-audio-mini",
      provider: "openai",
      api: "openai-completions",
      input: ["text"],
      audio: true,
    };

    expect(modelSupportsAudioInput(model)).toBe(true);
    expect(resolveModelAudioInputTransport(model)).toBe(MODEL_AUDIO_TRANSPORTS.OPENAI_INPUT_AUDIO);
    expect(modelSupportsDirectAudioInput(model)).toBe(true);
  });

  it("does not infer MiMo audio support for other MiMo models", () => {
    const model = {
      id: "mimo-v2.5-pro",
      provider: "mimo",
      api: "openai-completions",
      baseUrl: "https://api.xiaomimimo.com/v1",
      input: ["text"],
    };

    expect(modelSupportsAudioInput(model)).toBe(false);
    expect(resolveModelAudioInputTransport(model)).toBe(MODEL_AUDIO_TRANSPORTS.NONE);
    expect(modelSupportsDirectAudioInput(model)).toBe(false);
  });

  it("projects explicit Codia audio compatibility without mutating the source model", () => {
    const model = { id: "custom-audio", provider: "custom", compat: {} };
    const projected = withCodiaAudioInputCompat(model, true);

    expect(projected).not.toBe(model);
    expect(projected.compat.codiaAudioInput).toBe(true);
    expect(model.compat.codiaAudioInput).toBeUndefined();
    expect(resolveModelAudioInputTransport(projected)).toBe(MODEL_AUDIO_TRANSPORTS.UNSUPPORTED);
  });
});
