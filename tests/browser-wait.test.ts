import { describe, expect, it, vi } from "vitest";
import {
  normalizeWaitState,
  waitForBrowserState,
} from "../desktop/src/shared/browser-wait.cjs";

describe("browser wait contract", () => {
  it("normalizes supported wait states and keeps idle as a stable alias", () => {
    expect(normalizeWaitState("domcontentloaded")).toBe("domcontentloaded");
    expect(normalizeWaitState("load")).toBe("load");
    expect(normalizeWaitState("stable")).toBe("stable");
    expect(normalizeWaitState("networkidle")).toBe("networkidle");
    expect(normalizeWaitState("idle")).toBe("stable");
    expect(normalizeWaitState("unknown")).toBe("stable");
  });

  it("returns when the requested DOM readiness state is reached", async () => {
    const webContents = {
      executeJavaScript: vi.fn().mockResolvedValue({
        readyState: "interactive",
        elementCount: 3,
        textLength: 12,
        bodyHeight: 400,
        mutationAgeMs: 0,
      }),
    };

    const diagnostics = await waitForBrowserState(webContents, {
      state: "domcontentloaded",
      timeoutMs: 50,
      pollMs: 1,
    });

    expect(diagnostics).toMatchObject({
      state: "domcontentloaded",
      timedOut: false,
      reason: "state-ready",
      lastReadyState: "interactive",
    });
    expect(webContents.executeJavaScript).toHaveBeenCalledTimes(1);
  });

  it("waits for a stable DOM signature before returning stable", async () => {
    const sample = {
      readyState: "complete",
      elementCount: 8,
      textLength: 40,
      bodyHeight: 900,
      mutationAgeMs: 0,
    };
    const webContents = {
      executeJavaScript: vi.fn().mockResolvedValue(sample),
    };

    const diagnostics = await waitForBrowserState(webContents, {
      state: "stable",
      timeoutMs: 100,
      pollMs: 1,
      quietMs: 10000,
      stableSamples: 2,
    });

    expect(diagnostics).toMatchObject({
      state: "stable",
      timedOut: false,
      reason: "dom-stable",
      lastElementCount: 8,
      lastTextLength: 40,
    });
    expect(webContents.executeJavaScript).toHaveBeenCalledTimes(2);
  });

  it("returns timeout diagnostics instead of silently sleeping past an unmet state", async () => {
    const webContents = {
      executeJavaScript: vi.fn().mockResolvedValue({
        readyState: "loading",
        elementCount: 0,
        textLength: 0,
        bodyHeight: 0,
        mutationAgeMs: 0,
      }),
    };

    const diagnostics = await waitForBrowserState(webContents, {
      state: "load",
      timeoutMs: 5,
      pollMs: 1,
    });

    expect(diagnostics).toMatchObject({
      state: "load",
      timedOut: true,
      reason: "timeout",
      lastReadyState: "loading",
    });
  });
});
