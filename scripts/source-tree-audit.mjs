#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RELEASE_PREFIXES = [
  "bridge/",
  "build/",
  "cli/",
  "core/",
  "desktop/",
  "hub/",
  "lib/",
  "packages/",
  "plugins/",
  "scripts/",
  "server/",
  "shared/",
  "tests/",
];

const RELEASE_FILES = new Set([
  ".gitignore",
  "eslint.config.js",
  "index.js",
  "package-lock.json",
  "package.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "tsconfig.test.json",
  "vite.config.js",
  "vite.config.main.js",
  "vite.config.preload.js",
  "vite.config.server.js",
  "vite.config.theme.js",
  "vite.config.ts",
]);

const IGNORED_PREFIXES = [
  ".cache/",
  ".codex/",
  ".superpowers/",
  "artifacts/",
  "desktop/dist-renderer/",
  "dist/",
  "dist-computer-use/",
  "dist-sandbox/",
  "dist-server/",
  "dist-server-bundle/",
  "dist-folder/",
  "dist-repack/",
  "docs/",
  "node_modules/",
  "codia-",
  "reviews/",
  "tmp/",
  "vendor/",
];

const IGNORED_FILES = new Set([
  "desktop/main.bundle.cjs",
  "desktop/preload.bundle.cjs",
]);

export function parseGitStatusLine(line) {
  if (!line || line.length < 4) return null;
  const xy = line.slice(0, 2);
  const raw = line.slice(3).trim();
  if (!raw) return null;
  const arrow = " -> ";
  const pathPart = raw.includes(arrow) ? raw.slice(raw.lastIndexOf(arrow) + arrow.length) : raw;
  return {
    xy,
    x: xy[0],
    y: xy[1],
    path: normalizePath(pathPart),
    originalPath: raw.includes(arrow) ? normalizePath(raw.slice(0, raw.lastIndexOf(arrow))) : null,
  };
}

export function auditGitStatusText(statusText) {
  const blockers = [];
  const warnings = [];
  const ignored = [];
  const entries = String(statusText || "")
    .split(/\r?\n/)
    .map(parseGitStatusLine)
    .filter(Boolean);

  for (const entry of entries) {
    if (!isReleasePath(entry.path)) {
      ignored.push({ path: entry.path, xy: entry.xy, reason: "outside-release-source" });
      continue;
    }

    if (entry.xy === "??") {
      blockers.push({
        kind: "untracked_release_source",
        path: entry.path,
        xy: entry.xy,
        message: "Release source is present in the working tree but not tracked by Git.",
      });
      continue;
    }

    if (entry.y === "D") {
      blockers.push({
        kind: "deleted_release_source",
        path: entry.path,
        xy: entry.xy,
        message: "Tracked release source is deleted in the working tree but not staged.",
      });
      continue;
    }

    if (entry.x === "D") {
      warnings.push({
        kind: "staged_deleted_release_source",
        path: entry.path,
        xy: entry.xy,
        message: "Release source deletion is staged.",
      });
      continue;
    }

    if (entry.x === "R" || entry.y === "R") {
      warnings.push({
        kind: "renamed_release_source",
        path: entry.path,
        originalPath: entry.originalPath,
        xy: entry.xy,
        message: "Release source rename is pending in the working tree.",
      });
      continue;
    }

    warnings.push({
      kind: "changed_release_source",
      path: entry.path,
      xy: entry.xy,
      message: "Release source has tracked changes in the working tree.",
    });
  }

  return {
    ok: blockers.length === 0,
    counts: {
      scanned: entries.length,
      blockers: blockers.length,
      warnings: warnings.length,
      ignored: ignored.length,
    },
    blockers,
    warnings,
    ignored,
  };
}

export function isReleasePath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized || IGNORED_FILES.has(normalized)) return false;
  if (IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return false;
  }
  return RELEASE_FILES.has(normalized) || RELEASE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^"\s*|\s*"$/g, "");
}

function readGitStatus() {
  if (!fs.existsSync(path.join(ROOT, ".git"))) {
    return {
      fileStateCopy: true,
      error: null,
      statusText: "",
    };
  }
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: ROOT,
    encoding: "utf-8",
    shell: false,
  });
  if (result.status !== 0) {
    return {
      error: result.error?.message || result.stderr || `git status exited ${result.status}`,
      statusText: "",
    };
  }
  return { error: null, statusText: result.stdout || "" };
}

function markdownReport(report) {
  const lines = [
    "# Source Tree Audit",
    "",
    `- ok: ${report.ok}`,
    `- blockers: ${report.counts.blockers}`,
    `- warnings: ${report.counts.warnings}`,
    `- ignored: ${report.counts.ignored}`,
    "",
  ];
  if (report.blockers.length > 0) {
    lines.push("## Blockers", "");
    for (const item of report.blockers.slice(0, 100)) {
      lines.push(`- ${item.kind}: ${item.path} (${item.xy})`);
    }
    if (report.blockers.length > 100) lines.push(`- ... ${report.blockers.length - 100} more`);
    lines.push("");
  }
  if (report.warnings.length > 0) {
    lines.push("## Warnings", "");
    for (const item of report.warnings.slice(0, 100)) {
      lines.push(`- ${item.kind}: ${item.path} (${item.xy})`);
    }
    if (report.warnings.length > 100) lines.push(`- ... ${report.warnings.length - 100} more`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    help: args.has("--help") || args.has("-h"),
    json: args.has("--json"),
    strict: args.has("--strict"),
    reportPath: valueArg(argv, "--report="),
    markdownPath: valueArg(argv, "--markdown="),
  };
}

function valueArg(argv, prefix) {
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function printHelp() {
  console.log([
    "source-tree-audit",
    "",
    "Checks release-relevant source paths for untracked or deleted files before packaging.",
    "",
    "Options:",
    "  --strict              Exit with code 1 when blockers are found.",
    "  --json                Print JSON only.",
    "  --report=<path>       Write JSON report.",
    "  --markdown=<path>     Write Markdown report.",
    "  --help                Show this help.",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const git = readGitStatus();
  let report = auditGitStatusText(git.statusText);
  if (git.fileStateCopy) {
    report = {
      ...report,
      ok: true,
      warnings: [{
        kind: "git_metadata_unavailable_file_state_copy",
        path: ".",
        xy: "--",
        message: "No .git metadata is present; using file-state professional copy mode.",
      }],
      counts: {
        ...report.counts,
        warnings: report.counts.warnings + 1,
      },
    };
  }
  if (git.error) {
    report = {
      ok: false,
      counts: { scanned: 0, blockers: 1, warnings: 0, ignored: 0 },
      blockers: [{
        kind: "git_status_unavailable",
        path: ".",
        xy: "!!",
        message: git.error,
      }],
      warnings: [],
      ignored: [],
    };
  }

  if (options.reportPath) {
    const target = path.resolve(ROOT, options.reportPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  }
  if (options.markdownPath) {
    const target = path.resolve(ROOT, options.markdownPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, markdownReport(report), "utf-8");
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log("[source-tree-audit] ok");
  } else {
    console.error(`[source-tree-audit] ${report.counts.blockers} blocker(s), ${report.counts.warnings} warning(s)`);
    for (const item of report.blockers.slice(0, 20)) {
      console.error(`- ${item.kind}: ${item.path}`);
    }
    if (report.blockers.length > 20) {
      console.error(`- ... ${report.blockers.length - 20} more`);
    }
  }

  if (options.strict && !report.ok) {
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
