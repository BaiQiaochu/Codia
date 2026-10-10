import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApprovalReviewContext } from "../lib/permission/approval-review-context.ts";

describe("approval review context", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  it("extracts a compact visible transcript from the current session file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-approval-review-context-"));
    const sessionPath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", id: "sess_1" }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-21T01:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Add the export button to the settings panel." }],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-21T01:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private chain of thought" },
            { type: "text", text: "I'll inspect the settings components and wire the button." },
            { type: "tool_use", name: "read", input: { path: "desktop/src/react/Settings.tsx", ignored: "x".repeat(2000) } },
          ],
        },
      }),
    ].join("\n") + "\n");

    const context = buildApprovalReviewContext({
      sessionPath,
      source: { cwd: tmpDir, workspaceFolders: [tmpDir] },
      ctx: { agentId: "codia" },
    });

    expect(context.visibleTranscript).toEqual([
      {
        role: "user",
        timestamp: "2026-06-21T01:00:00.000Z",
        text: "Add the export button to the settings panel.",
      },
      {
        role: "assistant",
        timestamp: "2026-06-21T01:00:01.000Z",
        text: "I'll inspect the settings components and wire the button.",
        toolUses: [{ name: "read", args: { path: "desktop/src/react/Settings.tsx" } }],
      },
    ]);
    expect(JSON.stringify(context.visibleTranscript)).not.toContain("private chain of thought");
    expect(JSON.stringify(context.visibleTranscript)).not.toContain("ignored");
  });
});
