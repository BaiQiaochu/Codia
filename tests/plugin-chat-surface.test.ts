import { describe, expect, it, vi } from "vitest";
import { normalizePluginChatSurfaceBlocks } from "../server/plugin-chat-surface.ts";

describe("plugin chat surface normalization", () => {
  it("resolves chat.surface cards to plugin-owned private session refs", () => {
    const engine = {
      getSessionManifest: vi.fn((sessionId) => sessionId === "sess_private"
        ? {
          sessionId,
          currentLocator: { path: "/sessions/private.jsonl" },
          plugin: { ownerPluginId: "demo", visibility: "plugin_private" },
        }
        : null),
    };

    const blocks = normalizePluginChatSurfaceBlocks([{
      type: "plugin_card",
      afterIndex: 0,
      card: {
        type: "chat.surface",
        pluginId: "demo",
        sessionRef: { sessionId: "sess_private", sessionPath: "/sessions/stale.jsonl" },
        title: "Private run",
      },
    }], engine);

    expect(blocks[0]).toMatchObject({
      type: "plugin_card",
      afterIndex: 0,
      card: {
        type: "chat.surface",
        pluginId: "demo",
        sessionId: "sess_private",
        sessionPath: "/sessions/private.jsonl",
        sessionRef: {
          sessionId: "sess_private",
          sessionPath: "/sessions/private.jsonl",
        },
      },
    });
  });

  it("downgrades chat.surface cards that point at public or foreign sessions", () => {
    const engine = {
      getSessionManifest: vi.fn((sessionId) => ({
        sessionId,
        currentLocator: { path: "/sessions/public.jsonl" },
        plugin: { ownerPluginId: sessionId === "sess_foreign" ? "other" : "demo", visibility: "public" },
      })),
    };

    expect(normalizePluginChatSurfaceBlocks([{
      type: "plugin_card",
      card: { type: "chat.surface", pluginId: "demo", sessionId: "sess_public" },
    }], engine)[0].card).toMatchObject({
      type: "chat.surface.unavailable",
      unavailableReason: "session_not_private",
    });

    expect(normalizePluginChatSurfaceBlocks([{
      type: "plugin_card",
      card: { type: "chat.surface", pluginId: "demo", sessionId: "sess_foreign" },
    }], engine)[0].card).toMatchObject({
      type: "chat.surface.unavailable",
      unavailableReason: "session_owner_mismatch",
    });
  });

  it("leaves iframe cards unchanged", () => {
    const card = { type: "iframe", pluginId: "demo", route: "/card" };
    expect(normalizePluginChatSurfaceBlocks([{ type: "plugin_card", card }], {
      getSessionManifest: vi.fn(),
    })[0].card).toBe(card);
  });
});
