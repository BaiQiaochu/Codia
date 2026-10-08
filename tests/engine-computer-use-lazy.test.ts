// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GsapEngine } from "../core/engine.js";

const platformContext = vi.hoisted(() => ({ platform: process.platform }));
// Simulate only the capability boundary. The real platform policy computes
// both support and effective settings; native paths, SDK imports, providers,
// and the runtime lifecycle remain real. No desktop actions are dispatched.
vi.mock("../core/computer-use/platform-support.ts", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    isComputerUsePlatformSupported: () => actual.isComputerUsePlatformSupported(platformContext.platform),
    effectiveComputerUseSettings: (settings) => actual.effectiveComputerUseSettings(settings, { platform: platformContext.platform }),
  };
});

describe("GsapEngine Computer Use lazy runtime", () => {
  let tmpDir = null;
  let engine = null;

  beforeEach(() => { platformContext.platform = process.platform; });

  afterEach(async () => {
    if (engine) {
      await engine.dispose?.().catch?.(() => {});
      engine = null;
    }
    if (tmpDir) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
    tmpDir = null;
    platformContext.platform = process.platform;
  });

  function createEngine() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-engine-computer-use-"));
    engine = new GsapEngine({
      gsapHome: tmpDir,
      productDir: tmpDir,
      agentId: "gsap",
    });
    return engine;
  }

  it("does not construct the Computer Use runtime during engine construction", () => {
    const engine = createEngine();

    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
  });

  it.each(["darwin", "win32"])("constructs and disposes the Computer Use runtime through the %s global switch", async (platform) => {
    platformContext.platform = platform;
    const engine = createEngine();

    const disabled = await engine.updateComputerUseSettings({ enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();

    const enabled = await engine.updateComputerUseSettings({ enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(engine._computerProviders).toBeTruthy();
    expect(engine._computerHost).toBeTruthy();
    expect(engine._prefs.getComputerUseSettings().enabled).toBe(true);
    const firstHost = engine._computerHost;
    await engine.updateComputerUseSettings({ enabled: true });
    expect(engine._computerHost).toBe(firstHost);

    const dispose = vi.fn(async () => {});
    engine._computerHost.dispose = dispose;

    const disabledAgain = await engine.updateComputerUseSettings({ enabled: false });
    expect(disabledAgain.enabled).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
    await engine.updateComputerUseSettings({ enabled: false });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32"])("disposes the lazy Computer Use runtime during %s engine shutdown", async (platform) => {
    platformContext.platform = platform;
    const engine = createEngine();
    await engine.updateComputerUseSettings({ enabled: true });
    const dispose = vi.fn(async () => {});
    engine._computerHost.dispose = dispose;

    await engine.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(engine._computerHost).toBeNull();
    expect(engine._computerProviders).toBeNull();
  });

  it("rejects Linux enablement without persisting it or creating a runtime", async () => {
    platformContext.platform = "linux";
    const engine = createEngine();
    const storedBefore = engine._prefs.getComputerUseSettings();
    const save = vi.spyOn(engine._prefs, "setComputerUseSettings");

    expect(engine.isComputerUseSupported()).toBe(false);
    await expect(engine.updateComputerUseSettings({ enabled: true })).rejects.toThrow("not supported");
    expect(save).not.toHaveBeenCalled();
    expect(engine._prefs.getComputerUseSettings()).toEqual(storedBefore);
    expect(engine.getComputerUseSettings().enabled).toBe(false);
    expect(() => engine.getComputerHost()).toThrow("not supported");
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
    await expect(engine.updateComputerUseSettings({ enabled: false })).resolves.toMatchObject({ enabled: false });
  });

  it("keeps previously enabled preferences ineffective on Linux without constructing a runtime", () => {
    platformContext.platform = "linux";
    const engine = createEngine();
    engine._prefs.setComputerUseSettings({ enabled: true });
    expect(engine._prefs.getComputerUseSettings().enabled).toBe(true);
    expect(engine.getComputerUseSettings().enabled).toBe(false);
    expect(engine._computerHost).toBeNull();
    expect(engine._computerProviders).toBeNull();
  });

  it.each(["darwin", "win32"])("clears the %s runtime even when its dispose fails", async (platform) => {
    platformContext.platform = platform;
    const engine = createEngine();
    await engine.updateComputerUseSettings({ enabled: true });
    const dispose = vi.fn(async () => { throw new Error("fixture disposal failure"); });
    engine._computerHost.dispose = dispose;

    await expect(engine.updateComputerUseSettings({ enabled: false })).rejects.toThrow("fixture disposal failure");
    expect(engine._computerHost).toBeNull();
    expect(engine._computerProviders).toBeNull();
    expect(engine.getComputerUseSettings().enabled).toBe(false);
    await engine.disposeComputerRuntime();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
