// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodiaEngine } from "../core/engine.js";

describe("CodiaEngine Computer Use lazy runtime", () => {
  let tmpDir = null;
  let engine = null;

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
  });

  function createEngine() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-engine-computer-use-"));
    engine = new CodiaEngine({
      codiaHome: tmpDir,
      productDir: tmpDir,
      agentId: "codia",
    });
    return engine;
  }

  it("does not construct the Computer Use runtime during engine construction", () => {
    const engine = createEngine();

    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
  });

  it("constructs and disposes the Computer Use runtime through the global switch", async () => {
    const engine = createEngine();

    const disabled = await engine.updateComputerUseSettings({ enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();

    const enabled = await engine.updateComputerUseSettings({ enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(engine._computerProviders).toBeTruthy();
    expect(engine._computerHost).toBeTruthy();

    const dispose = vi.fn(async () => {});
    engine._computerHost.dispose = dispose;

    const disabledAgain = await engine.updateComputerUseSettings({ enabled: false });
    expect(disabledAgain.enabled).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
    expect(engine._computerProviders).toBeNull();
    expect(engine._computerHost).toBeNull();
  });

  it("disposes the lazy Computer Use runtime during engine shutdown", async () => {
    const engine = createEngine();
    await engine.updateComputerUseSettings({ enabled: true });
    const dispose = vi.fn(async () => {});
    engine._computerHost.dispose = dispose;

    await engine.dispose();

    expect(dispose).toHaveBeenCalledOnce();
    expect(engine._computerHost).toBeNull();
    expect(engine._computerProviders).toBeNull();
  });
});
