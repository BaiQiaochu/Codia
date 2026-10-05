#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CANONICAL_REPORT_RE = /^(comment-code|html-surface|mojibake|pwa-theme-behavior|react-action-button|react-button-type|surface-feature|theme-screenshot|theme-token|theme-visual)-audit\.(json|md)$/;
const KEEP_FILES = new Set([
  "local-health-check.json",
  "package-size-trend.json",
  "package-size-trend-baseline.json",
  "package-size-trend-history.json",
  "theme-screenshot-fixture.html",
]);
const KEEP_DIRS = new Set([
  "ui-overlap-regression",
]);

export function planArtifactCleanup({ artifactsDir = path.resolve("artifacts") } = {}) {
  const resolvedArtifactsDir = path.resolve(artifactsDir);
  if (!fs.existsSync(resolvedArtifactsDir)) {
    return { artifactsDir: resolvedArtifactsDir, keep: [], remove: [] };
  }
  const stat = fs.statSync(resolvedArtifactsDir);
  if (!stat.isDirectory()) {
    throw new Error(`artifacts path is not a directory: ${resolvedArtifactsDir}`);
  }

  const keep = [];
  const remove = [];
  for (const entry of fs.readdirSync(resolvedArtifactsDir, { withFileTypes: true })) {
    const entryPath = path.join(resolvedArtifactsDir, entry.name);
    assertInside(resolvedArtifactsDir, entryPath);
    const item = {
      path: entryPath,
      type: entry.isDirectory() ? "directory" : "file",
      reason: classifyArtifact(entry),
    };
    if (shouldKeepArtifact(entry)) keep.push(item);
    else remove.push(item);
  }
  return { artifactsDir: resolvedArtifactsDir, keep, remove };
}

export function cleanupArtifacts({ artifactsDir = path.resolve("artifacts"), apply = false } = {}) {
  const plan = planArtifactCleanup({ artifactsDir });
  const removed = [];
  if (apply) {
    for (const item of plan.remove) {
      fs.rmSync(item.path, { recursive: true, force: true });
      removed.push(item);
    }
  }
  return { ...plan, apply, removed };
}

function shouldKeepArtifact(entry) {
  if (entry.isDirectory()) return KEEP_DIRS.has(entry.name) || /screenshots?$/i.test(entry.name);
  if (!entry.isFile()) return false;
  if (KEEP_FILES.has(entry.name)) return true;
  return CANONICAL_REPORT_RE.test(entry.name);
}

function classifyArtifact(entry) {
  if (shouldKeepArtifact(entry)) {
    return entry.isDirectory() ? "latest screenshot directory" : "latest canonical report";
  }
  if (entry.isDirectory()) return "non-screenshot artifact directory";
  if (entry.name.startsWith("test-")) return "test audit report";
  return "non-canonical artifact file";
}

function assertInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`refusing to touch path outside artifacts: ${resolvedTarget}`);
  }
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`clean-artifacts

Safely trims generated artifacts while keeping latest audit reports and screenshot directories.

Default mode is dry-run. Pass --apply to delete planned candidates.

Options:
  --apply          Delete cleanup candidates. Without this, only prints the plan.
  --json           Print JSON.
  --artifacts=DIR  Override artifacts directory, default artifacts
`);
    return 0;
  }

  const apply = args.includes("--apply");
  const jsonOnly = args.includes("--json");
  const artifactsArg = valueArg(args, "--artifacts");
  const result = cleanupArtifacts({
    artifactsDir: artifactsArg ? path.resolve(artifactsArg) : path.resolve("artifacts"),
    apply,
  });
  const output = {
    ok: true,
    mode: apply ? "apply" : "dry-run",
    artifactsDir: result.artifactsDir,
    counts: {
      keep: result.keep.length,
      remove: result.remove.length,
      removed: result.removed.length,
    },
    keep: result.keep.map(formatItem),
    remove: result.remove.map(formatItem),
    removed: result.removed.map(formatItem),
  };

  if (jsonOnly) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`[clean-artifacts] mode=${output.mode} keep=${output.counts.keep} remove=${output.counts.remove} removed=${output.counts.removed}`);
    for (const item of output.remove) {
      console.log(`[clean-artifacts] remove ${item.type}: ${item.path} (${item.reason})`);
    }
    if (!apply && output.counts.remove > 0) {
      console.log("[clean-artifacts] dry-run only; pass --apply to delete these entries.");
    }
  }
  return 0;
}

function formatItem(item) {
  return {
    path: path.relative(process.cwd(), item.path).replace(/\\/g, "/"),
    type: item.type,
    reason: item.reason,
  };
}

function valueArg(args, name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(runCli());
  } catch (error) {
    console.error(`[clean-artifacts] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
