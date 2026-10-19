import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../core/llm-client.ts", () => ({ callText: vi.fn() }));
import { callText } from "../core/llm-client.ts";
import { extractSessionExperiences, parseExperienceCandidates } from "../lib/experience-extractor.ts";
import { openExperienceStore } from "../lib/experience-store.ts";
let dir: string;
const summary = "This is a conversation summary describing attempts and results. ".repeat(4);
const context = { sessionId: "session-a", sourceRevision: 1, projectId: "project-a", platform: "linux", messageIds: ["message-a"], runId: "run-a" };
function extract(ctx = context) { return extractSessionExperiences(summary, path.join(dir, "experience"), path.join(dir, "experience.md"), { model: "mock" }, ctx); }
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-experience-extractor-")); vi.mocked(callText).mockReset(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
describe("strict candidate extraction", () => {
  it.each(["not-json", "{}", '[{"category":"Build"}]', '[{"category":"Build","content":"ok"},null]'])("fails malformed output without successful processing: %s", async raw => {
    vi.mocked(callText).mockResolvedValueOnce(raw);
    expect((await extract()).status).toBe("failed");
    vi.mocked(callText).mockResolvedValueOnce("[]");
    expect((await extract()).status).toBe("succeeded");
    expect(callText).toHaveBeenCalledTimes(2);
  });
  it("accepts success-empty once and deduplicates restart", async () => {
    vi.mocked(callText).mockResolvedValueOnce("[]");
    expect(await extract()).toEqual({ extracted: 0, status: "succeeded" });
    expect(await extract()).toEqual({ extracted: 0, status: "skipped", reason: "already_processed" });
    expect(callText).toHaveBeenCalledTimes(1);
  });
  it("never trusts model-supplied scope, provenance or confidence", async () => {
    vi.mocked(callText).mockResolvedValueOnce(JSON.stringify([{ category: "Build", content: "Run targeted checks.", state: "enabled", confidence: 1, applicability: { scope: "global" }, sourceRefs: [{ type: "run", id: "fake" }] }]));
    expect((await extract()).extracted).toBe(1);
    const store = openExperienceStore(dir);
    try {
      const entry = store.list()[0];
      expect(entry.state).toBe("candidate");
      expect(entry.applicability.scope).toBe("project");
      expect(entry.sourceRefs.some(ref => ref.id === "fake")).toBe(false);
      expect(entry.sourceRefs.some(ref => ref.type === "message" && ref.id === "message-a")).toBe(true);
      expect(entry.stats.verifiedSuccess).toBe(0);
    } finally { store.close(); }
  });
  it("rejects entire batch atomically on invalid candidate content", async () => {
    vi.mocked(callText).mockResolvedValueOnce(JSON.stringify([{ category: "Build", content: "A useful candidate" }, { category: "../bad", content: "An unsafe category" }]));
    expect((await extract()).status).toBe("failed");
    const store = openExperienceStore(dir);
    try { expect(store.list()).toEqual([]); } finally { store.close(); }
  });
  it("does not let in-flight extraction resurrect cleared source", async () => {
    vi.mocked(callText).mockImplementationOnce(async () => {
      const store = openExperienceStore(dir);
      try { store.clear(); } finally { store.close(); }
      return '[{"category":"Build","content":"Stale snapshot"}]';
    });
    expect((await extract()).status).toBe("failed");
    const store = openExperienceStore(dir);
    try { expect(store.list()).toEqual([]); } finally { store.close(); }
  });
  it("checks pause again after awaiting model", async () => {
    let enabled = true;
    vi.mocked(callText).mockImplementationOnce(async () => { enabled = false; return '[{"category":"Build","content":"New snapshot"}]'; });
    expect(await extractSessionExperiences(summary, path.join(dir, "experience"), "", { model: "mock" }, { ...context, isEnabled: () => enabled })).toEqual({ extracted: 0, status: "skipped", reason: "paused" });
  });
  it("requires actual session source revision and bounds output", async () => {
    expect((await extractSessionExperiences(summary, path.join(dir, "experience"), "", {}, {})).status).toBe("failed");
    expect(callText).not.toHaveBeenCalled();
    expect(() => parseExperienceCandidates(JSON.stringify(Array(9).fill({ category: "Build", content: "text" })))).toThrow("eight");
  });
});
