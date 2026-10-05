import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  DEFAULT_QUICK_CHAT_SHORTCUT,
  normalizeQuickChatPreferences,
} from "../shared/quick-chat-preferences.ts";
import { createPreferencesRoute } from "../server/routes/preferences.js";

describe("quick chat preferences", () => {
  it("defaults to the global quick chat shortcut", () => {
    expect(DEFAULT_QUICK_CHAT_SHORTCUT).toBe("Alt+Space");
    expect(DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES).toBe(10);
    expect(normalizeQuickChatPreferences()).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 10,
    });
  });

  it("normalizes shortcuts and idle reuse timeout", () => {
    expect(normalizeQuickChatPreferences({
      shortcut: "CommandOrControl+Shift+K",
      reuseTimeoutMinutes: "12.7",
    })).toEqual({
      shortcut: "CommandOrControl+Shift+K",
      reuseTimeoutMinutes: 13,
    });
    expect(normalizeQuickChatPreferences({ shortcut: "Alt+\u00A0", reuseTimeoutMinutes: -1 })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 0,
    });
    expect(normalizeQuickChatPreferences({ shortcut: "Alt+", reuseTimeoutMinutes: 999 })).toEqual({
      shortcut: "Alt+Space",
      reuseTimeoutMinutes: 120,
    });
  });

  it("reads and updates quick chat preferences through the preferences route", async () => {
    let quickChat = { shortcut: "Alt+Space", reuseTimeoutMinutes: 10 };
    const engine = {
      getSharedModels: vi.fn(() => ({})),
      getSearchConfig: vi.fn(() => ({})),
      getUtilityApi: vi.fn(() => ({})),
      getQuickChatPreferences: vi.fn(() => quickChat),
      setQuickChatPreferences: vi.fn((patch) => {
        quickChat = normalizeQuickChatPreferences({ ...quickChat, ...patch });
        return quickChat;
      }),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));

    const initial = await app.request("/api/preferences/quick-chat");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ quickChat: { shortcut: "Alt+Space", reuseTimeoutMinutes: 10 } });

    const updated = await app.request("/api/preferences/quick-chat", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quickChat: { shortcut: "CommandOrControl+Shift+K" } }),
    });

    expect(updated.status).toBe(200);
    expect(engine.setQuickChatPreferences).toHaveBeenCalledWith({
      shortcut: "CommandOrControl+Shift+K",
    });
    expect(await updated.json()).toEqual({
      ok: true,
      quickChat: { shortcut: "CommandOrControl+Shift+K", reuseTimeoutMinutes: 10 },
    });
  });
});
