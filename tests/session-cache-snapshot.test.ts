// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  assertSessionSnapshotRequest,
  buildSessionCacheSnapshot,
  buildSessionSnapshotRequestContract,
} from "../core/session-cache-snapshot.js";

const model = {
  id: "gpt-audio-mini",
  provider: "openai",
  api: "openai-completions",
  baseUrl: "https://api.openai.com/v1",
};

function tool(name) {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
    },
    execute: () => "ignored",
  };
}

describe("session cache snapshot", () => {
  it("captures provider-visible session state in a strict cache contract", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/main.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "medium", empty: "", skipped: undefined },
      systemPrompt: "stable system prompt",
      tools: [tool("read"), tool("bash")],
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "listen" },
          { type: "input_audio", input_audio: { data: "UklGRg==", format: "wav" } },
        ],
        timestamp: "not part of the contract",
      }],
      reason: "compaction.history",
    });

    expect(snapshot).toMatchObject({
      version: 1,
      strategy: "session_snapshot",
      strict: true,
      sessionPath: "/sessions/main.jsonl",
      reason: "compaction.history",
      model,
      cacheKeyParams: { thinkingLevel: "medium" },
      toolNames: ["bash", "read"],
      messageCount: 1,
    });
    expect(snapshot.cachePrefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.messages[0]).not.toHaveProperty("timestamp");
  });

  it("canonicalizes legacy auto thinking params before hashing snapshots", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/a.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "auto", reasoning: "auto", toolChoice: "auto" },
      systemPrompt: "stable",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
    });

    expect(snapshot.cacheKeyParams).toEqual({
      reasoning: "medium",
      thinkingLevel: "medium",
      toolChoice: "auto",
    });
  });

  it("accepts internal suffix messages when the original prefix still matches", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/main.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
      reason: "memory.reflection",
    });

    const request = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "internal suffix" },
      ],
      prefixMessageCount: snapshot.messageCount,
    });

    expect(assertSessionSnapshotRequest(snapshot, request)).toMatchObject({
      ok: true,
      strict: true,
      diffs: [],
    });
  });

  it("reports the contract fields that changed", () => {
    const snapshot = buildSessionCacheSnapshot({
      sessionPath: "/sessions/main.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "high" },
      systemPrompt: "stable system prompt",
      tools: [tool("read")],
      messages: [{ role: "user", content: "first" }],
      reason: "memory.reflection",
    });

    const changed = buildSessionSnapshotRequestContract({
      snapshot,
      model,
      cacheKeyParams: { thinkingLevel: "off" },
      systemPrompt: "stable system prompt",
      tools: [],
      messages: [{ role: "user", content: "changed" }],
      prefixMessageCount: 1,
    });

    expect(assertSessionSnapshotRequest(snapshot, changed).diffs.map((diff) => diff.field))
      .toEqual(expect.arrayContaining(["cacheKeyParamsHash", "toolSchemaHash", "messagePrefixHash"]));
  });

  it("keeps session snapshot tool contracts stable across ordering and runtime-only metadata", () => {
    const base = buildSessionCacheSnapshot({
      sessionPath: "/sessions/main.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "medium" },
      systemPrompt: "stable system prompt",
      tools: [
        { ...tool("write"), runtimeId: "runtime-a", enabled: true },
        { ...tool("read"), execute: () => "runtime-a" },
      ],
      messages: [{ role: "user", content: "first" }],
      reason: "memory.reflection",
    });
    const reordered = buildSessionCacheSnapshot({
      sessionPath: "/sessions/main.jsonl",
      model,
      cacheKeyParams: { thinkingLevel: "medium" },
      systemPrompt: "stable system prompt",
      tools: [
        { ...tool("read"), execute: () => "runtime-b" },
        { ...tool("write"), runtimeId: "runtime-b", enabled: false },
      ],
      messages: [{ role: "user", content: "first" }],
      reason: "memory.reflection",
    });

    expect(reordered.toolNames).toEqual(["read", "write"]);
    expect(reordered.toolSchemaHash).toBe(base.toolSchemaHash);
    expect(reordered.cachePrefixHash).toBe(base.cachePrefixHash);
  });
});
