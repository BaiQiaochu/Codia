import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/i18n.js", () => ({
  getLocale: () => "en-US",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

vi.mock("../lib/time-utils.js", () => ({
  getLogicalDay: () => ({ rangeStart: new Date("2026-05-19T00:00:00.000Z") }),
}));

import { callText } from "../core/llm-client.js";
import { compileToday } from "../lib/memory/compile.js";

const RESOLVED_MODEL = {
  model: "m",
  api: "openai-completions",
  api_key: "k",
  base_url: "http://x",
};

describe("compiled memory scope", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-memory-compile-"));
    vi.clearAllMocks();
    vi.mocked(callText).mockResolvedValue("The user worked on G-SAP.");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("adds debranded broad-theme memory constraints to compile prompts", async () => {
    const summaryManager = {
      getSummariesInRange: vi.fn(() => [{
        session_id: "s1",
        updated_at: "2026-05-19T02:00:00.000Z",
        summary: "### Timeline\n- 2026-05-19 10:00 User worked on G-SAP packaging tests.",
      }]),
    };

    await compileToday(summaryManager, path.join(root, "today.md"), RESOLVED_MODEL);

    const request = vi.mocked(callText).mock.calls[0][0];
    expect(request.systemPrompt).toContain("Compiled Memory Scope Override");
    expect(request.systemPrompt).toContain("G-SAP");
    expect(request.systemPrompt).not.toContain("Project Hana");
    expect(request.systemPrompt).toContain("Do not keep:");
    expect(request.systemPrompt).toContain("commands");
  });
});
