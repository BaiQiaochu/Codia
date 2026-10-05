// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

import { VisionBridge } from "../core/vision-bridge.js";

const image = { type: "image", data: "BASE64", mimeType: "image/png" };
const textOnlyModel = { id: "deepseek-chat", provider: "deepseek", input: ["text"] };

function makeBridge(callText, extra = {}) {
  return new VisionBridge({
    resolveVisionConfig: () => ({
      model: {
        id: "qwen-vl-plus",
        provider: "dashscope",
        input: ["text", "image"],
        ...extra.model,
      },
      api: "openai-completions",
      api_key: "sk-test",
      base_url: "https://example.test/v1",
    }),
    callText,
    ...extra.bridge,
  });
}

describe("VisionBridge", () => {
  it("passes abort signals into auxiliary vision requests", async () => {
    const controller = new AbortController();
    const callText = vi.fn(async () => "image_overview: ok");
    const bridge = makeBridge(callText);

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: textOnlyModel,
      text: "[attached_image: /tmp/a.png]\nwhat is this?",
      images: [image],
      imageAttachmentPaths: ["/tmp/a.png"],
      signal: controller.signal,
    });

    expect(callText.mock.calls[0][0].signal).toBe(controller.signal);
  });

  it("caps auxiliary vision output by the model maxTokens contract", async () => {
    const callText = vi.fn(async () => "image_overview: capped");
    const bridge = makeBridge(callText, {
      model: { maxTokens: 2048 },
      bridge: { visionMaxTokens: 4096 },
    });

    await bridge.prepare({
      sessionPath: "/tmp/session.jsonl",
      targetModel: textOnlyModel,
      text: "[attached_image: /tmp/a.png]\nwhat is this?",
      images: [image],
      imageAttachmentPaths: ["/tmp/a.png"],
    });

    expect(callText.mock.calls[0][0].maxTokens).toBe(2048);
  });
});
