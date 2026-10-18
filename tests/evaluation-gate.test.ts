import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { scoreEvaluation } from "../scripts/evaluation-gate.mjs";

const manifest = JSON.parse(fs.readFileSync(new URL("../evals/reliability-cases.json", import.meta.url), "utf8"));
function passingResults() {
  const grouped = new Map<string, { name: string; assertionResults: Array<{ title: string; status: string; duration: number }> }>();
  for (const c of manifest.cases) {
    if (!grouped.has(c.file)) grouped.set(c.file, { name: `/repo/${c.file}`, assertionResults: [] });
    grouped.get(c.file)!.assertionResults.push({ title: c.test, status: "passed", duration: 1 });
  }
  return { testResults: [...grouped.values()] };
}

describe("deterministic evaluation gate", () => {
  it("scores exactly 30 verified cases and keeps live-model validation pending", () => {
    const report = scoreEvaluation(manifest, passingResults(), { traceId: "evaluation-test" });
    expect(report).toMatchObject({ passed: true, score: 30, maximumScore: 30, realModelValidation: { status: "pending" } });
    expect(report.cases).toHaveLength(30);
  });
  it("fails closed on missing or skipped assertions and nonzero runner exit", () => {
    expect(scoreEvaluation(manifest, {}).passed).toBe(false);
    const results = passingResults();
    results.testResults[0].assertionResults[0].status = "pending";
    expect(scoreEvaluation(manifest, results)).toMatchObject({ passed: false, score: 29 });
    expect(scoreEvaluation(manifest, passingResults(), { exitCode: 1 }).passed).toBe(false);
  });
  it("rejects ambiguous duplicate matches and duplicate case IDs", () => {
    const results = passingResults();
    results.testResults[0].assertionResults.push(results.testResults[0].assertionResults[0]);
    expect(scoreEvaluation(manifest, results).passed).toBe(false);
    expect(() => scoreEvaluation({ cases: Array(30).fill(manifest.cases[0]) }, results)).toThrow(/unique/);
  });
  it("does not export raw output, secrets, or local filesystem paths", () => {
    const results = passingResults();
    Object.assign(results.testResults[0], { message: "Bearer secret-token-value", console: "private customer content" });
    const serialized = JSON.stringify(scoreEvaluation(manifest, results));
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("private customer content");
    expect(serialized).not.toContain("/repo/");
  });
});
