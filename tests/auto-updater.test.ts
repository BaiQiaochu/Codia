import { describe, it, expect, vi, beforeEach } from "vitest";
import "./setup-auto-updater.js";

// ── Mocks（必须在 import 之前声明）──

const mockAutoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  checkForUpdates: vi.fn().mockResolvedValue({}),
  downloadUpdate: vi.fn().mockResolvedValue(null),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn(),
};

let mockAppVersion = "1.0.0";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: true,
    getVersion: () => mockAppVersion,
    getPath: (name) => {
      if (name === "exe") return "/Applications/G-SAP.app/Contents/MacOS/G-SAP";
      if (name === "userData") return "/tmp/test-userdata";
      return "/tmp";
    },
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

describe("auto-updater", () => {
  let handlers;
  let ipcHandlers;
  let mod;
  let ipcMain;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.GSAP_UPDATE_FEED_URL;
    mockAppVersion = "1.0.0";
    handlers = {};
    ipcHandlers = {};

    mockAutoUpdater.on.mockImplementation((event, handler) => {
      handlers[event] = handler;
    });
    mockAutoUpdater.checkForUpdates.mockResolvedValue({});
    mockAutoUpdater.autoDownload = true;
    mockAutoUpdater.autoInstallOnAppQuit = true;
    mockAutoUpdater.allowPrerelease = false;

    ({ ipcMain } = await import("electron"));
    ipcMain.handle.mockImplementation((channel, handler) => {
      ipcHandlers[channel] = handler;
    });

    mod = await import("../desktop/auto-updater.cjs");
  });

  function initWithMockWindow() {
    const win = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    mod.initAutoUpdater(win);
    return win;
  }

  it("should configure autoUpdater correctly", () => {
    initWithMockWindow();
    expect(mockAutoUpdater.autoDownload).toBe(false);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("should map update-available to available state", async () => {
    initWithMockWindow();
    if (handlers["update-available"]) {
      await handlers["update-available"]({ version: "2.0.0", releaseNotes: "New features" });
    }
    const state = mod.getState();
    expect(state.version).toBe("2.0.0");
    expect(["available", "downloading", "error"]).toContain(state.status);
  });

  it("should map update-not-available to latest state", () => {
    initWithMockWindow();
    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }
    expect(mod.getState().status).toBe("latest");
  });

  it("treats missing latest metadata as latest instead of error", () => {
    initWithMockWindow();
    if (handlers.error) {
      handlers.error(new Error("Cannot find latest-mac.yml, 404"));
    }
    expect(mod.getState()).toMatchObject({ status: "latest", error: null });
  });

  it("treats missing latest metadata during manual check as latest", async () => {
    process.env.GSAP_UPDATE_FEED_URL = "https://updates.example.invalid";
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("latest.yml not found 404"));
    initWithMockWindow();

    await ipcHandlers["auto-update-check"]();

    expect(mod.getState()).toMatchObject({ status: "latest", error: null });
  });

  it("should set allowPrerelease on channel change", () => {
    initWithMockWindow();
    mod.setUpdateChannel("beta");
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
    mod.setUpdateChannel("stable");
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });

  it("should map download-progress to downloading state", () => {
    initWithMockWindow();
    if (handlers["download-progress"]) {
      handlers["download-progress"]({
        percent: 42.5, bytesPerSecond: 1024000, transferred: 50000, total: 120000,
      });
    }
    const state = mod.getState();
    expect(state.status).toBe("downloading");
    expect(state.progress.percent).toBe(43);
  });

  it("should map update-downloaded to downloaded state", () => {
    initWithMockWindow();
    if (handlers["update-downloaded"]) {
      handlers["update-downloaded"]({ version: "2.0.0" });
    }
    expect(mod.getState().status).toBe("downloaded");
  });

  it("second init reuses process-level setup and only updates mainWindow reference", () => {
    const win1 = initWithMockWindow();
    const win2 = {
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    mod.initAutoUpdater(win2);

    expect(mockAutoUpdater.on).toHaveBeenCalledTimes(6);
    expect(ipcMain.handle).toHaveBeenCalledTimes(5);

    if (handlers["update-not-available"]) {
      handlers["update-not-available"]();
    }

    expect(win1.webContents.send).not.toHaveBeenCalledWith("auto-update-state", expect.anything());
    expect(win2.webContents.send).toHaveBeenCalledWith("auto-update-state", expect.objectContaining({ status: "latest" }));
  });

  it("does not load electron-updater when app version is not strict semver", async () => {
    vi.resetModules();
    mockAppVersion = "0.7.02";

    mod = await import("../desktop/auto-updater.cjs");

    expect(() => initWithMockWindow()).not.toThrow();
    expect(mockAutoUpdater.on).not.toHaveBeenCalled();
    expect(mod.getState()).toMatchObject({
      status: "disabled",
      error: "invalid_app_version_for_auto_update",
    });
  });
});
