// @ts-nocheck
import { describe, expect, it } from "vitest";
import { inferMediaMode, resolveMediaParameters } from "../core/media/media-parameters.js";

describe("media parameter resolution", () => {
  it("infers image and video modes from reference images", () => {
    expect(inferMediaMode("image", { prompt: "draw" })).toBe("text2image");
    expect(inferMediaMode("image", { image: "/tmp/ref.png" })).toBe("image2image");
    expect(inferMediaMode("video", { prompt: "animate" })).toBe("text2video");
    expect(inferMediaMode("video", { image: "/tmp/ref.png" })).toBe("image2video");
    expect(inferMediaMode("video", { images: ["/tmp/a.png", "/tmp/b.png"] })).toBe("multiframe2video");
  });

  it("merges mode defaults, provider defaults, options, and explicit parameters", () => {
    const resolved = resolveMediaParameters({
      kind: "video",
      input: {
        model: "motion-pro",
        image: "/tmp/ref.png",
        resolution: "1080p",
        options: { seed: 9 },
      },
      providerId: "custom-video",
      model: {
        id: "motion-pro",
        modes: [{
          id: "image2video",
          defaults: { duration: 5, video_resolution: "720p" },
          inputLimits: { referenceImages: { min: 1, max: 1 } },
          parameterSchema: {
            type: "object",
            properties: {
              duration: { type: "number", minimum: 1, maximum: 10 },
              video_resolution: { type: "string", enum: ["720p", "1080p"] },
              seed: { type: "number" },
            },
          },
        }],
      },
      providerDefaults: {
        modes: {
          image2video: { duration: 7 },
        },
      },
    });

    expect(resolved.modeId).toBe("image2video");
    expect(resolved.resolvedParameters).toMatchObject({
      duration: 7,
      video_resolution: "1080p",
      seed: 9,
    });
  });

  it("rejects unsupported modes and invalid schema values", () => {
    expect(() => resolveMediaParameters({
      kind: "image",
      input: { image: "/tmp/ref.png" },
      providerId: "custom",
      model: { id: "text-only", modes: [{ id: "text2image" }] },
    })).toThrow(/does not support mode "image2image"/);

    expect(() => resolveMediaParameters({
      kind: "image",
      input: { model: "image-pro", ratio: "21:9" },
      providerId: "custom",
      model: {
        id: "image-pro",
        parameterSchema: {
          type: "object",
          properties: {
            ratio: { type: "string", enum: ["1:1", "16:9"] },
          },
        },
      },
    })).toThrow(/must be one of/);
  });

  it("enforces reference image min and max limits", () => {
    const model = {
      id: "image-pro",
      modes: [{
        id: "image2image",
        inputLimits: { referenceImages: { min: 1, max: 2 } },
      }],
    };

    expect(() => resolveMediaParameters({
      kind: "image",
      input: { model: "image-pro", images: ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"] },
      providerId: "custom",
      model,
    })).toThrow(/supports at most 2 reference images/);
  });
});
