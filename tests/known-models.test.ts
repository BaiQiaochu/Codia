import { describe, expect, it } from "vitest";

import { lookupKnown } from "../shared/known-models.ts";

describe("known-models dictionary", () => {
  it("treats missing model ids as unknown instead of throwing", () => {
    expect(lookupKnown("openai", undefined)).toBeNull();
    expect(lookupKnown(undefined, undefined)).toBeNull();
  });

  it("declares Xiaomi MiMo V2.5 series with multimodal and TTS limits", () => {
    expect(lookupKnown("mimo", "mimo-v2.5-pro")).toEqual({
      name: "MiMo V2.5 Pro",
      context: 1048576,
      maxOutput: 131072,
      reasoning: true,
    });
    expect(lookupKnown("mimo", "mimo-v2.5")).toEqual({
      name: "MiMo V2.5",
      context: 1048576,
      maxOutput: 131072,
      image: true,
      video: true,
      audio: true,
      reasoning: true,
    });

    for (const id of [
      "mimo-v2.5-tts",
      "mimo-v2.5-tts-voicedesign",
      "mimo-v2.5-tts-voiceclone",
    ]) {
      expect(lookupKnown("mimo", id)).toMatchObject({
        context: 8192,
        maxOutput: 8192,
      });
    }
  });

  it("keeps Xiaomi MiMo V2 Omni aligned with full-modal metadata", () => {
    expect(lookupKnown("mimo", "mimo-v2-omni")).toMatchObject({
      context: 262144,
      maxOutput: 131072,
      image: true,
      video: true,
      reasoning: true,
    });
  });

  it("uses generic MiMo fallbacks when the provider is unknown", () => {
    expect(lookupKnown("custom-mimo", "mimo-v2.5-pro")).toMatchObject({
      context: 1048576,
      maxOutput: 131072,
      reasoning: true,
    });
  });

  it("declares qwen3.6-27b as a Qwen thinking-compatible model", () => {
    expect(lookupKnown("dashscope", "qwen3.6-27b")).toMatchObject({
      name: "Qwen 3.6 27B",
      context: 262144,
      maxOutput: 32768,
      image: true,
      reasoning: true,
      quirks: ["enable_thinking"],
    });
  });

  it("syncs OpenAI GPT-5.5 metadata from the 0.250.0 reference catalog", () => {
    expect(lookupKnown("openai", "gpt-5.5")).toMatchObject({
      name: "GPT-5.5",
      context: 1050000,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      visionCapabilities: {
        grounding: true,
        outputFormat: "anchor",
      },
    });
  });

  it("looks up model ids case-insensitively before falling back to unknown", () => {
    expect(lookupKnown("openai", "GPT-5.5")).toMatchObject({
      name: "GPT-5.5",
      context: 1050000,
      image: true,
      reasoning: true,
    });
  });

  it("keeps the broad original fallback catalog for custom providers", () => {
    expect(lookupKnown("custom", "qwen3-vl-plus")).toMatchObject({
      name: "Qwen3 Vl Plus",
      image: true,
      reasoning: true,
    });
  });
});
