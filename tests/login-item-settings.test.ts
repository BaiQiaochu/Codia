import { describe, expect, it, vi } from "vitest";

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

  it("moves an enabled legacy BYOUNG login item to Codia and retires the old entry", async () => {
    const { getAutoLaunchStatus, START_AT_LOGIN_ARG } = await loadModule();
    const app = {
      getLoginItemSettings: vi.fn()
        .mockReturnValueOnce({ openAtLogin: false })
        .mockReturnValueOnce({ openAtLogin: true })
        .mockReturnValueOnce({ openAtLogin: true }),
      setLoginItemSettings: vi.fn(),
    };

    const status = getAutoLaunchStatus({
      app,
      platform: "win32",
      argv: [],
      execPath: "C:\\Program Files\\Codia\\Codia.exe",
    });

    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(1, {
      openAtLogin: true,
      path: "C:\\Program Files\\Codia\\Codia.exe",
      args: [START_AT_LOGIN_ARG],
    });
    expect(app.setLoginItemSettings).toHaveBeenNthCalledWith(2, {
      openAtLogin: false,
      path: "C:\\Program Files\\Codia\\BYOUNG.exe",
      args: [START_AT_LOGIN_ARG],
    });
    expect(status.openAtLogin).toBe(true);
  });
});
