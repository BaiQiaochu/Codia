import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("screenshot pipeline", () => {
  function readMain() {
    return fs.readFileSync(path.join(root, "desktop", "main.cjs"), "utf-8");
  }

  it("keeps long screenshot stitching in the main process", () => {
    const mainSource = readMain();
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const files = packageJson.build?.files || [];

    expect(mainSource).not.toContain("screenshot-stitch-worker");
    expect(mainSource).not.toContain("runScreenshotStitchWorker");
    expect(files).not.toContain("desktop/screenshot-stitch-worker.cjs");
  });

  it("pins offscreen screenshots to an explicit 2x scale", () => {
    const mainSource = readMain();

    expect(mainSource).toMatch(/webPreferences:\s*{\s*offscreen:\s*{\s*deviceScaleFactor:\s*2\s*}/);
    expect(mainSource).not.toMatch(/offscreen:\s*true,\s*deviceScaleFactor:\s*2/);
  });

  it("captures explicit screenshot bounds instead of the whole visible page", () => {
    const mainSource = readMain();

    expect(mainSource).toContain("capturePage({ x: 0, y: 0, width, height: totalHeight }");
    expect(mainSource).toContain("capturePage({ x: 0, y: 0, width, height: segH }");
  });

  it("keeps long screenshot bitmap stitching scale-aware", () => {
    const mainSource = readMain();

    expect(mainSource).toContain("image.toPNG({ scaleFactor: scale })");
    expect(mainSource).toContain("PNG.sync.read(seg.toPNG({ scaleFactor: scale }))");
    expect(mainSource).not.toContain("bitmap.length % partRowBytes");
  });

  it("caps long screenshot segments to the current screen work area", () => {
    const mainSource = readMain();

    expect(mainSource).toContain("resolveScreenshotMaxSegmentHeight(screen)");
    expect(mainSource).toContain("if (totalHeight <= maxSegmentHeight)");
    expect(mainSource).toContain("const segH = Math.min(maxSegmentHeight, totalHeight - captured)");
    expect(mainSource).not.toContain("if (totalHeight <= SCREENSHOT_MAX_SEGMENT)");
    expect(mainSource).not.toContain("const segH = Math.min(SCREENSHOT_MAX_SEGMENT, totalHeight - captured)");
  });

  it("paints a deterministic page background before PNG export", () => {
    const mainSource = readMain();

    expect(mainSource).toContain("backgroundColor:");
    expect(mainSource).toContain("--screenshot-page-bg");
    expect(mainSource).toContain("background: var(--screenshot-page-bg)");
  });

  it("keeps the screenshot watermark and filenames on the active G-SAP product name", () => {
    const mainSource = readMain();

    expect(mainSource).toContain("${runtimeProductName()}-${timestamp}${segmentSuffix}.png");
    expect(mainSource).toContain("${runtimeProductName()}</span>");
    expect(mainSource).not.toContain("OpenHanako</span>");
    expect(mainSource).not.toContain("hanako-${timestamp}${segmentSuffix}.png");
  });

  it("adds segment suffixes and returns the save directory for split screenshots", () => {
    const mainSource = readMain();

    expect(mainSource).toContain("const segmentTotal = Number(payload.segmentTotal)");
    expect(mainSource).toContain("const segmentIndex = Number(payload.segmentIndex)");
    expect(mainSource).toContain("padStart(2, \"0\")");
    expect(mainSource).toContain("return { success: true, filePath, dir");
  });

  it("keeps visible screenshot save labels readable", () => {
    const mainSource = readMain();

    expect(mainSource).toContain("resolveWorkspaceOutputDir(base, \"screenshots\", payload.locale || \"zh\")");
    expect(mainSource).toContain('title: "保存截图样式预览"');
    expect(mainSource).not.toContain('path.join(base, "截图")');
    expect(mainSource).not.toContain('path.join(base, "截图")');
    expect(mainSource).not.toContain('title: "淇濆瓨鎴浘鏍峰紡棰勮"');
  });

  it("pins screenshot image width by layout", () => {
    const mainSource = readMain();

    expect(mainSource).toContain('.chat-image { width: ${themeName.endsWith("-desktop") ? "66.666%" : "100%"};');
    expect(mainSource).toContain("height: auto; border-radius: 6px;");
  });

  it("embeds dark provenance into saved screenshot PNG files", () => {
    const mainSource = readMain();

    expect(mainSource).toContain('require("../shared/dark-watermark.cjs")');
    expect(mainSource).toContain("writePngWatermark(pngBuffer, buildWatermarkPayload");
    expect(mainSource).toContain('source: "desktop_screenshot"');
    expect(mainSource).toContain("fs.writeFileSync(filePath, watermarkedPngBuffer)");
  });
});
