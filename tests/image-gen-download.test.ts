// @ts-nocheck
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import watermark from "../shared/dark-watermark.cjs";

const tmpDir = path.join(os.tmpdir(), "gsap-test-imgdl-" + Date.now());
const { hasPngWatermark } = watermark;
const PNG_WITH_IEND = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("saveImage", () => {
  it("writes buffer to generated/ with correct filename pattern", async () => {
    const { saveImage } = await import("../plugins/image-gen/lib/download.js");
    const buf = Buffer.from("fake-png-data");
    const result = await saveImage(buf, "image/png", tmpDir);

    expect(result.filename).toMatch(/^\d+-[a-f0-9]{8}\.png$/);
    expect(result.filePath).toContain(path.join(tmpDir, "generated"));
    expect(fs.existsSync(result.filePath)).toBe(true);
    expect(fs.readFileSync(result.filePath)).toEqual(buf);
  });

  it("derives extension from mimeType", async () => {
    const { saveImage } = await import("../plugins/image-gen/lib/download.js");
    const buf = Buffer.from("fake-jpeg-data");
    const result = await saveImage(buf, "image/jpeg", tmpDir);
    expect(result.filename).toMatch(/\.jpg$/);
  });

  it("embeds dark provenance into generated PNG media", async () => {
    const { saveImage } = await import("../plugins/image-gen/lib/download.js");
    const result = await saveImage(PNG_WITH_IEND, "image/png", tmpDir, "traceable-image");

    expect(result.filename).toMatch(/^traceable-image-[a-f0-9]{8}\.png$/);
    expect(hasPngWatermark(fs.readFileSync(result.filePath))).toBe(true);
  });

  it("writes sidecar provenance for generated video media", async () => {
    const { saveMedia } = await import("../plugins/image-gen/lib/download.js");
    const result = await saveMedia(Buffer.from("video-bytes"), "video/mp4", tmpDir, "traceable-video");
    const sidecarPath = `${result.filePath}.gsap-watermark.json`;

    expect(result.filename).toMatch(/^traceable-video-[a-f0-9]{8}\.mp4$/);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecarPath, "utf8")).payload).toMatchObject({
      product: "Codia",
      source: "image_gen_media",
      filePath: result.filePath,
    });
  });
});
