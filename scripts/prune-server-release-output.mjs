#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SERVER_RELEASE_PRUNE_EXTENSIONS = new Set([
  ".exp",
  ".iobj",
  ".ilk",
  ".ipdb",
  ".lib",
  ".pdb",
  ".pyc",
]);

export function pruneServerReleaseOutput(outDir, { logger = console } = {}) {
  const root = path.resolve(outDir || "");
  if (!root || !fs.existsSync(root)) {
    throw new Error(`[prune-server-release-output] runtime root not found: ${outDir}`);
  }

  const stats = { filesRemoved: 0, bytesRemoved: 0 };
  walk(root, stats);
  logger.log?.(
    `[prune-server-release-output] removed ${stats.filesRemoved} files, ${formatBytes(stats.bytesRemoved)}`,
  );
  return stats;
}

function walk(dir, stats) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, stats);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    const isDependencyReadme = fullPath.split(path.sep).includes("node_modules")
      && /^readme(?:[._-].*)?$/i.test(entry.name);
    if (!isDependencyReadme && !SERVER_RELEASE_PRUNE_EXTENSIONS.has(extension)) continue;
    const size = fs.statSync(fullPath).size;
    fs.rmSync(fullPath, { force: true });
    stats.filesRemoved += 1;
    stats.bytesRemoved += size;
  }
}

function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  pruneServerReleaseOutput(process.argv[2] || path.resolve("dist-server", "win-x64"));
}
