import { describe, expect, it } from "vitest";

import {
  createSessionTurnContextExtension,
  injectSessionTurnContextMessages,
  normalizeSessionTurnContext,
} from "../core/session-turn-context.js";

describe("session turn context injection", () => {
  it("normalizes explicit system and user-side context blocks", () => {
    expect(normalizeSessionTurnContext({
      system: "world rules",
      beforeUser: ["lore A", { text: "lore B", label: "scene" }],
      afterUser: "mood cue",
      metadata: { source: "rag" },
    })).toEqual({
      system: "world rules",
      beforeUser: "lore A\n\n[scene]\nlore B",
      afterUser: "mood cue",
      metadata: { source: "rag" },
    });
  });

  it("rejects malformed context instead of silently falling back", () => {
    expect(() => normalizeSessionTurnContext({ beforeUser: 42 } as any)).toThrow("beforeUser");
    expect(() => normalizeSessionTurnContext({ metadata: "bad" } as any)).toThrow("metadata");
  });

  it("injects context into provider messages without changing the original message array", () => {
    const original = [
      { role: "system", content: "base system" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ];

    const injected = injectSessionTurnContextMessages(original, {
      system: "world rules",
      beforeUser: "rag before",
      afterUser: "rag after",
      metadata: { pluginId: "context-plugin" },
    });

    expect(original[0].content).toBe("base system");
    expect((injected[0] as any).content).toContain("base system");
    expect((injected[0] as any).content).toContain("Codia turn context");
    expect((injected[0] as any).content).toContain("world rules");
    expect((injected[1] as any).content).toEqual([
      { type: "text", text: expect.stringContaining("rag before") },
      { type: "text", text: "hello" },
      { type: "text", text: expect.stringContaining("rag after") },
    ]);
  });

  it("extension reads the current session-scoped turn context lazily", async () => {
    const sessionPathRef = { current: "/agents/a/sessions/s.jsonl" };
    const extension = createSessionTurnContextExtension({
      sessionPathRef,
      getTurnContext: (sessionPath) => sessionPath === sessionPathRef.current
        ? { beforeUser: "scene context" }
        : null,
    });
    const [handler] = extension.handlers.get("context") as any;

    const result = await handler({
      type: "context",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.messages[0].content).toContain("scene context");
    expect(result.messages[0].content).toContain("hello");
  });
});
