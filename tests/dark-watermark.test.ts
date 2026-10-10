import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import watermark from "../shared/dark-watermark.cjs";

const {
  appendInvisibleWatermark,
  buildWatermarkPayload,
  extractInvisibleWatermarks,
  hasPngWatermark,
  watermarkGeneratedFileSync,
  writePngWatermark,
} = watermark;

const PNG_WITH_IEND = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

describe("dark watermark", () => {
  it("embeds and extracts invisible text provenance", () => {
    const payload = buildWatermarkPayload({
      source: "agent_artifact",
      sessionPath: "/sessions/main.jsonl",
      filePath: "/tmp/report.md",
      origin: "agent_artifact",
    }, {
      now: () => "2026-05-15T10:00:00.000Z",
      randomId: () => "trace-fixed",
    });

    const watermarked = appendInvisibleWatermark("# Report\n", payload);
    expect(watermarked).not.toBe("# Report\n");
    const watermarkChars = new Set([
      String.fromCharCode(0x200c),
      String.fromCharCode(0x200d),
      String.fromCharCode(0x2063),
      String.fromCharCode(0x2064),
    ]);
    expect([...watermarked].filter((char) => !watermarkChars.has(char)).join("")).toBe("# Report\n");

    expect(extractInvisibleWatermarks(watermarked)).toEqual([
      expect.objectContaining({
        product: "Codia",
        source: "agent_artifact",
        sessionPath: "/sessions/main.jsonl",
        filePath: "/tmp/report.md",
        traceId: "trace-fixed",
      }),
    ]);
  });

  it("embeds provenance into PNG bytes without changing the visible file type", () => {
    const payload = buildWatermarkPayload({
      source: "screenshot",
      filePath: "/tmp/shot.png",
    }, {
      now: () => "2026-05-15T10:00:00.000Z",
      randomId: () => "png-trace",
    });

    const next = writePngWatermark(PNG_WITH_IEND, payload);

    expect(next.subarray(0, 8)).toEqual(PNG_WITH_IEND.subarray(0, 8));
    expect(hasPngWatermark(next)).toBe(true);
    expect(hasPngWatermark(PNG_WITH_IEND)).toBe(false);
  });

  it("writes a sidecar provenance file for generated binary artifacts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-watermark-"));
    try {
      const filePath = path.join(dir, "scene.xmind");
      fs.writeFileSync(filePath, Buffer.from("binary-content"));

      const result = watermarkGeneratedFileSync({
        filePath,
        source: "mind_map",
        origin: "plugin_generated",
        storageKind: "plugin_generated",
      }, {
        now: () => "2026-05-15T10:00:00.000Z",
        randomId: () => "binary-trace",
      });

      const sidecarPath = `${filePath}.codia-watermark.json`;
      expect(result).toMatchObject({
        product: "Codia",
        traceId: "binary-trace",
        applied: true,
        method: "file-sidecar",
        sidecarPath,
      });
      expect(JSON.parse(fs.readFileSync(sidecarPath, "utf8")).payload).toMatchObject({
        source: "mind_map",
        origin: "plugin_generated",
        filePath,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
