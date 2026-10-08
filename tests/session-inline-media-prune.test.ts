import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pruneSessionInlineMediaHistory,
  repairSessionInlineMediaEntries,
  repairSessionInlineMediaEntriesInFile,
} from "../core/session-inline-media-prune.js";

const IMG_BLOCK = { type: "image", data: "BASE64DATA", mimeType: "image/png" };
const AUDIO_BLOCK = { type: "audio", data: "AUDIODATA", mimeType: "audio/webm" };
const TEXT_BLOCK = (text) => ({ type: "text", text });

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-inline-media-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pruneSessionInlineMediaHistory", () => {
  it("removes inline image base64 from session JSONL entries and agent runtime state", () => {
    const rewriteFile = vi.fn();
    const manager = {
      fileEntries: [
        { type: "session", id: "session" },
        {
          type: "message",
          id: "u1",
          message: {
            role: "user",
            content: [TEXT_BLOCK("[attached_image: /tmp/a.png]\nsee"), { ...IMG_BLOCK }],
          },
        },
        { type: "message", id: "a1", message: { role: "assistant", content: [TEXT_BLOCK("seen")] } },
      ],
      _rewriteFile: rewriteFile,
    };
    const session = {
      sessionManager: manager,
      agent: {
        state: {
          messages: [
            {
              role: "user",
              content: [TEXT_BLOCK("[attached_image: /tmp/a.png]\nsee"), { ...IMG_BLOCK }],
            },
            { role: "assistant", content: [TEXT_BLOCK("seen")] },
          ],
        },
      },
    };

    const result = pruneSessionInlineMediaHistory(session);

    expect(result.strippedImages).toBe(2);
    expect(manager.fileEntries[1].message.content).toEqual([
      TEXT_BLOCK("[attached_image: /tmp/a.png]\nsee"),
    ]);
    expect(session.agent.state.messages[0].content).toEqual(manager.fileEntries[1].message.content);
    expect(rewriteFile).toHaveBeenCalledTimes(1);
  });

  it("does not rewrite the session file when no inline media exists", () => {
    const rewriteFile = vi.fn();
    const session = {
      sessionManager: {
        fileEntries: [
          { type: "session", id: "session" },
          { type: "message", id: "u1", message: { role: "user", content: [TEXT_BLOCK("hi")] } },
        ],
        _rewriteFile: rewriteFile,
      },
      agent: { state: { messages: [{ role: "user", content: [TEXT_BLOCK("hi")] }] } },
    };

    const result = pruneSessionInlineMediaHistory(session);

    expect(result.stripped).toBe(0);
    expect(rewriteFile).not.toHaveBeenCalled();
  });
});

describe("repairSessionInlineMediaEntries", () => {
  it("returns a repaired copy with image and audio inline media removed", () => {
    const entries = [
      { type: "session", id: "session" },
      {
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: [
            TEXT_BLOCK("[attached_image: /tmp/a.png]\n[attached_audio: /tmp/a.webm]\nsee"),
            { ...IMG_BLOCK },
            { ...AUDIO_BLOCK },
          ],
        },
      },
    ];

    const result = repairSessionInlineMediaEntries(entries);

    expect(result.strippedImages).toBe(1);
    expect(result.strippedAudios).toBe(1);
    expect(result.entries).not.toBe(entries);
    expect(result.entries[1].message.content).toEqual([
      TEXT_BLOCK("[attached_image: /tmp/a.png]\n[attached_audio: /tmp/a.webm]\nsee"),
    ]);
  });
});

describe("repairSessionInlineMediaEntriesInFile", () => {
  it("rewrites a session file after stripping durable inline media", () => {
    const sessionPath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", id: "session" }),
      JSON.stringify({
        type: "message",
        id: "u1",
        message: {
          role: "user",
          content: [TEXT_BLOCK("[attached_audio: /tmp/a.webm]\nlisten"), { ...AUDIO_BLOCK }],
        },
      }),
      "",
    ].join("\n"));

    const result = repairSessionInlineMediaEntriesInFile(sessionPath);
    const rewritten = fs.readFileSync(sessionPath, "utf-8");

    expect(result.repaired).toBe(true);
    expect(result.strippedAudios).toBe(1);
    expect(rewritten).not.toContain("AUDIODATA");
  });
});
