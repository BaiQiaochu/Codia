import { describe, expect, it, vi } from "vitest";

async function loadModule() {
  const mod = await import("../desktop/keep-awake.cjs");
  return mod.default || mod;
}

function createPowerSaveBlockerMock() {
  return {
    start: vi.fn(() => 42),
    stop: vi.fn(() => true),
    isStarted: vi.fn(() => true),
  };
}

describe("keep awake manager", () => {
  it("starts only prevent-app-suspension when enabled", async () => {
    const { createKeepAwakeManager } = await loadModule();
    const powerSaveBlocker = createPowerSaveBlockerMock();
    const manager = createKeepAwakeManager({ powerSaveBlocker });

    const status = manager.setEnabled(true);

    expect(powerSaveBlocker.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(powerSaveBlocker.start).not.toHaveBeenCalledWith("prevent-display-sleep");
    expect(status).toEqual({
      enabled: true,
      active: true,
      blockerId: 42,
      type: "prevent-app-suspension",
    });
  });

  it("stops the active blocker when disabled", async () => {
    const { createKeepAwakeManager } = await loadModule();
    const powerSaveBlocker = createPowerSaveBlockerMock();
    const manager = createKeepAwakeManager({ powerSaveBlocker });

    manager.setEnabled(true);
    const status = manager.setEnabled(false);

    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(42);
    expect(status).toEqual({
      enabled: false,
      active: false,
      blockerId: null,
      type: "prevent-app-suspension",
    });
  });

  it("does not report enabled when starting the blocker fails", async () => {
    const { createKeepAwakeManager } = await loadModule();
    const powerSaveBlocker = createPowerSaveBlockerMock();
    powerSaveBlocker.start.mockImplementation(() => {
      throw new Error("blocked");
    });
    const manager = createKeepAwakeManager({ powerSaveBlocker });

    expect(() => manager.setEnabled(true)).toThrow("blocked");
    expect(manager.getStatus()).toEqual({
      enabled: false,
      active: false,
      blockerId: null,
      type: "prevent-app-suspension",
    });
  });
});
