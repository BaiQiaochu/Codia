import { describe, expect, it, vi } from "vitest";
import policy from "../desktop/src/shared/desktop-notification-policy.cjs";

const {
  normalizeDesktopNotificationOptions,
  shouldSuppressDesktopNotification,
} = policy;

describe("desktop notification focus policy", () => {
  it("keeps legacy notifications on the always policy", () => {
    expect(normalizeDesktopNotificationOptions(null)).toEqual({
      desktopFocusPolicy: "always",
      sessionPath: null,
    });
    expect(normalizeDesktopNotificationOptions({ desktopFocusPolicy: "bad" })).toEqual({
      desktopFocusPolicy: "always",
      sessionPath: null,
    });
  });

  it("suppresses when_unfocused notifications while a Codia window is focused", () => {
    const getFocusedWindow = vi.fn(() => ({ isDestroyed: () => false }));

    expect(shouldSuppressDesktopNotification(
      { desktopFocusPolicy: "when_unfocused" },
      { getFocusedWindow },
    )).toBe(true);
  });

  it("allows when_unfocused notifications when no Codia window is focused", () => {
    expect(shouldSuppressDesktopNotification(
      { desktopFocusPolicy: "when_unfocused" },
      { getFocusedWindow: () => null },
    )).toBe(false);
  });

  it("suppresses session-scoped notifications only when their session window is focused", () => {
    const focusedWindow = { isDestroyed: () => false };
    const deps = {
      getFocusedWindow: () => focusedWindow,
      getWindowSessionPath: () => "/sessions/current.jsonl",
    };

    expect(shouldSuppressDesktopNotification(
      { desktopFocusPolicy: "when_session_unfocused", sessionPath: "/sessions/current.jsonl" },
      deps,
    )).toBe(true);
    expect(shouldSuppressDesktopNotification(
      { desktopFocusPolicy: "when_session_unfocused", sessionPath: "/sessions/other.jsonl" },
      deps,
    )).toBe(false);
  });
});
