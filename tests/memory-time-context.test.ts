import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/i18n.js", () => ({
  getLocale: () => "en-US",
}));

vi.mock("../core/llm-client.js", () => ({
  callText: vi.fn(),
}));

import { callText } from "../core/llm-client.js";
import { processDirtySessions } from "../lib/memory/deep-memory.js";

const RESOLVED_MODEL = {
  model: "m",
  api: "openai-completions",
  api_key: "k",
  base_url: "http://x",
};

describe("memory fact time context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("corrects example-anchored fact dates when a summary has one source day", async () => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify([
      { fact: "User is focused on memory systems", tags: ["memory"], time: "2026-03-15T14:30" },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([{
        session_id: "single-day",
        summary: "- [14:30] User discussed memory systems.",
        snapshot: "",
        source_time_range: {
          start: "2026-05-16T06:30:00.000Z",
          end: "2026-05-16T07:00:00.000Z",
          timezone: "Asia/Shanghai",
          localDates: ["2026-05-16"],
        },
      }]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, { timeZone: "Asia/Shanghai" });

    expect(vi.mocked(callText).mock.calls[0][0].systemPrompt)
      .toContain("Memory Fact Scope Override");
    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "User is focused on memory systems",
        tags: ["memory"],
        time: "2026-05-16T14:30",
        session_id: "single-day",
      },
    ]);
  });

  it("rejects HH:mm-only fact dates when the source spans multiple local days", async () => {
    vi.mocked(callText).mockResolvedValue(JSON.stringify([
      { fact: "User is focused on memory systems", tags: ["memory"], time: "2026-03-15T00:10" },
    ]));
    const summaryManager = {
      getDirtySessions: vi.fn().mockReturnValue([{
        session_id: "cross-day",
        summary: "- [23:50] Started discussing memory.\n- [00:10] Continued discussing memory.",
        snapshot: "",
      }]),
      markProcessed: vi.fn(),
    };
    const factStore = { addBatch: vi.fn() };
    const getSourceTimeRange = vi.fn(() => ({
      start: "2026-05-16T15:50:00.000Z",
      end: "2026-05-16T16:20:00.000Z",
      timezone: "Asia/Shanghai",
      localDates: ["2026-05-16", "2026-05-17"],
    }));

    await processDirtySessions(summaryManager, factStore, RESOLVED_MODEL, {
      timeZone: "Asia/Shanghai",
      getSourceTimeRange,
    });

    expect(getSourceTimeRange).toHaveBeenCalledWith("cross-day");
    expect(factStore.addBatch).toHaveBeenCalledWith([
      {
        fact: "User is focused on memory systems",
        tags: ["memory"],
        time: null,
        session_id: "cross-day",
      },
    ]);
  });
});
