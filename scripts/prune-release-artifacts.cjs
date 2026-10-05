const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

const defaultTargets = [
  path.join(root, "dist-server"),
  path.join(root, "dist-folder"),
  path.join(root, "dist-repack"),
  path.join(root, "dist-portable"),
  path.join(root, "dist"),
];

const args = process.argv.slice(2);
const targets = (args.length ? args : defaultTargets).map((p) => path.resolve(root, p));

const dirNamesToRemove = new Set([
  ".cache",
  ".git",
  ".github",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  "__pycache__",
  "docs",
  "test",
  "tests",
]);

const fileNamesToRemove = new Set([
  ".dockerignore",
  ".editorconfig",
  ".env.example",
  ".envrc",
  ".gitattributes",
  ".gitignore",
  ".gitmodules",
  ".mailmap",
  ".prettierrc",
  ".prettierrc.json",
  ".yarnrc",
  "npm-debug.log",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-debug.log",
  "yarn.lock",
  "yarn-error.log",
]);

const filePatternsToRemove = [
  /^CHANGELOG(?:\.(?:md|markdown|txt|rst|html))?$/i,
  /^CONTRIBUTING(?:\.(?:md|markdown|txt|rst|html))?$/i,
  /^README(?:\.(?:md|markdown|txt|rst|html))?$/i,
  /^RELEASE_NOTES(?:[_-].*)?(?:\.(?:md|markdown|txt|rst|html))?$/i,
  /^SECURITY(?:\.(?:md|markdown|txt|rst|html))?$/i,
  /^\.coverage$/i,
  /(?:^|[-.])debug\.log$/i,
  /\.log$/i,
  /\.map$/i,
  /\.py[co]$/i,
  /\.tsbuildinfo$/i,
];

function shouldRemoveFile(filePath) {
  const base = path.basename(filePath);
  if (fileNamesToRemove.has(base)) return true;
  return filePatternsToRemove.some((pattern) => pattern.test(base));
}

function removePath(target, stats) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    stats.removed += 1;
  } catch (err) {
    stats.failed.push(`${target}: ${err.message}`);
  }
}

function walk(current, stats) {
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (dirNamesToRemove.has(entry.name)) {
        removePath(full, stats);
        continue;
      }
      walk(full, stats);
      continue;
    }

    if (entry.isFile() && shouldRemoveFile(full)) {
      removePath(full, stats);
    }
  }
}

const stats = { removed: 0, failed: [] };
for (const target of targets) {
  if (!fs.existsSync(target)) continue;
  walk(target, stats);
}

console.log(`[prune-release-artifacts] removed ${stats.removed} redundant path(s)`);
if (stats.failed.length) {
  for (const failure of stats.failed) console.warn(`[prune-release-artifacts] failed ${failure}`);
}
