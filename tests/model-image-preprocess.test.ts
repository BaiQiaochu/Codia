// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

import { prepareModelImageInputsForPrompt } from "../core/model-image-preprocess.js";
import * as piSdk from "../lib/pi-sdk/index.js";

describe("prepareModelImageInputsForPrompt", () => {
  it("exposes the Pi SDK image resize adapters used by the default path", () => {
    expect(piSdk.resizeModelImageInput).toBeTypeOf("function");
    expect(piSdk.formatModelImageDimensionNote).toBeTypeOf("function");
  });

  it("resizes images before the model boundary and keeps dimension notes in the prompt", async () => {
    const resizeImage = vi.fn(async (image, options) => ({
      data: `compressed-${image.data}`,
      mimeType: "image/jpeg",
      originalWidth: 4000,
      originalHeight: 3000,
      width: 2000,
      height: 1500,
      wasResized: true,
      options,
    }));
    const formatDimensionNote = vi.fn((result) =>
      `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by 2.00 to map to original image.]`
    );

    const result = await prepareModelImageInputsForPrompt({
      text: "[attached_image: /tmp/design.png]\nPlease review this design.",
      opts: {
        images: [{ type: "image", data: "raw-base64", mimeType: "image/png" }],
        imageAttachmentPaths: ["/tmp/design.png"],
      },
      resizeImage,
      formatDimensionNote,
    });

    expect(resizeImage).toHaveBeenCalledWith(
      { type: "image", data: "raw-base64", mimeType: "image/png" },
      expect.objectContaining({
        maxWidth: 2000,
        maxHeight: 2000,
        jpegQuality: 80,
        maxBytes: 4.5 * 1024 * 1024,
      })
    );
    expect(result.opts.images).toEqual([
      { type: "image", data: "compressed-raw-base64", mimeType: "image/jpeg" },
    ]);
    expect(result.opts.imageAttachmentPaths).toEqual(["/tmp/design.png"]);
    expect(result.opts.modelImageInputsPrepared).toBe(true);
    expect(result.text).toContain("[attached_image: /tmp/design.png]\n");
    expect(result.text).toContain('<file name="/tmp/design.png">[Image: original 4000x3000, displayed at 2000x1500.');
    expect(result.text).toContain("Please review this design.");
  });

  it("splits the total request budget across multiple images", async () => {
    const resizeImage = vi.fn(async (image) => ({
      data: image.data,
      mimeType: image.mimeType,
      originalWidth: 100,
      originalHeight: 100,
      width: 100,
      height: 100,
      wasResized: false,
    }));

    await prepareModelImageInputsForPrompt({
      text: "compare",
      opts: {
        images: [
          { type: "image", data: "a", mimeType: "image/png" },
          { type: "image", data: "b", mimeType: "image/png" },
          { type: "image", data: "c", mimeType: "image/png" },
        ],
      },
      imagePolicy: {
        maxImageBase64Bytes: 100,
        totalBase64BudgetBytes: 9,
      },
      resizeImage,
      formatDimensionNote: vi.fn(),
    });

    expect(resizeImage).toHaveBeenCalledTimes(3);
    expect(resizeImage.mock.calls.map(([, options]) => options.maxBytes)).toEqual([3, 3, 3]);
  });

  it("fails closed when an image cannot be normalized", async () => {
    await expect(prepareModelImageInputsForPrompt({
      text: "inspect",
      opts: { images: [{ type: "image", data: "bad", mimeType: "image/png" }] },
      resizeImage: vi.fn(async () => null),
      formatDimensionNote: vi.fn(),
    })).rejects.toThrow(/image input preprocessing failed/i);
  });

  it("passes through a valid in-budget image when the resize adapter cannot decode it", async () => {
    const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXl1wAAAAASUVORK5CYII=";
    const resizeImage = vi.fn(async () => null);
    const formatDimensionNote = vi.fn();

    const result = await prepareModelImageInputsForPrompt({
      text: "describe",
      opts: { images: [{ type: "image", data: png1x1, mimeType: "image/png" }] },
      resizeImage,
      formatDimensionNote,
    });

    expect(result.opts.images).toEqual([
      { type: "image", data: png1x1, mimeType: "image/png" },
    ]);
    expect(result.opts.modelImageInputsPrepared).toBe(true);
    expect(formatDimensionNote).not.toHaveBeenCalled();
  });

  it("does not preprocess the same prompt twice", async () => {
    const resizeImage = vi.fn();
    const opts = {
      images: [{ type: "image", data: "ready", mimeType: "image/png" }],
      modelImageInputsPrepared: true,
    };

    const result = await prepareModelImageInputsForPrompt({
      text: "already prepared",
      opts,
      resizeImage,
      formatDimensionNote: vi.fn(),
    });

    expect(result).toEqual({ text: "already prepared", opts });
    expect(resizeImage).not.toHaveBeenCalled();
  });
});
