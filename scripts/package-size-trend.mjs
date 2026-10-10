#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const reportPath = path.resolve(valueArg("--report") || "artifacts/package-size-trend.json");
const baselinePath = path.resolve(valueArg("--baseline") || "artifacts/package-size-trend-baseline.json");
const historyPath = path.resolve(valueArg("--history") || "artifacts/package-size-trend-history.json");
const jsonOnly = args.includes("--json");
const maxGrowthRatio = Number(valueArg("--max-growth") || "0.25");
const maxGrowthBytes = Number(valueArg("--max-growth-bytes") || String(25 * 1024 * 1024));

const defaultHardMaxBytes = {
  "surface-package": 512 * 1024 * 1024,
  "renderer-assets": 250 * 1024 * 1024,
  "server-bundle": 900 * 1024 * 1024,
  "wasm-assets": 80 * 1024 * 1024,
};

const tracked = [
  { id: "surface-package", path: "artifacts/codia-surfaces-${platform}-${arch}.zip", optional: true },
  { id: "renderer-assets", path: "desktop/dist-renderer", optional: true },
  { id: "server-bundle", path: "dist-server", optional: true },
  { id: "wasm-assets", path: "desktop/dist-renderer", optional: true, match: /\.(wasm|onnx)$/i, largeResource: true },
];

export function collectPackageSizeTrend({
  root = process.cwd(),
  baselineFile = baselinePath,
  growthRatio = maxGrowthRatio,
  growthBytes = maxGrowthBytes,
  hardMaxBytes = defaultHardMaxBytes,
  initializeMissingBaseline = false,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedBaselineFile = path.resolve(baselineFile);
  const baselineExistedBeforeRun = fs.existsSync(resolvedBaselineFile);
  let baseline = readBaseline(resolvedBaselineFile);
  let baselineCreated = false;
  let items = collectItems({ resolvedRoot, baseline, growthRatio, growthBytes, hardMaxBytes });
  if (initializeMissingBaseline && !baselineExistedBeforeRun) {
    writeBaseline(resolvedBaselineFile, items);
    baseline = readBaseline(resolvedBaselineFile);
    baselineCreated = true;
    items = collectItems({ resolvedRoot, baseline, growthRatio, growthBytes, hardMaxBytes });
  }
  const baselineMissing = !baselineCreated && !baselineExistedBeforeRun;
  const blockers = collectBlockers(items);
  if (baselineMissing) {
    blockers.push({
      id: "package-size-baseline",
      kind: "missing-baseline",
      path: slash(path.relative(resolvedRoot, resolvedBaselineFile)),
      message: `package size baseline is missing; run package:size-trend with --init-baseline to create it intentionally`,
    });
  }
  return {
    ok: !baselineMissing && items.every((item) => !item.inflated && !item.exceedsHardMax),
    generatedAt: new Date().toISOString(),
    thresholds: { maxGrowthRatio: growthRatio, maxGrowthBytes: growthBytes, hardMaxBytes },
    baseline: fs.existsSync(resolvedBaselineFile) ? slash(path.relative(resolvedRoot, resolvedBaselineFile)) : null,
    baselineMissing,
    baselineCreated,
    items,
    blockers,
  };
}

function collectItems({ resolvedRoot, baseline, growthRatio, growthBytes, hardMaxBytes }) {
  return tracked.map((entry) => {
    const resolvedPath = resolveTrackedPath(resolvedRoot, entry.path);
    const sizeBytes = measurePath(resolvedPath, entry.match);
    const base = baseline[entry.id]?.sizeBytes;
    const deltaBytes = typeof base === "number" ? sizeBytes - base : null;
    const deltaRatio = typeof base === "number" && base > 0 ? deltaBytes / base : null;
    const inflated = deltaBytes !== null
      && deltaBytes > growthBytes
      && deltaRatio !== null
      && deltaRatio > growthRatio;
    const hardMax = hardMaxBytes?.[entry.id] ?? null;
    const exceedsHardMax = typeof hardMax === "number" && sizeBytes > hardMax;
    return {
      id: entry.id,
      path: slash(path.relative(resolvedRoot, resolvedPath)),
      optional: entry.optional === true,
      largeResource: entry.largeResource === true,
      exists: fs.existsSync(resolvedPath),
      sizeBytes,
      baselineBytes: base ?? null,
      deltaBytes,
      deltaRatio,
      inflated,
      hardMaxBytes: hardMax,
      exceedsHardMax,
    };
  });
}

function collectBlockers(items) {
  return items.flatMap((item) => {
    const blockers = [];
    if (item.inflated) {
      blockers.push({
        id: item.id,
        kind: "trend-growth",
        path: item.path,
        sizeBytes: item.sizeBytes,
        baselineBytes: item.baselineBytes,
        deltaBytes: item.deltaBytes,
        deltaRatio: item.deltaRatio,
        message: `${item.id} grew by ${formatBytes(item.deltaBytes || 0)} (${formatRatio(item.deltaRatio)})`,
      });
    }
    if (item.exceedsHardMax) {
      blockers.push({
        id: item.id,
        kind: "hard-limit",
        path: item.path,
        sizeBytes: item.sizeBytes,
        hardMaxBytes: item.hardMaxBytes,
        message: `${item.id} is ${formatBytes(item.sizeBytes)} and exceeds hard limit ${formatBytes(item.hardMaxBytes)}`,
      });
    }
    return blockers;
  });
}

export function recordPackageSizeTrendHistory(report, {
  historyFile = historyPath,
  maxEntries = 20,
} = {}) {
  const existing = readHistory(historyFile);
  const entry = {
    generatedAt: report.generatedAt,
    ok: report.ok,
    thresholds: report.thresholds,
    items: report.items.map((item) => ({
      id: item.id,
      path: item.path,
      sizeBytes: item.sizeBytes,
      baselineBytes: item.baselineBytes,
      deltaBytes: item.deltaBytes,
      deltaRatio: item.deltaRatio,
      hardMaxBytes: item.hardMaxBytes,
      inflated: item.inflated,
      exceedsHardMax: item.exceedsHardMax,
    })),
  };
  const entries = [...existing.entries, entry].slice(-Math.max(1, maxEntries));
  const next = { entries };
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.writeFileSync(historyFile, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

function readBaseline(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    return Object.fromEntries(items.map((item) => [item.id, item]));
  } catch {
    return {};
  }
}

function writeBaseline(file, items) {
  const baseline = {
    generatedAt: new Date().toISOString(),
    items: items.map((item) => ({
      id: item.id,
      path: item.path,
      sizeBytes: item.sizeBytes,
    })),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
}

function readHistory(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function resolveTrackedPath(root, template) {
  return path.join(root, template
    .replace("${platform}", process.platform)
    .replace("${arch}", process.arch));
}

function measurePath(target, match) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return match && !match.test(target) ? 0 : stat.size;
  if (!stat.isDirectory()) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += measurePath(child, match);
    else if (entry.isFile() && (!match || match.test(child))) total += fs.statSync(child).size;
  }
  return total;
}

function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function formatRatio(value) {
  return typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function slash(value) {
  return value.replace(/\\/g, "/");
}

function valueArg(name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function runCli() {
  const report = collectPackageSizeTrend({
    root: ROOT,
    baselineFile: baselinePath,
    initializeMissingBaseline: args.includes("--init-baseline"),
  });
  recordPackageSizeTrendHistory(report, { historyFile: historyPath });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[package-size-trend] tracked=${report.items.length} blockers=${report.blockers.length}`);
    for (const item of report.items) {
      const delta = item.deltaBytes === null ? "baseline n/a" : `${formatBytes(item.deltaBytes)} ${formatRatio(item.deltaRatio)}`;
      console.log(`[package-size-trend] ${item.id}: ${formatBytes(item.sizeBytes)} (${delta})`);
    }
    if (report.blockers.length > 0) {
      for (const blocker of report.blockers) console.error(`[package-size-trend] ${blocker.message}: ${blocker.path}`);
    }
    console.log(`[package-size-trend] report: ${slash(path.relative(ROOT, reportPath))}`);
    console.log(`[package-size-trend] history: ${slash(path.relative(ROOT, historyPath))}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli());
}
