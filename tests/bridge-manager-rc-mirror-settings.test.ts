// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { BridgeManager } from "../lib/bridge/bridge-manager.js";

describe("BridgeManager RC mirror settings updates", () => {
  it("mirrors settings update summaries from desktop session tool events", async () => {
    const adapter = { sendReply: vi.fn(async () => {}) };
    const engine = {
      agentName: "Agent",
      getAgent: vi.fn(() => ({ agentName: "Agent" })),
      rcState: {
        getAttachedBridgeSessionKey: vi.fn(() => "tg_dm_chat@agent-a"),
        getAttachment: vi.fn(() => ({
          platform: "telegram",
          agentId: "agent-a",
          chatId: "chat",
        })),
      },
      emitEvent: vi.fn(),
    };
    const manager = new BridgeManager({
      engine,
      hub: {
        subscribe: () => () => {},
        eventBus: { emit: vi.fn() },
      },
    });
    manager._platforms.set("telegram:agent-a", {
      platform: "telegram",
      agentId: "agent-a",
      adapter,
      status: "connected",
    });

    await manager._handleRcMirrorEvent({
      type: "session_user_message",
      message: { text: "change locale", source: "desktop" },
    }, "/sessions/main.jsonl");

    await manager._handleRcMirrorEvent({
      type: "tool_execution_end",
      isError: false,
      result: {
        details: {
          settingsUpdate: {
            status: "applied",
            action: "core.apply",
            key: "locale",
            title: "Locale updated",
            summary: "Locale changed.",
            changes: [{ key: "locale", label: "Locale", before: "zh-CN", after: "en" }],
          },
        },
      },
    }, "/sessions/main.jsonl");
    await manager._handleRcMirrorEvent({
      type: "session_status",
      isStreaming: false,
    }, "/sessions/main.jsonl");

    const replies = adapter.sendReply.mock.calls.map(([chatId, text]) => ({ chatId, text }));
    expect(replies.some((reply) => reply.chatId === "chat" && reply.text.includes("Locale updated"))).toBe(true);
    expect(replies.some((reply) => reply.text.includes("Locale: zh-CN -> en"))).toBe(true);
  });
});
