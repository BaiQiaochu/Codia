import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

async function loadModule() {
  const mod = await import("../desktop/login-item-settings.cjs");
  return mod.default || mod;
}

function createAppMock(settings = {}) {
  return {
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false, ...settings })),
    setLoginItemSettings: vi.fn(),
  };
}

const APP_ID = "cn.edu.njust.byoung";
const CURRENT_EXE = "C:\\Program Files\\Codia\\Codia.exe";
const LEGACY_EXE = "C:\\Program Files\\Codia\\BYOUNG.exe";
const LOGIN_ARGS = ["--gsap-start-at-login"];

// A state model of Electron 42.3.0 browser_win.cc:636–699, not Windows IO.
// openAtLogin reads the AppUserModelID value, whereas launchItems enumerates
// matching paths in both scopes. Set(false) deletes by NAME, ignoring path.
function createRegistryApp(initialEntries = []) {
  const entries = new Map(initialEntries.map(([name, value]) => [name, {
    path: LEGACY_EXE, args: LOGIN_ARGS, enabled: true, scope: "user", ...value,
  }]));
  const app = {
    getLoginItemSettings: vi.fn((options) => {
      const current = entries.get(APP_ID);
      const launchItems = [...entries].filter(([, item]) =>
        item.path.toLowerCase() === options.path.toLowerCase())
        .map(([name, item]) => ({ name, ...item }));
      return {
        openAtLogin: current?.scope === "user" && current.path === options.path
          && JSON.stringify(current.args) === JSON.stringify(options.args),
        executableWillLaunchAtLogin: launchItems.some((item) => item.enabled),
        launchItems,
      };
    }),
    setLoginItemSettings: vi.fn((settings) => {
      const name = settings.name || APP_ID;
      if (settings.openAtLogin) {
        entries.set(name, {
          path: settings.path, args: settings.args,
          enabled: settings.enabled !== false, scope: "user",
        });
      } else {
        entries.delete(name);
      }
    }),
  };
  return { app, entries };
}

// Force only this helper's path boundary to Windows semantics. This regression
// can expose same-name deletion on Linux independently of host path resolution.
function loadWithWindowsPath() {
  const context = {
    module: { exports: {} }, process,
    require: (name) => {
      expect(name).toBe("node:path");
      return path.win32;
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL("../desktop/login-item-settings.cjs", import.meta.url), "utf8"), context);
  return context.module.exports as Awaited<ReturnType<typeof loadModule>>;
}

describe("login item settings", () => {
  it("uses a dedicated login-start argument on Windows so startup can stay hidden", async () => {
    const { START_AT_LOGIN_ARG, getLoginItemOptions, wasLaunchedAtLogin } = await loadModule();

    expect(getLoginItemOptions("win32", "C:\\Program Files\\G-SAP\\G-SAP.exe")).toEqual({
      path: "C:\\Program Files\\G-SAP\\G-SAP.exe",
      args: [START_AT_LOGIN_ARG],
    });
    expect(START_AT_LOGIN_ARG).toBe("--gsap-start-at-login");
    expect(wasLaunchedAtLogin({
      platform: "win32",
      argv: ["G-SAP.exe", START_AT_LOGIN_ARG],
      loginItemSettings: {},
    })).toBe(true);
  });

  it("reads macOS login launch state from Electron login item settings", async () => {
    const { wasLaunchedAtLogin } = await loadModule();

    expect(wasLaunchedAtLogin({
      platform: "darwin",
      argv: ["G-SAP"],
      loginItemSettings: { wasOpenedAtLogin: true },
    })).toBe(true);
  });

  it("reports Linux as unsupported without touching Electron login item APIs", async () => {
    const { getAutoLaunchStatus } = await loadModule();
    const app = createAppMock();

    expect(getAutoLaunchStatus({ app, platform: "linux", argv: [], execPath: "/opt/G-SAP/gsap" })).toEqual({
      supported: false,
      openAtLogin: false,
      openedAtLogin: false,
      status: "unsupported",
    });
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it("writes and re-reads Windows login item settings with the same path and args", async () => {
    const { START_AT_LOGIN_ARG, setAutoLaunchEnabled } = await loadModule();
    const app = createAppMock({ openAtLogin: true, executableWillLaunchAtLogin: true });

    const status = setAutoLaunchEnabled({
      app,
      platform: "win32",
      argv: [],
      execPath: "C:\\G-SAP\\G-SAP.exe",
      enabled: true,
    });

    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      path: "C:\\G-SAP\\G-SAP.exe",
      args: [START_AT_LOGIN_ARG],
    });
    expect(app.getLoginItemSettings).toHaveBeenCalledWith({
      path: "C:\\G-SAP\\G-SAP.exe",
      args: [START_AT_LOGIN_ARG],
    });
    expect(status).toMatchObject({
      supported: true,
      openAtLogin: true,
      openedAtLogin: false,
      executableWillLaunchAtLogin: true,
    });
  });

  it.each([false, true])("replaces the enabled legacy value once and survives repeated reads (explicit Win32 path: %s)", async (explicitPath) => {
    const { getAutoLaunchStatus } = explicitPath ? loadWithWindowsPath() : await loadModule();
    const { app, entries } = createRegistryApp([[APP_ID, {}]]);
    const options = { app, platform: "win32", argv: [], execPath: CURRENT_EXE };

    expect(getAutoLaunchStatus(options).openAtLogin).toBe(true);
    expect(entries.get(APP_ID)).toEqual({
      path: CURRENT_EXE, args: LOGIN_ARGS, enabled: true, scope: "user",
    });
    expect(getAutoLaunchStatus(options).openAtLogin).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true, path: CURRENT_EXE, args: LOGIN_ARGS,
    });
  });

  it.each([
    ["absent", []],
    ["already current", [[APP_ID, { path: CURRENT_EXE }]]],
    ["disabled in Task Manager", [[APP_ID, { enabled: false }]]],
    ["disabled current", [[APP_ID, { path: CURRENT_EXE, enabled: false }]]],
    ["differently named legacy", [["BYOUNG", {}]]],
    ["ambiguous duplicate legacy", [[APP_ID, {}], ["BYOUNG", {}]]],
    ["different legacy arguments", [[APP_ID, { args: ["--other-mode"] }]]],
    ["machine scope", [["machine-entry", { scope: "machine" }]]],
  ])("does not mutate %s startup state during reads", (_name, initial) => {
    const { getAutoLaunchStatus } = loadWithWindowsPath();
    const { app, entries } = createRegistryApp(initial);
    const before = structuredClone([...entries]);
    const options = { app, platform: "win32", argv: [], execPath: CURRENT_EXE };
    getAutoLaunchStatus(options);
    getAutoLaunchStatus(options);
    expect([...entries]).toEqual(before);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("does not infer the default entry's enabled state from another entry for the same executable", () => {
    const { getAutoLaunchStatus } = loadWithWindowsPath();
    const { app, entries } = createRegistryApp([
      [APP_ID, { enabled: false }],
      ["other-mode", { args: ["--other-mode"] }],
    ]);
    getAutoLaunchStatus({ app, platform: "win32", argv: [], execPath: CURRENT_EXE });
    expect(entries.get(APP_ID).enabled).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("does not migrate without verifiable launchItems metadata", () => {
    const { getAutoLaunchStatus } = loadWithWindowsPath();
    const app = createAppMock({ openAtLogin: false });
    app.getLoginItemSettings.mockReturnValueOnce({ openAtLogin: false })
      .mockReturnValue({ openAtLogin: true });
    getAutoLaunchStatus({ app, platform: "win32", argv: [], execPath: CURRENT_EXE });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("honors an explicit disable without reviving legacy state on the subsequent read", async () => {
    const { setAutoLaunchEnabled, getAutoLaunchStatus } = await loadModule();
    const { app, entries } = createRegistryApp([[APP_ID, {}], ["BYOUNG", {}]]);
    const options = { app, platform: "win32", argv: [], execPath: CURRENT_EXE };
    expect(setAutoLaunchEnabled({ ...options, enabled: false }).openAtLogin).toBe(false);
    expect(getAutoLaunchStatus(options).openAtLogin).toBe(false);
    expect(entries.has(APP_ID)).toBe(false);
    expect(entries.has("BYOUNG")).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
  });

  it("enables a disabled legacy entry only when explicitly requested", async () => {
    const { setAutoLaunchEnabled } = await loadModule();
    const { app, entries } = createRegistryApp([[APP_ID, { enabled: false }]]);
    const status = setAutoLaunchEnabled({ app, enabled: true, platform: "win32", argv: [], execPath: CURRENT_EXE });
    expect(status).toMatchObject({ openAtLogin: true, executableWillLaunchAtLogin: true });
    expect(entries.get(APP_ID).path).toBe(CURRENT_EXE);
    expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
  });
});
