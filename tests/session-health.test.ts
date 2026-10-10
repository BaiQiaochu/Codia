// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import {
  evaluateSessionHealth,
  repairOrphanToolResultEntries,
  repairOrphanToolResultEntriesInFile,
} from "../core/session-health.js";

let tmpDir;
let sessionPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-health-"));
  sessionPath = path.join(tmpDir, "session.jsonl");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
});

function entry(role, opts = {}) {
  return JSON.stringify({
    type: "message",
    id: opts.id || crypto.randomUUID(),
    timestamp: opts.timestamp || Date.now(),
    message: {
      role,
      content: opts.content || [],
      stopReason: opts.stopReason,
      ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
    },
  });
}

function writeSession(...lines) {
  fs.writeFileSync(sessionPath, lines.join("\n"));
}

describe("evaluateSessionHealth", () => {
  it("treats a missing session file as healthy so restore is not blocked", () => {
    const result = evaluateSessionHealth(path.join(tmpDir, "missing.jsonl"));
    expect(result).toEqual({ healthy: true, recentErrors: 0, totalChecked: 0, exists: false });
  });

  it("reports a clean session as healthy", () => {
    writeSession(
      entry("user"),
      entry("assistant", { stopReason: "stop" }),
      entry("user"),
      entry("assistant", { stopReason: "stop" }),
    );

    const result = evaluateSessionHealth(sessionPath);
    expect(result.healthy).toBe(true);
    expect(result.recentErrors).toBe(0);
    expect(result.totalChecked).toBe(2);
  });

  it("marks three recent assistant errors as unhealthy", () => {
    writeSession(
      entry("user"),
      entry("assistant", { stopReason: "stop" }),
      entry("user"),
      entry("assistant", { stopReason: "error", errorMessage: "empty_stream" }),
      entry("user"),
      entry("assistant", { stopReason: "error", errorMessage: "empty_stream" }),
      entry("user"),
      entry("assistant", { stopReason: "error", errorMessage: "empty_stream" }),
    );

    const result = evaluateSessionHealth(sessionPath);
    expect(result.healthy).toBe(false);
    expect(result.recentErrors).toBe(3);
    expect(result.totalChecked).toBe(4);
  });

  it("only inspects the configured lookback window", () => {
    const lines = [];
    for (let i = 0; i < 5; i++) {
      lines.push(entry("user"));
      lines.push(entry("assistant", { stopReason: "error" }));
    }
    for (let i = 0; i < 10; i++) {
      lines.push(entry("user"));
      lines.push(entry("assistant", { stopReason: "stop" }));
    }
    writeSession(...lines);

    const result = evaluateSessionHealth(sessionPath, { lookback: 10 });
    expect(result.healthy).toBe(true);
    expect(result.recentErrors).toBe(0);
    expect(result.totalChecked).toBe(10);
  });

  it("skips malformed jsonl lines", () => {
    writeSession(
      "not json",
      "{broken json",
      entry("assistant", { stopReason: "error" }),
    );

    const result = evaluateSessionHealth(sessionPath);
    expect(result.healthy).toBe(true);
    expect(result.recentErrors).toBe(1);
    expect(result.totalChecked).toBe(1);
  });

  it("ignores non-message and non-assistant entries", () => {
    writeSession(
      JSON.stringify({ type: "compaction", summary: "earlier turns" }),
      JSON.stringify({ type: "model_change", provider: "openai", modelId: "gpt-5" }),
      JSON.stringify({ type: "message", id: "tool", message: { role: "tool_result", content: [] } }),
      entry("assistant", { stopReason: "error" }),
    );

    const result = evaluateSessionHealth(sessionPath);
    expect(result.totalChecked).toBe(1);
    expect(result.recentErrors).toBe(1);
    expect(result.healthy).toBe(true);
  });

  it("respects a custom error threshold", () => {
    writeSession(
      entry("assistant", { stopReason: "error" }),
      entry("assistant", { stopReason: "stop" }),
    );

    expect(evaluateSessionHealth(sessionPath, { errorThreshold: 1 }).healthy).toBe(false);
    expect(evaluateSessionHealth(sessionPath, { errorThreshold: 5 }).healthy).toBe(true);
  });

  it("treats read errors as healthy so restore remains best effort", () => {
    const result = evaluateSessionHealth(tmpDir);
    expect(result.healthy).toBe(true);
    expect(result.exists).toBe(false);
  });
});

describe("repairOrphanToolResultEntries", () => {
  it("removes toolResult entries whose parent assistant tool call is dropped by replay", () => {
    const entries = [
      { type: "session", id: "s1" },
      {
        type: "message",
        id: "a-error",
        parentId: "s1",
        message: {
          role: "assistant",
          stopReason: "error",
          content: [{ type: "toolCall", id: "call-1", name: "read" }],
        },
      },
      {
        type: "message",
        id: "tool-orphan",
        parentId: "a-error",
        message: { role: "toolResult", toolCallId: "call-1", content: "ok" },
      },
      {
        type: "message",
        id: "user-next",
        parentId: "tool-orphan",
        message: { role: "user", content: "continue" },
      },
    ];

    const result = repairOrphanToolResultEntries(entries);

    expect(result.removed).toBe(1);
    expect(result.entries.map((entry) => entry.id)).toEqual(["s1", "a-error", "user-next"]);
    expect(result.entries[2].parentId).toBe("a-error");
  });

  it("keeps paired toolResult entries when the assistant tool call survives replay", () => {
    const entries = [
      { type: "session", id: "s1" },
      {
        type: "message",
        id: "a-ok",
        parentId: "s1",
        message: {
          role: "assistant",
          stopReason: "tool_use",
          content: [{ type: "toolCall", id: "call-1", name: "read" }],
        },
      },
      {
        type: "message",
        id: "tool-ok",
        parentId: "a-ok",
        message: { role: "toolResult", toolCallId: "call-1", content: "ok" },
      },
    ];

    const result = repairOrphanToolResultEntries(entries);

    expect(result.removed).toBe(0);
    expect(result.entries).toBe(entries);
  });
});

describe("repairOrphanToolResultEntriesInFile", () => {
  it("rewrites a session jsonl file after removing orphan toolResult entries", () => {
    const lines = [
      { type: "session", id: "s1" },
      {
        type: "message",
        id: "a-error",
        message: {
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "toolCall", id: "call-1", name: "read" }],
        },
      },
      {
        type: "message",
        id: "tool-orphan",
        parentId: "a-error",
        message: { role: "toolResult", toolCallId: "call-1", content: "ok" },
      },
    ];
    writeSession(...lines.map((line) => JSON.stringify(line)));

    const result = repairOrphanToolResultEntriesInFile(sessionPath);
    const rewritten = fs.readFileSync(sessionPath, "utf-8");

    expect(result).toEqual({ repaired: true, removed: 1 });
    expect(rewritten).not.toContain("tool-orphan");
  });
});
