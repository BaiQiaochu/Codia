// @ts-nocheck
import { describe, it, expect } from "vitest";
import {
  parseSessionKey,
  collectKnownUsers,
  SESSION_PREFIX_MAP,
  KNOWN_PLATFORMS,
} from "../lib/bridge/session-key.js";

// ── parseSessionKey ──

describe("parseSessionKey", () => {
  it("parses all known prefixes (legacy format without agentId)", () => {
    const cases = [
      ["tg_dm_123",       { platform: "telegram",  chatType: "dm",    chatId: "123",  agentId: null }],
      ["tg_group_abc",    { platform: "telegram",  chatType: "group", chatId: "abc",  agentId: null }],
      ["fs_dm_u001",      { platform: "feishu",    chatType: "dm",    chatId: "u001", agentId: null }],
      ["fs_group_g99",    { platform: "feishu",    chatType: "group", chatId: "g99",  agentId: null }],
      ["dt_dm_u001",      { platform: "dingtalk",  chatType: "dm",    chatId: "u001", agentId: null }],
      ["dt_group_g99",    { platform: "dingtalk",  chatType: "group", chatId: "g99",  agentId: null }],
      ["wa_dm_user42",    { platform: "whatsapp",  chatType: "dm",    chatId: "user42", agentId: null }],
      ["wa_group_room7",  { platform: "whatsapp",  chatType: "group", chatId: "room7", agentId: null }],
      ["am_dm_agent%40qq.com", { platform: "agentlyMail", chatType: "dm", chatId: "agent%40qq.com", agentId: null }],
    ];

    for (const [key, expected] of cases) {
      expect(parseSessionKey(key)).toEqual(expected);
    }
  });

  it("parses new format with @agentId suffix", () => {
    const cases = [
      ["tg_dm_123@hana",       { platform: "telegram",  chatType: "dm",    chatId: "123",  agentId: "hana" }],
      ["tg_group_abc@kuro",    { platform: "telegram",  chatType: "group", chatId: "abc",  agentId: "kuro" }],
      ["fs_dm_u001@hana",      { platform: "feishu",    chatType: "dm",    chatId: "u001", agentId: "hana" }],
      ["dt_dm_u001@gsap",      { platform: "dingtalk",  chatType: "dm",    chatId: "u001", agentId: "gsap" }],
      ["dt_group_g99@gsap",    { platform: "dingtalk",  chatType: "group", chatId: "g99",  agentId: "gsap" }],
      ["qq_dm_x99@agent-1",    { platform: "qq",        chatType: "dm",    chatId: "x99",  agentId: "agent-1" }],
      ["wx_dm_wxid@hana",      { platform: "wechat",    chatType: "dm",    chatId: "wxid", agentId: "hana" }],
      ["wa_dm_user42@hana",    { platform: "whatsapp",  chatType: "dm",    chatId: "user42", agentId: "hana" }],
      ["wa_group_room7@hana",  { platform: "whatsapp",  chatType: "group", chatId: "room7", agentId: "hana" }],
      ["am_dm_agent%40qq.com@hana", { platform: "agentlyMail", chatType: "dm", chatId: "agent%40qq.com", agentId: "hana" }],
    ];

    for (const [key, expected] of cases) {
      expect(parseSessionKey(key)).toEqual(expected);
    }
  });

  it("returns unknown for unrecognized prefix", () => {
    expect(parseSessionKey("slack_dm_xyz")).toEqual({
      platform: "unknown",
      chatType: "dm",
      chatId: "slack_dm_xyz",
      agentId: null,
    });
  });

  it("handles empty chatId after prefix", () => {
    expect(parseSessionKey("tg_dm_")).toEqual({
      platform: "telegram",
      chatType: "dm",
      chatId: "",
      agentId: null,
    });
  });

  it("matches the longest (first) prefix when ambiguous", () => {
    // "tg_group_" is longer than "tg_" — ensure group is matched
    const result = parseSessionKey("tg_group_123");
    expect(result.chatType).toBe("group");
  });
});

// ── KNOWN_PLATFORMS ──

describe("KNOWN_PLATFORMS", () => {
  it("contains all platforms, deduplicated", () => {
    expect(KNOWN_PLATFORMS).toContain("telegram");
    expect(KNOWN_PLATFORMS).toContain("feishu");
    expect(KNOWN_PLATFORMS).toContain("dingtalk");
    expect(KNOWN_PLATFORMS).toContain("qq");
    expect(KNOWN_PLATFORMS).toContain("wechat");
    expect(KNOWN_PLATFORMS).toContain("whatsapp");
    expect(KNOWN_PLATFORMS).toContain("agentlyMail");
    expect(KNOWN_PLATFORMS.length).toBe(7);
  });

  it("is consistent with SESSION_PREFIX_MAP", () => {
    const fromMap = [...new Set(SESSION_PREFIX_MAP.map(([, p]) => p))];
    expect(KNOWN_PLATFORMS).toEqual(fromMap);
  });
});

// ── collectKnownUsers ──

describe("collectKnownUsers", () => {
  it("groups users by platform from bridge index", () => {
    const index = {
      "tg_dm_111": { file: "tg_111.jsonl", userId: "111", name: "Alice" },
      "tg_dm_222": { file: "tg_222.jsonl", userId: "222", name: "Bob" },
      "fs_dm_aaa": { file: "fs_aaa.jsonl", userId: "aaa", name: "Charlie" },
      "dt_dm_d1": { file: "dt_d1.jsonl", userId: "d1", name: "Ding" },
      "wa_dm_999": { file: "wa_999.jsonl", userId: "999", name: "Dana" },
    };

    const result = collectKnownUsers(index);
    expect(result.telegram).toHaveLength(2);
    expect(result.feishu).toHaveLength(1);
    expect(result.dingtalk).toHaveLength(1);
    expect(result.whatsapp).toHaveLength(1);
    expect(result.qq).toBeUndefined();
  });

  it("deduplicates by userId within same platform", () => {
    const index = {
      "tg_dm_111":   { file: "a.jsonl", userId: "111", name: "Alice" },
      "tg_group_g1": { file: "b.jsonl", userId: "111", name: "Alice" },
    };

    const result = collectKnownUsers(index);
    expect(result.telegram).toHaveLength(1);
    expect(result.telegram[0].userId).toBe("111");
  });

  it("prefers entry with name over entry without", () => {
    const index = {
      "tg_dm_111":   { file: "a.jsonl", userId: "111" },
      "tg_group_g1": { file: "b.jsonl", userId: "111", name: "Alice" },
    };

    const result = collectKnownUsers(index);
    expect(result.telegram[0].name).toBe("Alice");
  });

  it("skips entries without userId", () => {
    const index = {
      "tg_dm_111": { file: "a.jsonl" },
      "tg_dm_222": "just-a-string.jsonl",
    };

    const result = collectKnownUsers(index);
    expect(result.telegram).toBeUndefined();
  });

  it("skips unknown platform entries", () => {
    const index = {
      "slack_dm_x": { file: "x.jsonl", userId: "x" },
    };

    const result = collectKnownUsers(index);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles legacy string format entries", () => {
    const index = {
      "tg_dm_111": "old-format.jsonl",
      "tg_dm_222": { file: "new.jsonl", userId: "222", name: "Bob" },
    };

    const result = collectKnownUsers(index);
    expect(result.telegram).toHaveLength(1);
    expect(result.telegram[0].userId).toBe("222");
  });

  it("returns empty object for empty index", () => {
    expect(collectKnownUsers({})).toEqual({});
  });
});
