#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import redactor from "../shared/log-redactor.cjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function scoreEvaluation(manifest, results, { exitCode = 0, traceId = randomUUID() } = {}) {
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 30) throw new Error("Gate requires exactly 30 explicit cases");
  if (new Set(manifest.cases.map(c => c.id)).size !== 30) throw new Error("Evaluation case IDs must be unique");
  const cases = manifest.cases.map(c => {
    const matches = (results.testResults || []).filter(f => f.name.replaceAll("\\", "/").endsWith(`/${c.file}`))
      .flatMap(f => f.assertionResults || []).filter(a => a.title === c.test);
    const result = matches.length === 1 ? matches[0] : null;
    const status = result?.status === "passed" ? "passed" : result?.status === "failed" ? "failed" : "unverified";
    return {
      id: c.id, traceId, category: c.category, source: c.file, test: c.test,
      status, score: status === "passed" ? c.points : 0, maximumScore: c.points,
      durationMs: Number.isFinite(result?.duration) ? result.duration : null,
      // Exclude raw test output, environment, prompts, tool payloads, and local paths.
      failure: status === "failed" ? "Assertion failed; inspect local test output." : status === "unverified" ? "Missing, skipped, or ambiguous test result." : null,
    };
  });
  return redactor.redactLogValue({
    schemaVersion: 1, traceId, generatedAt: new Date().toISOString(),
    kind: "deterministic-regression", passed: exitCode === 0 && cases.every(c => c.status === "passed"),
    score: cases.reduce((n, c) => n + c.score, 0), maximumScore: cases.reduce((n, c) => n + c.maximumScore, 0),
    realModelValidation: { status: "pending", note: "No live model calls, task-quality baseline, or cost comparison were measured by this gate." },
    cases,
  });
}

export function runEvaluationGate(output = path.join(ROOT, "artifacts", "evaluation-report.json")) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/reliability-cases.json"), "utf8"));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codia-evaluation-"));
  try {
    const rawFile = path.join(temp, "results.json");
    const result = spawnSync(process.execPath, [path.join(ROOT, "node_modules/vitest/vitest.mjs"), "run",
      ...new Set(manifest.cases.map(c => c.file)), "--maxWorkers=2", "--reporter=json", `--outputFile=${rawFile}`], {
      cwd: ROOT, stdio: "inherit", shell: false,
    });
    const raw = fs.existsSync(rawFile) ? JSON.parse(fs.readFileSync(rawFile, "utf8")) : {};
    const report = scoreEvaluation(manifest, raw, { exitCode: result.status ?? 1 });
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    report.revision = revision.status === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null;
    report.workingTree = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim() ? 'modified' : 'clean';
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(`Evaluation gate: ${report.score}/${report.maximumScore}; ${report.passed ? "PASS" : "FAIL"}. Live-model validation pending.`);
    return report.passed ? 0 : 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runEvaluationGate(process.argv[2]);
}
