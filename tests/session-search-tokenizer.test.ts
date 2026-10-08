import { describe, expect, it } from "vitest";

import {
  normalizeSessionSearchText,
  tokenizeSessionSearchQuery,
} from "../lib/search/session-search-tokenizer.js";

describe("session search tokenizer", () => {
  it("normalizes width, whitespace, and case before matching", () => {
    expect(normalizeSessionSearchText(" Ａｇｅｎｔ  SESSION_SEARCH ")).toBe("agent session_search");
  });

  it("keeps ASCII project terms and useful CJK fragments searchable", () => {
    const tokens = tokenizeSessionSearchQuery("session_search A2A通信记录 聊天记录");

    expect(tokens).toEqual(expect.arrayContaining([
      "session_search",
      "a2a通信记录",
      "聊天记录",
      "a2a",
      "通信",
      "记录",
      "聊天",
      "a2a通信",
    ]));
  });
});
