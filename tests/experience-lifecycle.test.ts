import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExperienceStore, openExperienceStore, type ExperienceEntry } from "../lib/experience-store.ts";
import { createExperienceTools, listExperienceDocuments, syncExperienceCategories } from "../lib/tools/experience.ts";

let dir: string;
let store: ExperienceStore;
const env = { projectId: "project-a", platform: "linux", appVersion: "1.0", dependencyVersions: { node: "22" } };
function candidate(content = "Run focused tests before building.") {
  return store.createCandidate({ category: "Build", content, sourceRefs: [{ type: "fact", id: "42", revision: 1 }, { type: "session", id: "session-a" }], applicability: { scope: "project", ...env } }).entry;
}
function review(entry: ExperienceEntry, outcome: "success" | "failure" | "unknown" = "success", runId = "run-a") {
  return store.recordReview(entry.id, entry.revision, { eventId: `review-${runId}`, runId, reviewerId: "local-owner", outcome, evidenceRef: `test-results/${runId}.json`, summary: "Executed tests and inspected their result.", environment: env });
}
function enable(entry: ExperienceEntry) {
  entry = review(entry);
  entry = store.transition(entry.id, entry.revision, "validated");
  return store.transition(entry.id, entry.revision, "enabled");
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-experience-lifecycle-")); store = openExperienceStore(dir); });
afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("review-gated experience lifecycle", () => {
  it("only advances revocationGeneration for destructive lifecycle changes", () => {
    const initial = store.revocationGeneration;
    let entry = candidate();
    expect(store.revocationGeneration).toBe(initial);
    entry = review(entry);
    expect(store.revocationGeneration).toBe(initial);
    entry = store.transition(entry.id, entry.revision, "validated");
    entry = store.transition(entry.id, entry.revision, "enabled");
    store.recordFeedback(entry.id, { runId: "read-run", eventId: "read", event: "retrieved", experienceRevision: entry.revision });
    expect(store.revocationGeneration).toBe(initial);
    const exactGeneration = store.generation;
    candidate("Another new candidate");
    expect(store.generation).not.toBe(exactGeneration);
    expect(store.revocationGeneration).toBe(initial);
    entry = store.revise(entry.id, entry.revision, { applicability: { scope: "project", ...env, appVersion: "2.0" } });
    const revised = store.revocationGeneration;
    expect(revised).not.toBe(initial);
    store.transition(entry.id, entry.revision, "withdrawn");
    const withdrawn = store.revocationGeneration;
    expect(withdrawn).not.toBe(revised);
    store.clear();
    expect(store.revocationGeneration).not.toBe(withdrawn);
    const persisted = store.revocationGeneration;
    store.close(); store = openExperienceStore(dir);
    expect(store.revocationGeneration).toBe(persisted);
  });
  it("deduplicates identical sourced candidates across different delivery event IDs", () => {
    const input = { category: "Build", content: "An identical sourced lesson", sourceRefs: [{ type: "session" as const, id: "session-a" }], applicability: { scope: "project" as const, ...env } };
    const first = store.createCandidate(input, { eventId: "delivery-a" });
    const second = store.createCandidate(input, { eventId: "delivery-b" });
    expect(second.added).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(store.list()).toHaveLength(1);
    expect(() => store.createCandidate({ ...input, content: "Conflicting retry" }, { eventId: "delivery-b" })).toThrow("idempotency_conflict");
  });
  it("never validates confidence or enables a candidate directly", () => {
    const entry = candidate();
    expect(entry.state).toBe("candidate");
    expect(() => store.transition(entry.id, entry.revision, "validated")).toThrow("real run outcome");
    expect(() => store.transition(entry.id, entry.revision, "enabled")).toThrow("invalid_transition");
    expect(store.recall({ ...env }).entries).toEqual([]);
  });
  it("validates then enables only a real reviewed run with matching environment", () => {
    const entry = enable(candidate());
    expect(entry.state).toBe("enabled");
    expect(entry.evidence[0].runId).toBe("run-a");
    expect(entry.stats.verifiedSuccess).toBe(1);
    expect(store.recall({ ...env, query: "focused tests", tokenBudget: 4000 }).entries[0].id).toBe(entry.id);
  });
  it("allows reviewed negative lessons without treating failure as success", () => {
    let entry = review(candidate("Do not retry an upload while its external result is unknown."), "failure");
    expect(entry.stats.verifiedFailure).toBe(1);
    expect(entry.stats.verifiedSuccess).toBe(0);
    entry = store.transition(entry.id, entry.revision, "validated");
    expect(store.transition(entry.id, entry.revision, "enabled").state).toBe("enabled");
  });
  it("records unknown without promotion and permits later verified resolution", () => {
    let entry = review(candidate(), "unknown");
    expect(entry.stats.unknown).toBe(1);
    expect(() => store.transition(entry.id, entry.revision, "validated")).toThrow("real run outcome");
    entry = store.recordReview(entry.id, entry.revision, { eventId: "resolved", runId: "run-a", reviewerId: "owner", outcome: "success", evidenceRef: "artifact:checked", summary: "Confirmed result externally", environment: env });
    expect(entry.stats.verifiedSuccess).toBe(1);
  });
  it("rejects missing real evidence and mismatched review environment", () => {
    const entry = candidate();
    const base = { eventId: "review", runId: "run", reviewerId: "owner", outcome: "success" as const, evidenceRef: "test.json", summary: "Checked", environment: env };
    expect(() => store.recordReview(entry.id, entry.revision, { ...base, runId: "" })).toThrow("Invalid runId");
    expect(() => store.recordReview(entry.id, entry.revision, { ...base, evidenceRef: "" })).toThrow("Invalid evidenceRef");
    expect(() => store.recordReview(entry.id, entry.revision, { ...base, environment: { ...env, platform: "win32" } })).toThrow("does not match");
  });
  it("rejects stale compare-and-swap writes across connections", () => {
    const entry = candidate();
    const other = openExperienceStore(dir);
    try {
      store.revise(entry.id, entry.revision, { content: "Run the corrected tests." });
      expect(() => other.revise(entry.id, entry.revision, { content: "Overwrite from stale snapshot" })).toThrow("revision_conflict");
    } finally { other.close(); }
  });
  it("resets edited content to candidate and cannot reuse its previous review", () => {
    let entry = enable(candidate());
    entry = store.revise(entry.id, entry.revision, { content: "A different operational claim" });
    expect(entry.state).toBe("candidate");
    expect(() => store.transition(entry.id, entry.revision, "validated")).toThrow("real run outcome");
    expect(store.recall(env).entries).toEqual([]);
  });
  it("keeps retrieval, injection and attempted separate from real success", () => {
    const entry = enable(candidate());
    for (const event of ["retrieved", "injected", "attempted"] as const) {
      const feedback = { runId: "run-b", eventId: "call-1", experienceRevision: entry.revision, event };
      expect(store.recordFeedback(entry.id, feedback).added).toBe(true);
      expect(store.recordFeedback(entry.id, feedback).added).toBe(false);
    }
    const updated = store.get(entry.id)!;
    expect(updated.stats).toEqual({ retrieved: 1, injected: 1, attempted: 1, verifiedSuccess: 1, verifiedFailure: 0, unknown: 0 });
    expect(() => store.recordFeedback(entry.id, { runId: "run-b", eventId: "invented", experienceRevision: entry.revision, event: "verifiedSuccess" })).toThrow("evidence_required");
  });
  it("makes review retries idempotent and one run cannot inflate independent results", () => {
    const initial = candidate();
    const reviewed = review(initial);
    expect(review(initial).revision).toBe(reviewed.revision);
    expect(store.recordFeedback(initial.id, { runId: "run-a", eventId: "another-event", experienceRevision: reviewed.revision, event: "verifiedSuccess", evidenceId: reviewed.evidence[0].id }).added).toBe(false);
    expect(store.get(initial.id)!.stats.verifiedSuccess).toBe(1);
    expect(() => store.recordReview(initial.id, reviewed.revision, { eventId: "duplicate-run", runId: "run-a", reviewerId: "owner", outcome: "success", evidenceRef: "another.json", summary: "Same run", environment: env })).toThrow("independent outcome");
  });
  it.each([{ ...env, projectId: "other" }, { ...env, platform: "win32" }, { ...env, appVersion: "2.0" }, { ...env, dependencyVersions: { node: "23" } }, {}])("filters applicability before ranked selection: %j", context => {
    enable(candidate());
    expect(store.recall({ ...context, query: "tests", tokenBudget: 4000 }).entries).toEqual([]);
  });
  it("does not make missing context globally applicable", () => {
    const entry = store.createCandidate({ category: "Unknown", content: "This has no trusted project." }).entry;
    expect(entry.applicability.scope).toBe("project");
    expect(() => review(entry)).toThrow("does not match");
  });
  it("enforces budget over trust wrapper, source IDs, environment and text", () => {
    enable(candidate());
    const result = store.recall({ ...env, tokenBudget: 2000 });
    expect(result.text).toContain("untrusted historical data");
    expect(result.text).toContain(`[codia-experience-generation:${store.generation}]`);
    expect(Buffer.byteLength(result.text)).toBe(result.usedTokens);
    expect(result.usedTokens).toBeLessThanOrEqual(2000);
    expect(store.recall({ ...env, tokenBudget: 3 }).entries).toEqual([]);
  });
  it("withdraws direct and transitive derivations and fences pending extraction", () => {
    const root = enable(candidate());
    const derived = store.createCandidate({ category: "Derived", content: "Derived lesson", parentMemoryIds: [root.id], applicability: { scope: "project", ...env } }).entry;
    const epoch = store.epoch;
    expect(store.invalidateSources([{ type: "fact", id: "42" }])).toBe(2);
    expect(store.get(root.id)!.state).toBe("withdrawn");
    expect(store.get(derived.id)!.state).toBe("withdrawn");
    expect(store.get(root.id)!.content).not.toContain("focused tests");
    expect(() => store.commitExtraction("late", [{ category: "Late", content: "old snapshot" }], epoch)).toThrow("source_invalidated");
    expect(() => candidate()).toThrow("source_invalidated");
  });
  it("invalidates reviewed run provenance and survives restart", () => {
    const entry = enable(candidate());
    const generation = store.generation;
    store.invalidateSources([{ type: "run", id: "run-a" }]);
    expect(store.generation).not.toBe(generation);
    store.close(); store = openExperienceStore(dir);
    expect(store.get(entry.id)!.state).toBe("withdrawn");
    expect(store.recall(env).entries).toEqual([]);
  });
  it("migrates legacy only to candidates, and deletion cannot reimport legacy text", () => {
    const file = path.join(dir, "experience", "old.md");
    fs.writeFileSync(file, "1. Legacy guidance without proven sources.\n");
    store.migrateLegacy(path.dirname(file));
    const migrated = store.list().find(entry => entry.category === "old")!;
    expect(migrated.state).toBe("candidate");
    expect(store.recall(env).entries).toEqual([]);
    store.invalidateSources([{ type: "session", id: "unknown-old-session" }]);
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, "1. Legacy guidance without proven sources.\n");
    expect(store.migrateLegacy(path.dirname(file))).toBe(0);
    expect(store.get(migrated.id)!.state).toBe("withdrawn");
  });
  it("legacy editor corrections withdraw enabled text instead of editing verified content", () => {
    const entry = enable(candidate());
    syncExperienceCategories(path.join(dir, "experience"), path.join(dir, "experience.md"), new Map([["Build", ["1. A newly edited lesson."]]]));
    expect(store.get(entry.id)!.state).toBe("withdrawn");
    expect(store.list().find(item => item.content === "A newly edited lesson.")!.state).toBe("candidate");
    expect(listExperienceDocuments(path.join(dir, "experience"))[0].body).not.toContain("focused tests");
  });
  it("clear removes projection content and blocks stale reopen", () => {
    const entry = candidate();
    fs.writeFileSync(path.join(dir, "experience.md"), entry.content);
    store.clear();
    expect(fs.readFileSync(path.join(dir, "experience.md"), "utf8")).toBe("");
    expect(store.get(entry.id)!.content).toBe("[Source withdrawn]");
    expect(() => candidate()).toThrow("source_invalidated");
  });
  it("rejects credentials instead of persisting them as candidates", () => {
    expect(() => candidate("Use api_key=supersecrettoken123 for the request.")).toThrow("Credentials");
    expect(store.list()).toHaveLength(0);
  });
  it("can assign a project to a legacy candidate without implicitly withdrawing or enabling it", () => {
    const file = path.join(dir, "experience", "legacy.md");
    fs.writeFileSync(file, "1. A legacy lesson to review.\n");
    store.migrateLegacy(path.dirname(file));
    let entry = store.list()[0];
    entry = store.revise(entry.id, entry.revision, { applicability: { scope: "project", ...env } });
    expect(entry.state).toBe("candidate");
    expect(enable(entry).state).toBe("enabled");
  });
  it("withdraws dependent lessons when an experience is manually withdrawn", () => {
    const root = enable(candidate());
    const child = store.createCandidate({ category: "Derived", content: "A child lesson", parentMemoryIds: [root.id], applicability: { scope: "project", ...env } }).entry;
    store.transition(root.id, root.revision, "withdrawn");
    expect(store.get(child.id)!.state).toBe("withdrawn");
    expect(() => store.createCandidate({ category: "Derived", content: "Another child", parentMemoryIds: [root.id] })).toThrow("source_invalidated");
  });
  it("replays durable upstream source revocations after interrupted propagation and backup restore", () => {
    const entry = enable(candidate());
    store.db.pragma("wal_checkpoint(TRUNCATE)");
    const snapshot = fs.readFileSync(store.dbPath);
    const memoryDir = path.join(dir, "memory");
    fs.mkdirSync(memoryDir);
    fs.writeFileSync(path.join(memoryDir, "lifecycle.json"), JSON.stringify({ generation: "new-generation", tombstones: [{ eventId: "revocation-a", at: new Date().toISOString(), factIds: ["42"], memoryIds: [], sessions: [], reason: "deleted" }] }));
    // No direct invalidateSources call: every read must still honor the persisted deny event.
    expect(store.get(entry.id)!.state).toBe("withdrawn");
    const dbPath = store.dbPath;
    store.close();
    fs.writeFileSync(dbPath, snapshot);
    store = openExperienceStore(dir);
    expect(store.get(entry.id)!.state).toBe("withdrawn");
    expect(store.recall(env).entries).toEqual([]);
    expect(() => candidate()).toThrow("source_invalidated");
  });
  it("fails closed on a corrupt upstream revocation journal", () => {
    enable(candidate());
    fs.mkdirSync(path.join(dir, "memory"));
    fs.writeFileSync(path.join(dir, "memory", "lifecycle.json"), "{broken");
    expect(() => store.recall(env)).toThrow();
  });
  it("trusted runtime scope cannot be widened by model-supplied recall parameters", async () => {
    const entry = enable(candidate());
    const [recall] = createExperienceTools(dir, { isEnabled: () => true, getContext: () => ({ ...env, projectId: "other", runId: "run-b" }) });
    const hidden = await recall.execute("call-1", { projectId: "project-a", category: "Build" });
    expect(hidden.details).toMatchObject({ memoryIds: [] });
    const [allowed] = createExperienceTools(dir, { isEnabled: () => true, getContext: () => ({ ...env, runId: "run-b" }) });
    await allowed.execute("call-2", { category: "Build" });
    await allowed.execute("call-2", { category: "Build" });
    expect(store.get(entry.id)!.stats.retrieved).toBe(1);
    expect(store.get(entry.id)!.stats.injected).toBe(1);
    expect(store.get(entry.id)!.stats.verifiedSuccess).toBe(1);
  });
});
