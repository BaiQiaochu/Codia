import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FactStore } from "../lib/memory/fact-store.ts";
import { createMemorySearchTool } from "../lib/memory/memory-search.ts";
import { applyConversationScopedMemorySearch } from "../lib/conversations/agent-phone-session.ts";

describe("search_memory channel scope", () => {
  let tmpDir;
  let factStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-memory-scope-"));
    factStore = new FactStore(path.join(tmpDir, "facts.db"));
    factStore.add({
      fact: "User likes pineapple pizza",
      tags: ["food-preference"],
      time: "2026-06-01T12:00",
      session_id: null,
    });
    factStore.add({
      fact: "[#alpha] Channel decided to eat pizza every Friday",
      tags: ["channel", "alpha"],
      time: "2026-06-02T12:00",
      session_id: "channel-alpha",
    });
    factStore.add({
      fact: "[#beta] Someone in the channel dislikes pizza",
      tags: ["channel", "beta"],
      time: "2026-06-03T12:00",
      session_id: "channel-beta",
    });
  });

  afterEach(() => {
    factStore?.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runSearch(tool, params) {
    const result = await tool.execute("tool-call-1", params);
    return result.content?.[0]?.text || "";
  }

  it("excludes channel facts without trusted scope and does not expose a bypass in the schema", async () => {
    const tool = createMemorySearchTool(factStore);

    const text = await runSearch(tool, { query: "pizza" });

    expect(text).toContain("pineapple");
    expect(text).not.toContain("[#alpha]");
    expect(text).not.toContain("[#beta]");
    expect(JSON.stringify(tool.parameters)).not.toContain("cross_channel");
  });

  it("excludes other channel facts by default while preserving general and current-channel facts", async () => {
    const tool = createMemorySearchTool(factStore, {
      conversationScope: { kind: "channel", channelId: "alpha" },
    });

    const text = await runSearch(tool, { query: "pizza" });

    expect(text).toContain("pineapple");
    expect(text).toContain("[#alpha]");
    expect(text).not.toContain("[#beta]");
  });

  it("allows cross-channel search when cross_channel is explicitly true", async () => {
    const tool = createMemorySearchTool(factStore, {
      conversationScope: { kind: "channel", channelId: "alpha" },
    });

    const text = await runSearch(tool, { query: "pizza", cross_channel: true });

    expect(text).toContain("[#alpha]");
    expect(text).toContain("[#beta]");
    expect(JSON.stringify(tool.parameters)).toContain("cross_channel");
  });

  it("applies the same scope to tag search", async () => {
    const tool = createMemorySearchTool(factStore, {
      conversationScope: { kind: "channel", channelId: "alpha" },
    });

    const text = await runSearch(tool, { query: "", tags: ["channel"] });

    expect(text).toContain("[#alpha]");
    expect(text).not.toContain("[#beta]");
  });

  it("only replaces an existing search_memory tool when applying scoped memory search", () => {
    const scoped = { name: "search_memory", scoped: true };
    const other = { name: "channel_reply" };
    const withMemory = [{ name: "search_memory" }, other];
    const withoutMemory = [other];

    expect(applyConversationScopedMemorySearch(withMemory, scoped)).toEqual([scoped, other]);
    expect(applyConversationScopedMemorySearch(withoutMemory, scoped)).toEqual([other]);
    expect(applyConversationScopedMemorySearch(withMemory, null)).toEqual(withMemory);
  });
});
