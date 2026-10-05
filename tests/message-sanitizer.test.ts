import { describe, expect, it } from "vitest";
import {
  modelSupportsImage,
  modelSupportsVideo,
  sanitizeMessagesForModel,
  stripAllInlineMediaForHistory,
  stripHistoricalInlineMediaForReplay,
} from "../core/message-sanitizer.js";

describe("message sanitizer", () => {
  it("detects image-capable models from input modalities", () => {
    expect(modelSupportsImage({ input: ["text", "image"] })).toBe(true);
    expect(modelSupportsImage({ input: ["text"] })).toBe(false);
  });

  it("detects video-capable models from input modalities", () => {
    expect(modelSupportsVideo({ input: ["text", "video"] })).toBe(true);
    expect(modelSupportsVideo({ input: ["text", "image"] })).toBe(false);
  });

  it("detects video-capable models from G-SAP compat metadata", () => {
    expect(modelSupportsVideo({ input: ["text", "image"], compat: { gsapVideoInput: true } })).toBe(true);
  });

  it("keeps legacy Hana video compat metadata readable", () => {
    expect(modelSupportsVideo({ input: ["text", "image"], compat: { hanaVideoInput: true } })).toBe(true);
  });

  it("detects image-capable models from image and vision flags", () => {
    expect(modelSupportsImage({ image: true })).toBe(true);
    expect(modelSupportsImage({ vision: true })).toBe(true);
    expect(modelSupportsImage({ image: false, vision: false })).toBe(false);
  });

  it("uses known model metadata when runtime input modalities are stale", () => {
    expect(modelSupportsImage({ id: "gpt-4o", provider: "openai", input: ["text"] })).toBe(true);
    expect(modelSupportsImage({ id: "gpt-4o", provider: "openai", input: ["text"], image: false })).toBe(false);
    expect(modelSupportsImage({ id: "gpt-4o", provider: "openai", input: ["text"], vision: false })).toBe(true);
  });

  it("does not assume unknown models support image input", () => {
    expect(modelSupportsImage({ id: "unknown-model", provider: "custom" })).toBe(false);
    expect(modelSupportsImage({ id: "unknown-model", provider: "custom", vision: true })).toBe(true);
  });

  it("replaces image blocks for text-only models", () => {
    const input = [{
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image", data: "BASE64", mimeType: "image/png" },
      ],
    }];
    const result = sanitizeMessagesForModel(input, { input: ["text"] });
    expect(result.stripped).toBe(1);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "see" },
      { type: "text", text: "[image omitted: current model does not support image input]" },
    ]);
    expect(input[0].content[1].type).toBe("image");
  });

  it("replaces OpenAI image_url and Responses input_image blocks for text-only models", () => {
    const input = [{
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "input_image", image_url: "data:image/png;base64,BBB" },
      ],
    }];
    const result = sanitizeMessagesForModel(input, { id: "deepseek-v4-pro", provider: "deepseek" });
    expect(result.stripped).toBe(2);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "see" },
      { type: "text", text: "[image omitted: current model does not support image input]" },
      { type: "text", text: "[image omitted: current model does not support image input]" },
    ]);
  });

  it("keeps image blocks for image-capable models", () => {
    const input = [{ role: "user", content: [{ type: "image", data: "BASE64" }] }];
    const result = sanitizeMessagesForModel(input, { input: ["text", "image"] });
    expect(result).toEqual({ messages: input, stripped: 0 });
  });

  it("replaces video blocks for text-only models", () => {
    const input = [{
      role: "user",
      content: [
        { type: "text", text: "watch" },
        { type: "video", data: "BASE64", mimeType: "video/mp4" },
      ],
    }];
    const result = sanitizeMessagesForModel(input, { input: ["text"] });
    expect(result.stripped).toBe(1);
    expect(result.strippedImages).toBe(0);
    expect(result.strippedVideos).toBe(1);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "watch" },
      { type: "text", text: "[video omitted: current model does not support video input]" },
    ]);
    expect(input[0].content[1].type).toBe("video");
  });

  it("keeps video blocks for video-capable models while stripping unsupported images", () => {
    const input = [{
      role: "user",
      content: [
        { type: "image", data: "BASE64", mimeType: "image/png" },
        { type: "video", data: "BASE64", mimeType: "video/mp4" },
      ],
    }];
    const result = sanitizeMessagesForModel(input, { input: ["text", "video"] });
    expect(result.stripped).toBe(1);
    expect(result.strippedImages).toBe(1);
    expect(result.strippedVideos).toBe(0);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "[image omitted: current model does not support image input]" },
      { type: "video", data: "BASE64", mimeType: "video/mp4" },
    ]);
  });

  it("keeps video blocks for G-SAP video-compatible models", () => {
    const input = [{ role: "user", content: [{ type: "video", data: "BASE64", mimeType: "video/mp4" }] }];
    const result = sanitizeMessagesForModel(input, { input: ["text"], compat: { gsapVideoInput: true } });
    expect(result).toEqual({ messages: input, stripped: 0 });
  });

  it("treats DeepSeek OpenAI models as text-only unless vision compat is explicit", () => {
    const input = [{
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    }];

    const result = sanitizeMessagesForModel(input, {
      id: "deepseek-v4-pro",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      input: ["text", "image"],
      vision: true,
    });

    expect(result.stripped).toBe(1);
    expect(result.messages[0].content[1]).toEqual({
      type: "text",
      text: "[image omitted: current model does not support image input]",
    });
  });

  it("allows DeepSeek image blocks only when compat explicitly enables vision", () => {
    expect(modelSupportsImage({
      id: "deepseek-vl",
      provider: "deepseek",
      input: ["text", "image"],
      vision: true,
      compat: { supportsVision: true },
    })).toBe(true);
  });

  it("allows known MiniMax M2.7 image input even when stale runtime metadata is text-only", () => {
    expect(modelSupportsImage({
      id: "MiniMax-M2.7",
      provider: "minimax",
      input: ["text"],
    })).toBe(true);
  });

  it("allows known MiniMax M2.7 image input when old cached compat is text-only", () => {
    expect(modelSupportsImage({
      id: "MiniMax-M2.7",
      provider: "minimax",
      input: ["text"],
      vision: false,
      compat: { supportsImageInput: false },
    })).toBe(true);
  });

  it("keeps known MiniMax text-only models conservative", () => {
    expect(modelSupportsImage({
      id: "MiniMax-M2.5",
      provider: "minimax",
      input: ["text", "image"],
      vision: true,
      compat: { supportsImageInput: true },
    })).toBe(false);
  });

  it("respects explicit MiniMax text-only overrides", () => {
    expect(modelSupportsImage({
      id: "MiniMax-M2.7",
      provider: "minimax",
      input: ["text", "image"],
      image: false,
      vision: true,
      compat: { supportsImageInput: false },
    })).toBe(false);
  });

  it("strips historical inline media before replay while preserving the current turn", () => {
    const imageBlock = { type: "image", data: "OLD", mimeType: "image/png" };
    const currentImage = { type: "image", data: "CURRENT", mimeType: "image/png" };
    const input = [
      { role: "user", content: [{ type: "text", text: "[attached_image: /tmp/old.png]\nold" }, imageBlock] },
      { role: "assistant", content: [{ type: "text", text: "seen" }] },
      { role: "user", content: [{ type: "text", text: "[attached_image: /tmp/current.png]\ncurrent" }, currentImage] },
    ];

    const result = stripHistoricalInlineMediaForReplay(input);

    expect(result.strippedImages).toBe(1);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "[attached_image: /tmp/old.png]\nold" },
    ]);
    expect(result.messages[2]).toBe(input[2]);
    expect(result.messages[2].content).toEqual([
      { type: "text", text: "[attached_image: /tmp/current.png]\ncurrent" },
      currentImage,
    ]);
  });

  it("strips all inline media for durable history without removing file markers", () => {
    const input = [{
      role: "user",
      content: [
        { type: "text", text: "[attached_image: /tmp/a.png]\n[attached_video: /tmp/v.mp4]\nmedia" },
        { type: "image", data: "IMG", mimeType: "image/png" },
        { type: "video", data: "VID", mimeType: "video/mp4" },
      ],
    }];

    const result = stripAllInlineMediaForHistory(input);

    expect(result.strippedImages).toBe(1);
    expect(result.strippedVideos).toBe(1);
    expect(result.messages[0].content).toEqual([
      { type: "text", text: "[attached_image: /tmp/a.png]\n[attached_video: /tmp/v.mp4]\nmedia" },
    ]);
  });
});
