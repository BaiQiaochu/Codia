// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../lib/pi-sdk/index.js";
import { replayLatestUserTurn } from "../core/session-turn-actions.js";

function makeNavigableSession(manager) {
  return {
    sessionManager: manager,
    navigateTree: vi.fn(async (entryId) => {
      const entry = manager.getEntry(entryId);
      if (!entry) throw new Error(`Entry ${entryId} not found`);
      if (entry.parentId) manager.branch(entry.parentId);
      else manager.resetLeaf();
      return { cancelled: false };
    }),
  };
}

describe("replayLatestUserTurn", () => {
  it("branches before the latest user message and replays the original prompt", async () => {
    const manager = SessionManager.inMemory("/workspace");
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "old" }] });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "old answer" }] });
    const latestUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "try again" }] });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] });
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      clientMessageId: "client-user",
      displayMessage: { text: "try again" },
    }, { submit });

    expect(session.navigateTree).toHaveBeenCalledWith(latestUserId, { summarize: false });
    expect(engine.emitEvent).toHaveBeenCalledWith({
      type: "session_branch_reset",
      messageId: latestUserId,
      clientMessageId: "client-user",
    }, "/tmp/main.jsonl");
    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      sessionPath: "/tmp/main.jsonl",
      text: "try again",
      displayMessage: expect.objectContaining({ text: "try again" }),
    }));
  });

  it("preserves leading attachment markers when editing visible text", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const latestUserId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "[attached_image: /tmp/a.png]\nold text" }],
    });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "bad answer" }] });
    const session = makeNavigableSession(manager);
    const submit = vi.fn(async () => ({ text: "new answer", toolMedia: [] }));
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: latestUserId,
      replacementText: "new text",
      displayMessage: { text: "new text" },
    }, { submit });

    expect(submit).toHaveBeenCalledWith(engine, expect.objectContaining({
      text: "[attached_image: /tmp/a.png]\nnew text",
      displayMessage: expect.objectContaining({ text: "new text" }),
    }));
  });

  it("rejects a stale source entry instead of replaying the wrong turn", async () => {
    const manager = SessionManager.inMemory("/workspace");
    const staleUserId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "first" }] });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }] });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "latest" }] });
    const session = makeNavigableSession(manager);
    const submit = vi.fn();
    const engine = {
      ensureSessionLoaded: vi.fn(async () => session),
      isSessionStreaming: vi.fn(() => false),
      emitEvent: vi.fn(),
    };

    await expect(replayLatestUserTurn(engine, {
      sessionPath: "/tmp/main.jsonl",
      sourceEntryId: staleUserId,
    }, { submit })).rejects.toThrow("latest user message");

    expect(submit).not.toHaveBeenCalled();
  });
});
