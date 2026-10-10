import { describe, expect, it } from "vitest";

import { searchSessions } from "../lib/search/session-search.js";

const baseSession = {
  firstMessage: "",
  modified: new Date("2026-05-22T12:00:00.000Z"),
  messageCount: 3,
  cwd: "/tmp/project-codia",
  agentId: "codia",
  agentName: "Codia",
};

describe("session search", () => {
  it("searches titles independently from content", () => {
    const sessions = [
      {
        ...baseSession,
        path: "/tmp/agents/codia/sessions/title.jsonl",
        title: "media workflow notes",
        allMessagesText: "unrelated content",
      },
      {
        ...baseSession,
        path: "/tmp/agents/codia/sessions/body.jsonl",
        title: "daily notes",
        allMessagesText: "we discussed media workflow routing here",
      },
    ];

    expect(searchSessions(sessions, "media workflow", { phase: "title" }).map(r => r.path))
      .toEqual(["/tmp/agents/codia/sessions/title.jsonl"]);
    expect(searchSessions(sessions, "media workflow", { phase: "content" }).map(r => r.path))
      .toEqual(["/tmp/agents/codia/sessions/body.jsonl"]);
  });

  it("does not expose full message text in search results", () => {
    const sessions = [{
      ...baseSession,
      path: "/tmp/agents/codia/sessions/private.jsonl",
      title: "private",
      allMessagesText: "sensitive project token appears in this long body",
    }];

    const [result] = searchSessions(sessions, "project token", { phase: "content" });

    expect(result).toMatchObject({
      path: "/tmp/agents/codia/sessions/private.jsonl",
      matchKind: "content",
    });
    expect(result.snippet).toContain("project token");
    expect(result).not.toHaveProperty("allMessagesText");
  });

  it("supports mixed Chinese and ASCII queries without requiring a native tokenizer", () => {
    const sessions = [{
      ...baseSession,
      path: "/tmp/agents/codia/sessions/a2a.jsonl",
      title: "round 4",
      allMessagesText: "昨天排查了 A2A通信 endpoint and session_search routing.",
    }];

    expect(searchSessions(sessions, "A2A通信记录", { phase: "content" }).map(r => r.path))
      .toEqual(["/tmp/agents/codia/sessions/a2a.jsonl"]);
  });
});
