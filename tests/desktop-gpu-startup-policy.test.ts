import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "module";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);

const {
  applyGpuStartupPolicy,
  markGpuStartupFailed,
  markGpuStartupPhase,
  markGpuStartupPending,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  resolveGpuStartupPolicy,
} = require("../desktop/src/shared/gpu-startup-policy.cjs");

let root;

function makeHome() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-gpu-policy-"));
  return root;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function writePrefs(gsapHome, prefs) {
  const prefsPath = path.join(gsapHome, "user", "preferences.json");
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
}

function readPrefs(gsapHome) {
  return readJson(path.join(gsapHome, "user", "preferences.json"));
}

describe("desktop GPU startup policy", () => {
  beforeEach(() => {
    root = null;
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps hardware acceleration enabled by default", () => {
    const gsapHome = makeHome();

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
    expect(policy.reason).toBe("default");
  });

  it("honors the user hardware acceleration preference", () => {
    const gsapHome = makeHome();
    writePrefs(gsapHome, { hardware_acceleration: false });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(false);
    expect(policy.shouldDisableHardwareAcceleration).toBe(true);
    expect(policy.reason).toBe("preference");
  });

  it("honors explicit G-SAP safe mode flags and legacy aliases", () => {
    const gsapHome = makeHome();

    expect(resolveGpuStartupPolicy({
      gsapHome,
      argv: ["G-SAP.exe", "--gsap-disable-hardware-acceleration"],
      env: {},
    }).reason).toBe("explicit");
    expect(resolveGpuStartupPolicy({
      gsapHome,
      argv: ["G-SAP.exe"],
      env: { HANA_GPU_SAFE_MODE: "1" },
    }).reason).toBe("explicit");
  });

  it("records the active policy on the pending startup marker", () => {
    const gsapHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: { GSAP_GPU_SANDBOX_COMPAT: "1" },
    });

    markGpuStartupPending({
      gsapHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "launch-with-policy",
      policy,
      now: "2026-05-19T01:00:00.000Z",
    });

    const state = readJson(path.join(gsapHome, "user", "gpu-startup.json"));
    expect(state.startup.policy).toEqual({
      mode: "gpu-sandbox-compat",
      reason: "explicit",
      hardwareAccelerationEnabled: true,
      shouldDisableHardwareAcceleration: false,
      shouldApplyGpuSandboxCompatSwitches: true,
      shouldApplyDeepCompatSwitches: false,
      shouldApplyUnsafeNoSandboxSwitch: false,
    });
  });

  it("turns on GPU sandbox compatibility on Windows after an incomplete startup", () => {
    const gsapHome = makeHome();
    markGpuStartupPending({
      gsapHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: {},
      now: "2026-05-19T01:01:00.000Z",
    });

    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldApplyGpuSandboxCompatSwitches).toBe(true);
    const state = readJson(path.join(gsapHome, "user", "gpu-startup.json"));
    expect(state.autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "previous-startup-incomplete",
      previousMode: "hardware",
    });
  });

  it("migrates legacy automatic safe mode into GPU sandbox compatibility", () => {
    const gsapHome = makeHome();
    writePrefs(gsapHome, { hardware_acceleration: false, locale: "zh" });
    const statePath = path.join(gsapHome, "user", "gpu-startup.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      safeMode: {
        enabled: true,
        reason: "previous-startup-incomplete",
        previousStartup: { startupId: "old-launch" },
      },
    }), "utf-8");

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: {},
      now: "2026-05-21T01:01:00.000Z",
    });

    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.reason).toBe("legacy-auto-safe-mode-migration");
    expect(readPrefs(gsapHome)).toEqual({ locale: "zh" });
    expect(readJson(statePath).autoGpuMode).toMatchObject({
      mode: "gpu-sandbox-compat",
      reason: "legacy-auto-safe-mode-migration",
      previousMode: "software-safe",
    });
  });

  it("does not auto-disable hardware acceleration for non-Windows stale startup markers", () => {
    const gsapHome = makeHome();
    markGpuStartupPending({
      gsapHome,
      platform: "darwin",
      phase: "launching-splash",
      startupId: "previous-launch",
      now: "2026-05-19T01:00:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "darwin",
      argv: ["G-SAP"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.shouldDisableHardwareAcceleration).toBe(false);
  });

  it("records GPU child process crashes as next-launch GPU sandbox compatibility", () => {
    const gsapHome = makeHome();

    recordGpuChildProcessGone({
      gsapHome,
      platform: "win32",
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.reason).toBe("gpu-child-process-gone");
    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.shouldApplyGpuSandboxCompatSwitches).toBe(true);
    expect(fs.existsSync(path.join(gsapHome, "user", "preferences.json"))).toBe(false);
  });

  it("escalates repeated GPU crashes to deep compatibility switches", () => {
    const gsapHome = makeHome();

    recordGpuChildProcessGone({
      gsapHome,
      platform: "win32",
      policy: { mode: "software-safe" },
      details: { type: "GPU", reason: "crashed", exitCode: -2147483645 },
      now: "2026-05-19T01:02:00.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: {},
    });
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };

    expect(policy.mode).toBe("deep-compat");
    expect(policy.shouldApplyDeepCompatSwitches).toBe(true);
    expect(applyGpuStartupPolicy(app, policy)).toMatchObject({ applied: true, deepCompat: true });
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-compositing");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-rasterization");
  });

  it("clears the pending marker when startup reaches app-ready", () => {
    const gsapHome = makeHome();
    markGpuStartupPending({
      gsapHome,
      platform: "win32",
      phase: "launching-splash",
      startupId: "launch-1",
    });

    markGpuStartupReady({
      gsapHome,
      platform: "win32",
      startupId: "launch-1",
      phase: "app-ready",
    });

    const state = readJson(path.join(gsapHome, "user", "gpu-startup.json"));
    expect(state.startup.status).toBe("ready");
    expect(state.startup.phase).toBe("app-ready");
  });

  it("marks startup failures without converting them into GPU safe mode", () => {
    const gsapHome = makeHome();
    markGpuStartupPending({
      gsapHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "launch-1",
    });
    markGpuStartupFailed({
      gsapHome,
      platform: "win32",
      startupId: "launch-1",
      reason: "server-start-failed",
    });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      env: {},
    });

    expect(policy.hardwareAccelerationEnabled).toBe(true);
    expect(policy.reason).toBe("default");
  });

  it("uses Electron's hardware acceleration API without unsafe GPU fallback switches", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: { appendSwitch: vi.fn() },
    };

    applyGpuStartupPolicy(app, {
      shouldDisableHardwareAcceleration: true,
      reason: "preference",
    });

    expect(app.disableHardwareAcceleration).toHaveBeenCalledTimes(1);
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-software-rasterizer", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("disable-gpu-sandbox", expect.anything());
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox", expect.anything());
  });

  it("applies GPU sandbox compatibility without disabling hardware acceleration globally", () => {
    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        hasSwitch: vi.fn(() => false),
        getSwitchValue: vi.fn(() => ""),
      },
    };

    const applied = applyGpuStartupPolicy(app, {
      mode: "gpu-sandbox-compat",
      shouldApplyGpuSandboxCompatSwitches: true,
      shouldDisableHardwareAcceleration: false,
    });

    expect(applied).toMatchObject({ applied: true, gpuSandboxCompat: true, unsafeNoSandbox: false });
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled();
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-sandbox");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-features", "GpuSandbox");
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalledWith("no-sandbox");
  });

  it("does not enter GPU recovery for a startup that only reached server phases", () => {
    const gsapHome = makeHome();
    markGpuStartupPending({
      gsapHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "server-only",
      now: "2026-06-26T00:00:00.000Z",
    });
    markGpuStartupPhase({
      gsapHome,
      platform: "win32",
      phase: "server-starting",
      startupId: "server-only",
      now: "2026-06-26T00:00:01.000Z",
    });
    markGpuStartupPhase({
      gsapHome,
      platform: "win32",
      phase: "server-ready",
      startupId: "server-only",
      now: "2026-06-26T00:00:02.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      now: "2026-06-26T00:01:00.000Z",
    });

    expect(policy.mode).toBe("hardware");
    expect(policy.reason).toBe("default");
    expect(policy.shouldApplyGpuSandboxCompatSwitches).toBe(false);
  });

  it("re-enables GPU recovery when startup reaches window creation after server boot", () => {
    const gsapHome = makeHome();
    markGpuStartupPending({
      gsapHome,
      platform: "win32",
      phase: "electron-starting",
      startupId: "hidden-launch",
      now: "2026-06-26T01:00:00.000Z",
    });
    markGpuStartupPhase({
      gsapHome,
      platform: "win32",
      phase: "server-ready",
      startupId: "hidden-launch",
      now: "2026-06-26T01:00:01.000Z",
    });
    markGpuStartupPhase({
      gsapHome,
      platform: "win32",
      phase: "main-window-starting",
      startupId: "hidden-launch",
      now: "2026-06-26T01:00:02.000Z",
    });

    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe"],
      now: "2026-06-26T01:01:00.000Z",
    });
    const state = readJson(path.join(gsapHome, "user", "gpu-startup.json"));

    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.reason).toBe("previous-startup-incomplete");
    expect(state.autoGpuMode.previousStartup.gpuRecovery).toMatchObject({
      eligible: true,
      phase: "main-window-starting",
    });
  });

  it("allows explicit unsafe no-sandbox only through diagnostic flags", () => {
    const gsapHome = makeHome();
    const policy = resolveGpuStartupPolicy({
      gsapHome,
      platform: "win32",
      argv: ["G-SAP.exe", "--gsap-gpu-unsafe-no-sandbox"],
      env: {},
    });

    const app = {
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        hasSwitch: vi.fn(() => false),
        getSwitchValue: vi.fn(() => ""),
      },
    };

    expect(policy.mode).toBe("gpu-sandbox-compat");
    expect(policy.shouldApplyUnsafeNoSandboxSwitch).toBe(true);
    applyGpuStartupPolicy(app, policy);
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu-sandbox");
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith("no-sandbox");
  });
});
