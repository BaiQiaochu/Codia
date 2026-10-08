import { describe, expect, it } from "vitest";
import { normalizeProviderPayload } from "../../core/provider-compat.ts";

describe("provider-compat media attachment markers", () => {
  it("strips attached_image markers from provider-visible text when the same message carries native image data", () => {
    const payload = {
      model: "custom-vision",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "[attached_image: /tmp/a.png]\nwhat is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "custom-vision",
      provider: "custom",
      input: ["text", "image"],
    });

    expect(result.messages[0].content[0].text).toBe("what is this?");
    expect(result.messages[0].content[1]).toEqual(payload.messages[0].content[1]);
  });

  it("strips attached_audio markers before MiMo audio payload conversion", () => {
    const payload = {
      model: "mimo-v2.5",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "[attached_audio: /tmp/voice.wav]\nlisten" },
          { type: "image_url", image_url: { url: "data:audio/wav;base64,UklGRg==" } },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "mimo-v2.5",
      provider: "mimo",
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
      input: ["text", "audio"],
    });

    expect(result.messages[0].content).toEqual([
      { type: "text", text: "listen" },
      {
        type: "input_audio",
        input_audio: {
          data: "UklGRg==",
          format: "wav",
        },
      },
    ]);
  });

  it("keeps durable historical markers when no native media part is present", () => {
    const payload = {
      model: "custom-vision",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "[attached_image: /tmp/a.png]\nwhat was in the previous screenshot?" },
        ],
      }],
    };

    const result = normalizeProviderPayload(payload, {
      id: "custom-vision",
      provider: "custom",
      input: ["text", "image"],
    });

    expect(result).toBe(payload);
  });
});
