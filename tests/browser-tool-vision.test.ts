import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createBrowserTool } from "../lib/tools/browser-tool.js";
import { extractBlocks } from "../server/block-extractors.js";

const screenshotMock = vi.fn();
const isRunningMock = vi.fn();
const currentUrlMock = vi.fn();
const thumbnailMock = vi.fn();

vi.mock("../lib/browser/browser-manager.js", () => ({
  BrowserManager: {
    instance: () => ({
      screenshot: screenshotMock,
      isRunning: isRunningMock,
      currentUrl: currentUrlMock,
      thumbnail: thumbnailMock,
    }),
  },
}));

function makeCtx(sessionPath = "/tmp/session.jsonl") {
  return {
    sessionManager: {
      getSessionFile: () => sessionPath,
    },
  };
}

describe("browser screenshot vision adaptation", () => {
  let tmpDir = null;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-browser-shot-"));
    screenshotMock.mockResolvedValue({ base64: "SCREENSHOT_BASE64", mimeType: "image/png" });
    isRunningMock.mockReturnValue(true);
    currentUrlMock.mockReturnValue("https://example.test/page");
    thumbnailMock.mockResolvedValue("THUMBNAIL_BASE64");
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it("hides screenshot from no-screenshot schema and rejects direct screenshot calls", async () => {
    const prepare = vi.fn();
    const tool = createBrowserTool(() => "/tmp/session.jsonl", {
      getSessionModel: () => ({ id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] }),
      getVisionBridge: () => ({ prepare }),
      screenshotEnabled: false,
    });

    const result = await tool.execute("call-1", { action: "screenshot" }, null, null, makeCtx());

    expect(tool.parameters.properties.action.enum).not.toContain("screenshot");
    expect(screenshotMock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(result.details).toEqual(expect.objectContaining({ action: "screenshot", error: expect.any(String) }));
  });

  it("uses the vision bridge for text-only session models and keeps a display screenshot block", async () => {
    const prepare = vi.fn(async () => ({
      text: "Browser screenshot of https://example.test/page",
      images: undefined,
      visionNotes: ["image_overview: A page with a red warning banner."],
    }));
    const tool = createBrowserTool(() => "/tmp/session.jsonl", {
      getSessionModel: () => ({ id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] }),
      getVisionBridge: () => ({ prepare }),
    });

    const result = await tool.execute("call-1", { action: "screenshot" }, null, null, makeCtx());

    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      sessionPath: "/tmp/session.jsonl",
      targetModel: { id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] },
      images: [{ type: "image", data: "SCREENSHOT_BASE64", mimeType: "image/png" }],
    }));
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("image_overview: A page with a red warning banner.") },
    ]);
    expect(result.details).toEqual(expect.objectContaining({
      action: "screenshot",
      thumbnail: "SCREENSHOT_BASE64",
      visionAdapted: true,
    }));

    expect(extractBlocks("browser", result.details, result)).toEqual([
      { type: "screenshot", base64: "SCREENSHOT_BASE64", mimeType: "image/png" },
    ]);
  });

  it("keeps raw screenshot image content for image-capable session models", async () => {
    const prepare = vi.fn();
    const registerSessionFile = vi.fn(({ sessionPath, filePath, label, origin, storageKind }) => ({
      id: "sf_browser_shot",
      fileId: "sf_browser_shot",
      sessionPath,
      filePath,
      label,
      displayName: label,
      filename: path.basename(filePath),
      ext: "png",
      mime: "image/png",
      kind: "image",
      size: 8,
      origin,
      storageKind,
      status: "available",
      missingAt: null,
    }));
    const tool = createBrowserTool(() => "/tmp/session.jsonl", {
      getSessionModel: () => ({ id: "gpt-4o", provider: "openai", input: ["text", "image"] }),
      getVisionBridge: () => ({ prepare }),
      getCodiaHome: () => tmpDir,
      registerSessionFile,
    });

    const result = await tool.execute("call-1", { action: "screenshot" }, null, null, makeCtx());

    expect(prepare).not.toHaveBeenCalled();
    const registered = registerSessionFile.mock.calls[0][0];
    expect(fs.existsSync(registered.filePath)).toBe(true);
    expect(registered).toMatchObject({
      sessionPath: "/tmp/session.jsonl",
      label: expect.stringMatching(/^browser-screenshot-/),
      origin: "browser_screenshot",
      storageKind: "managed_cache",
    });
    expect(result.content).toEqual([
      { type: "image", data: "SCREENSHOT_BASE64", mimeType: "image/png" },
    ]);
    expect(result.details.screenshotFile).toMatchObject({
      fileId: "sf_browser_shot",
      filePath: registered.filePath,
      kind: "image",
      status: "available",
    });
    expect(extractBlocks("browser", result.details, result)).toEqual([
      expect.objectContaining({
        type: "file",
        fileId: "sf_browser_shot",
        filePath: registered.filePath,
        kind: "image",
        status: "available",
      }),
    ]);
  });

  it("returns a clear error for text-only screenshot adaptation when auxiliary vision is disabled", async () => {
    const prepare = vi.fn();
    const tool = createBrowserTool(() => "/tmp/session.jsonl", {
      getSessionModel: () => ({ id: "deepseek-v4-pro", provider: "deepseek", input: ["text"] }),
      getVisionBridge: () => ({ prepare }),
      isVisionAuxiliaryEnabled: () => false,
    });

    const result = await tool.execute("call-1", { action: "screenshot" }, null, null, makeCtx());

    expect(prepare).not.toHaveBeenCalled();
    expect(screenshotMock).not.toHaveBeenCalled();
    expect(result.content[0]).toEqual(expect.objectContaining({ type: "text" }));
    expect(result.details).toEqual(expect.objectContaining({
      action: "screenshot",
      visionAdapted: false,
      visionError: expect.stringContaining("vision auxiliary is disabled"),
    }));
  });
});
