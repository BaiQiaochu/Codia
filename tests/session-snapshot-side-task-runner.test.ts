// @ts-nocheck
import { describe, expect, it, vi } from "vitest";
import { buildSessionCacheSnapshot } from "../core/session-cache-snapshot.js";
import { runSessionSnapshotSideTask } from "../lib/llm/session-snapshot-side-task-runner.js";

function snapshot() {
  return buildSessionCacheSnapshot({
    sessionPath: "/sessions/a.jsonl",
    reason: "memory.reflection",
    model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
    cacheKeyParams: { thinkingLevel: "medium" },
    systemPrompt: "stable system",
    tools: [{ name: "read", description: "Read files", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "hello" }],
  });
}

describe("session snapshot side-task runner", () => {
  it("appends the suffix after the exact parent prefix and keeps tools", async () => {
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "side result" }],
        usage: { input_tokens: 100, cache_read_input_tokens: 90, output_tokens: 10 },
      })),
    }));

    const result = await runSessionSnapshotSideTask({
      snapshot: snapshot(),
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "medium" },
      suffixMessage: { role: "user", content: [{ type: "text", text: "internal task" }] },
      streamFn,
      options: { reasoning: "medium", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    });

    expect(result.text).toBe("side result");
    expect(result.metadata).toMatchObject({
      cacheStrategy: "session_snapshot",
      strict: true,
      cacheGroup: "memory.reflection",
    });
    const [, context, options] = streamFn.mock.calls[0];
    expect(context.systemPrompt).toBe("stable system");
    expect(context.tools).toEqual([{ name: "read", description: "Read files", parameters: { type: "object" } }]);
    expect(context.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "user", content: [{ type: "text", text: "internal task" }] },
    ]);
    expect(options).toMatchObject({ reasoning: "medium", toolChoice: "none" });
  });

  it("canonicalizes legacy auto in side-task cache params and request options", async () => {
    const streamFn = vi.fn(async () => ({
      result: vi.fn(async () => ({
        stopReason: "stop",
        content: [{ type: "text", text: "side result" }],
      })),
    }));
    const snap = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      reason: "memory.reflection",
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "auto" },
      systemPrompt: "stable system",
      tools: [],
      messages: [{ role: "user", content: "hello" }],
    });

    await runSessionSnapshotSideTask({
      snapshot: snap,
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "auto" },
      suffixMessage: { role: "user", content: "internal task" },
      streamFn,
      options: { reasoning: "auto", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    });

    const [, , options] = streamFn.mock.calls[0];
    expect(options).toEqual({ reasoning: "medium", toolChoice: "none" });
  });

  it("throws before provider call when strict request contract is broken", async () => {
    const streamFn = vi.fn();
    await expect(runSessionSnapshotSideTask({
      snapshot: snapshot(),
      model: { id: "gpt-5.1", provider: "openai", api: "openai-responses" },
      cacheKeyParams: { thinkingLevel: "off" },
      suffixMessage: { role: "user", content: "internal task" },
      streamFn,
      options: { reasoning: "off", toolChoice: "none" },
      cacheGroup: "memory.reflection",
      templateVersion: "v1",
    })).rejects.toThrow("Session snapshot request is not strict");
    expect(streamFn).not.toHaveBeenCalled();
  });
});
