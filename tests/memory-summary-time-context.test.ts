import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/i18n.js", () => ({
  getLocale: () => "en-US",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

import { callText } from "../core/llm-client.js";
import { SessionSummaryManager } from "../lib/memory/session-summary.js";

const RESOLVED_MODEL = {
  model: "m",
  api: "openai-completions",
  api_key: "k",
  base_url: "http://x",
};

describe("session summary time anchoring", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "codia-memory-summary-"));
    vi.clearAllMocks();
    vi.mocked(callText).mockResolvedValue("### Key Facts\n- None\n\n### Timeline\n- 2026-05-16 14:30 User worked on Codia.");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("passes full local date-time annotations and memory scope policy to the summarizer", async () => {
    const manager = new SessionSummaryManager(root);

    await manager.rollingSummary("session-a", [
      {
        role: "user",
        content: "Please fix the memory system",
        timestamp: "2026-05-16T06:30:00.000Z",
      },
    ], RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    const request = vi.mocked(callText).mock.calls[0][0];
    expect(request.messages[0].content).toContain("[2026-05-16 14:30]");
    expect(request.systemPrompt).toContain("YYYY-MM-DD HH:MM");
    expect(request.systemPrompt).toContain("Do NOT extract:");
    expect(request.systemPrompt).toContain("Work-style preferences");
    expect(request.systemPrompt).toContain("the user worked on Codia");

    const saved = manager.getSummary("session-a");
    expect(saved.source_time_range).toMatchObject({
      timezone: "Asia/Shanghai",
      localDates: ["2026-05-16"],
    });
  });
});
