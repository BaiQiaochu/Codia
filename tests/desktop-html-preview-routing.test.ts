import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MAIN_PATH = path.join(process.cwd(), "desktop", "main.cjs");
const PRELOAD_PATH = path.join(process.cwd(), "desktop", "preload.cjs");
const PLATFORM_FALLBACK_PATH = path.join(process.cwd(), "desktop", "src", "modules", "platform.ts");

describe("desktop HTML preview routing", () => {
  it("does not expose a dedicated native WebContentsView host for local HTML previews", () => {
    const source = fs.readFileSync(MAIN_PATH, "utf-8");

    expect(source).not.toContain("_htmlPreviewViews");
    expect(source).not.toContain("function _showHtmlPreviewView");
    expect(source).not.toContain("function _closeHtmlPreviewView");
    expect(source).not.toContain("function _isAllowedHtmlPreviewUrl");
    expect(source).not.toContain("_closeAllHtmlPreviewViews");
    expect(source).not.toContain("html-preview-show");
    expect(source).not.toContain("html-preview-update-bounds");
    expect(source).not.toContain("html-preview-close");
  });

  it("keeps the desktop bridge free of HTML preview native-host commands", () => {
    const preloadSource = fs.readFileSync(PRELOAD_PATH, "utf-8");
    const platformSource = fs.readFileSync(PLATFORM_FALLBACK_PATH, "utf-8");

    expect(preloadSource).not.toContain("showHtmlPreview");
    expect(preloadSource).not.toContain("updateHtmlPreviewBounds");
    expect(preloadSource).not.toContain("closeHtmlPreview");
    expect(platformSource).not.toContain("showHtmlPreview");
    expect(platformSource).not.toContain("updateHtmlPreviewBounds");
    expect(platformSource).not.toContain("closeHtmlPreview");
  });
});
