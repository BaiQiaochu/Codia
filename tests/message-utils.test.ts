import { describe, it, expect, vi } from "vitest";
import path from "path";
import fs from 'node:fs';
import os from 'node:os';

vi.mock("../core/llm-utils.js", () => ({
  isToolCallBlock: (b) => (b.type === "tool_use" || b.type === "toolCall") && !!b.name,
  getToolArgs: (b) => b.input || b.arguments,
}));

import {
  TOOL_ARG_SUMMARY_KEYS,
  stripThinkTags,
  extractTextContent,
  parseSessionHistoryText,
  loadSessionHistoryMessages,
  filterUnreferencedInlineImages,
  relativePathInsideBase,
  isValidSessionPath,
  isActiveSessionPath,
  isActiveDesktopSessionPath,
  isArchivedDesktopSessionPath,
  isDesktopSessionPath,
} from "../core/message-utils.js";

describe("TOOL_ARG_SUMMARY_KEYS", () => {
  it("contains common summary keys", () => {
    expect(Array.isArray(TOOL_ARG_SUMMARY_KEYS)).toBe(true);
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("file_path");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("command");
    expect(TOOL_ARG_SUMMARY_KEYS).toContain("url");
  });
});

describe("stripThinkTags", () => {
  it("extracts and removes paired think tags", () => {
    const input = "<think>inner thought</think>\nactual text";
    const { text, thinkContent } = stripThinkTags(input);
    expect(text.trim()).toBe("actual text");
    expect(thinkContent).toBe("inner thought");
  });

  it("returns plain text unchanged when no think tags exist", () => {
    const { text, thinkContent } = stripThinkTags("plain text");
    expect(text).toBe("plain text");
    expect(thinkContent).toBe("");
  });

  it("merges multiple think blocks", () => {
    const input = "<think>A</think>\n<think>B</think>\nresult";
    const { text, thinkContent } = stripThinkTags(input);
    expect(text.trim()).toBe("result");
    expect(thinkContent).toBe("A\nB");
  });

  it("removes orphan think closing tags", () => {
    const { text, thinkContent } = stripThinkTags("</think>\nactual text");
    expect(text.trim()).toBe("actual text");
    expect(thinkContent).toBe("");
  });

  it("handles thinking tags case-insensitively", () => {
    const { text, thinkContent } = stripThinkTags("<THINKING>inner</THINKING>\nactual text");
    expect(text.trim()).toBe("actual text");
    expect(thinkContent).toBe("inner");
  });

  it("extracts malformed think message delimiters", () => {
    const { text, thinkContent } = stripThinkTags("<think<|message|>inner</think>\nactual text");
    expect(text.trim()).toBe("actual text");
    expect(thinkContent).toBe("inner");
  });

  it("extracts reflect tags as thinking content", () => {
    const { text, thinkContent } = stripThinkTags("<reflect>inner reflection</reflect>\nactual text");
    expect(text.trim()).toBe("actual text");
    expect(thinkContent).toBe("inner reflection");
  });
});

describe("extractTextContent", () => {
  it("returns string content directly", () => {
    const result = extractTextContent("hello world");
    expect(result.text).toBe("hello world");
    expect(result.thinking).toBe("");
    expect(result.toolUses).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("strips think tags from string content when requested", () => {
    const result = extractTextContent("<think>inner</think>\nresult", { stripThink: true });
    expect(result.text.trim()).toBe("result");
    expect(result.thinking).toBe("inner");
  });

  it("returns empty result for null and undefined", () => {
    const nullResult = extractTextContent(null);
    expect(nullResult).toEqual({ text: "", thinking: "", toolUses: [], images: [] });

    const undefinedResult = extractTextContent(undefined);
    expect(undefinedResult).toEqual({ text: "", thinking: "", toolUses: [], images: [] });
  });

  it("extracts text from content block arrays", () => {
    const content = [
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ];
    const result = extractTextContent(content);
    expect(result.text).toBe("hello world");
    expect(result.toolUses).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it("ignores assistant commentary text signatures while keeping final answer text", () => {
    const content = [
      {
        type: "text",
        text: "working notes",
        textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
      },
      { type: "tool_use", id: "call_read", name: "read_file", input: { file_path: "/tmp/a.md" } },
      {
        type: "text",
        text: "final answer",
        textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
      },
    ];

    const result = extractTextContent(content);

    expect(result.text).toBe("final answer");
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].name).toBe("read_file");
  });

  it("extracts thinking blocks from content block arrays", () => {
    const content = [
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "my thoughts" },
    ];
    const result = extractTextContent(content);
    expect(result.text).toBe("answer");
    expect(result.thinking).toBe("my thoughts");
  });

  it("extracts tool_use blocks", () => {
    const content = [
      { type: "tool_use", id: "call_read_1", name: "read_file", input: { file_path: "/tmp/test.txt", extra: "ignored" } },
    ];
    const result = extractTextContent(content);
    expect(result.toolUses).toHaveLength(1);
    expect(result.toolUses[0].id).toBe("call_read_1");
    expect(result.toolUses[0].name).toBe("read_file");
    expect(result.toolUses[0].args).toEqual({ file_path: "/tmp/test.txt" });
  });

  it("omits args when a tool_use block has no summary fields", () => {
    const content = [
      { type: "tool_use", name: "some_tool", input: { nonSummaryKey: "value" } },
    ];
    const result = extractTextContent(content);
    expect(result.toolUses[0].args).toBeUndefined();
  });

  it("extracts image blocks with source.data", () => {
    const content = [
      {
        type: "image",
        source: { data: "base64data", media_type: "image/jpeg" },
      },
    ];
    const result = extractTextContent(content);
    expect(result.images).toHaveLength(1);
    expect(result.images[0].data).toBe("base64data");
    expect(result.images[0].mimeType).toBe("image/jpeg");
  });
});

describe("filterUnreferencedInlineImages", () => {
  it("removes inline images already represented by attached_image markers", () => {
    const images = [
      { data: "BASE64_A", mimeType: "image/png" },
      { data: "BASE64_B", mimeType: "image/png" },
    ];

    expect(filterUnreferencedInlineImages(
      "[attached_image: /tmp/a.png]\n[attached_image: /tmp/b.png]\ncompare",
      images,
    )).toEqual([]);
  });

  it("keeps legacy inline images without matching file markers", () => {
    const images = [
      { data: "BASE64_A", mimeType: "image/png" },
      { data: "BASE64_B", mimeType: "image/png" },
    ];

    expect(filterUnreferencedInlineImages(
      "[attached_image: /tmp/a.png]\ncompare",
      images,
    )).toEqual([{ data: "BASE64_B", mimeType: "image/png" }]);
  });
});

describe("isValidSessionPath", () => {
  it("accepts a valid child path", () => {
    expect(isValidSessionPath("/tmp/agents/agent1/sessions/abc.jsonl", "/tmp/agents")).toBe(true);
  });

  it("accepts exactly the base dir", () => {
    expect(isValidSessionPath("/tmp/agents", "/tmp/agents")).toBe(true);
  });

  it("rejects path traversal", () => {
    expect(isValidSessionPath("/tmp/agents/../etc/passwd", "/tmp/agents")).toBe(false);
  });

  it("rejects unrelated paths", () => {
    expect(isValidSessionPath("/etc/shadow", "/tmp/agents")).toBe(false);
  });

  it("rejects paths with similar prefixes", () => {
    expect(isValidSessionPath("/tmp/agents-evil/session.jsonl", "/tmp/agents")).toBe(false);
  });
});

describe("relativePathInsideBase", () => {
  it('resolves filesystem aliases consistently and rejects a link outside the base', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-session-path-'));
    try {
      const base = path.join(root, 'agents');
      const alias = path.join(root, 'alias');
      const outside = path.join(root, 'outside');
      fs.mkdirSync(base); fs.mkdirSync(outside);
      fs.symlinkSync(base, alias, process.platform === 'win32' ? 'junction' : 'dir');
      fs.symlinkSync(outside, path.join(base, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(relativePathInsideBase(path.join(alias, 'helper/sessions/new.jsonl'), base)).toBe(path.join('helper', 'sessions', 'new.jsonl'));
      expect(relativePathInsideBase(path.join(base, 'escaped/secret.jsonl'), base)).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("returns the normalized relative path for children", () => {
    expect(relativePathInsideBase("/tmp/agents/agent1/sessions/abc.jsonl", "/tmp/agents"))
      .toBe(path.join("agent1", "sessions", "abc.jsonl"));
  });

  it("returns an empty string for the base dir itself", () => {
    expect(relativePathInsideBase("/tmp/agents", "/tmp/agents")).toBe("");
  });

  it("rejects sibling paths with similar prefixes", () => {
    expect(relativePathInsideBase("/tmp/agents-evil/session.jsonl", "/tmp/agents")).toBeNull();
  });
});

describe("isActiveSessionPath", () => {
  it("splits active and archived desktop session files", () => {
    const agentsDir = "/tmp/agents";
    const active = "/tmp/agents/agent1/sessions/abc.jsonl";
    const archived = "/tmp/agents/agent1/sessions/archived/abc.jsonl";

    expect(isActiveDesktopSessionPath(active, agentsDir)).toBe(true);
    expect(isActiveSessionPath(active, agentsDir)).toBe(true);
    expect(isArchivedDesktopSessionPath(active, agentsDir)).toBe(false);
    expect(isDesktopSessionPath(active, agentsDir)).toBe(true);

    expect(isActiveDesktopSessionPath(archived, agentsDir)).toBe(false);
    expect(isActiveSessionPath(archived, agentsDir)).toBe(false);
    expect(isArchivedDesktopSessionPath(archived, agentsDir)).toBe(true);
    expect(isDesktopSessionPath(archived, agentsDir)).toBe(true);
  });

  it("rejects non-chat runtime session files", () => {
    expect(isActiveSessionPath("/tmp/agents/agent1/subagent-sessions/abc.jsonl", "/tmp/agents")).toBe(false);
    expect(isActiveSessionPath("/tmp/agents/agent1/activity/abc.jsonl", "/tmp/agents")).toBe(false);
  });
});

describe("parseSessionHistoryText", () => {
  it("reads JSONL session entries", () => {
    const raw = [
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: "hello" } }),
    ].join("\n");

    expect(parseSessionHistoryText(raw)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("reads custom message entries used by deferred UI blocks", () => {
    const raw = [
      JSON.stringify({ type: "message", message: { role: "assistant", content: "submitted" } }),
      JSON.stringify({
        type: "custom_message",
        id: "custom-1",
        timestamp: "2026-06-05T00:00:00.000Z",
        customType: "gsap-background-result",
        content: "<gsap-background-result></gsap-background-result>",
        display: false,
        details: { source: "test" },
      }),
      JSON.stringify({
        type: "custom",
        id: "custom-2",
        timestamp: "2026-06-05T00:01:00.000Z",
        customType: "gsap-deferred-result",
        data: { schemaVersion: 1, taskId: "task-img", status: "success", type: "image-generation" },
      }),
    ].join("\n");

    expect(parseSessionHistoryText(raw)).toEqual([
      { role: "assistant", content: "submitted" },
      {
        role: "custom",
        id: "custom-1",
        timestamp: "2026-06-05T00:00:00.000Z",
        customType: "gsap-background-result",
        content: "<gsap-background-result></gsap-background-result>",
        display: false,
        details: { source: "test" },
      },
      {
        role: "custom",
        id: "custom-2",
        timestamp: "2026-06-05T00:01:00.000Z",
        customType: "gsap-deferred-result",
        data: { schemaVersion: 1, taskId: "task-img", status: "success", type: "image-generation" },
        display: false,
      },
    ]);
  });

  it("reads ordinary JSON with messages", () => {
    const raw = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });

    expect(parseSessionHistoryText(raw)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("reads ordinary JSON with entries", () => {
    const raw = JSON.stringify({
      entries: [
        { type: "message", message: { role: "user", content: "hi" } },
        { type: "message", message: { role: "assistant", content: "hello" } },
      ],
    });

    expect(parseSessionHistoryText(raw)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });
});

describe("loadSessionHistoryMessages", () => {
  it("returns an empty array when sessionPath is null", async () => {
    const engine = { messages: [{ role: "user", content: "hi" }] };
    const result = await loadSessionHistoryMessages(engine, null);
    expect(result).toEqual([]);
  });

  it("returns an empty array when sessionPath is undefined", async () => {
    const engine = { messages: [{ role: "user", content: "hi" }] };
    const result = await loadSessionHistoryMessages(engine, undefined);
    expect(result).toEqual([]);
  });
});
