import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const mainDisplay = {
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
};

describe("desktop window state restore", () => {
  it("preserves a valid saved window state", () => {
    const { sanitizeWindowState } = require("../desktop/src/shared/window-state.cjs");

    expect(sanitizeWindowState({
      x: 120,
      y: 80,
      width: 960,
      height: 700,
      isMaximized: true,
    }, [mainDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: 120,
      y: 80,
      width: 960,
      height: 700,
      isMaximized: true,
    });
  });

  it("keeps a window that is intentionally near the visible edge", () => {
    const { sanitizeWindowState } = require("../desktop/src/shared/window-state.cjs");

    expect(sanitizeWindowState({
      x: -20,
      y: 40,
      width: 960,
      height: 700,
      isMaximized: false,
    }, [mainDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: -20,
      y: 40,
      width: 960,
      height: 700,
      isMaximized: false,
    });
  });

  it("preserves a valid saved window state on a larger secondary display", () => {
    const { sanitizeWindowState } = require("../desktop/src/shared/window-state.cjs");
    const secondaryDisplay = {
      workArea: { x: 1440, y: 0, width: 1920, height: 1080 },
    };

    expect(sanitizeWindowState({
      x: 1500,
      y: 80,
      width: 1600,
      height: 900,
      isMaximized: false,
    }, [mainDisplay, secondaryDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: 1500,
      y: 80,
      width: 1600,
      height: 900,
      isMaximized: false,
    });
  });

  it("recenters an offscreen saved state onto the primary display", () => {
    const { sanitizeWindowState } = require("../desktop/src/shared/window-state.cjs");

    expect(sanitizeWindowState({
      x: -2400,
      y: 120,
      width: 960,
      height: 820,
      isMaximized: false,
    }, [mainDisplay], { defaultWidth: 960, defaultHeight: 820 })).toEqual({
      x: 240,
      y: 40,
      width: 960,
      height: 820,
      isMaximized: false,
    });
  });

  it("sanitizes saved bounds before constructing the main window", () => {
    const source = fs.readFileSync(path.resolve("desktop/main.cjs"), "utf-8");

    expect(source).toContain('require("./src/shared/window-state.cjs")');
    expect(source).toContain("sanitizeWindowState(loadWindowState(windowStatePath), screen.getAllDisplays()");
  });

  it("loads missing or invalid window state as null", () => {
    const { loadWindowState } = require("../desktop/src/shared/window-state.cjs");

    expect(loadWindowState("/missing/window-state.json", {
      readFileSync: () => {
        throw new Error("missing");
      },
    })).toBeNull();
    expect(loadWindowState("/invalid/window-state.json", {
      readFileSync: () => "{",
    })).toBeNull();
  });

  it("writes normal bounds for maximized windows through the shared saver", async () => {
    const { createWindowStateSaver } = require("../desktop/src/shared/window-state.cjs");
    const writeFile = vi.fn(async () => {});
    const saver = createWindowStateSaver({
      filePath: "window-state.json",
      getWindow: () => ({
        isDestroyed: () => false,
        isMaximized: () => true,
        getNormalBounds: () => ({ x: 100, y: 50, width: 1100, height: 760 }),
        getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
      }),
      writeFile,
    });

    await saver.flush();

    expect(writeFile).toHaveBeenCalledWith(
      "window-state.json",
      JSON.stringify({ x: 100, y: 50, width: 1100, height: 760, isMaximized: true }, null, 2) + "\n",
    );
  });

  it("keeps window state persistence out of main process inline timers", () => {
    const source = fs.readFileSync(path.resolve("desktop/main.cjs"), "utf-8");

    expect(source).toContain("createWindowStateSaver({");
    expect(source).not.toContain("let _saveWindowStateTimer");
  });
});
