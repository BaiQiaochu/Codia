#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const help = args.includes("--help") || args.includes("-h");
const reportArg = args.find((arg) => arg.startsWith("--report="));
const markdownArg = args.find((arg) => arg.startsWith("--markdown="));
const reportPath = reportArg ? path.resolve(reportArg.slice("--report=".length)) : null;
const markdownPath = markdownArg ? path.resolve(markdownArg.slice("--markdown=".length)) : null;

const SCAN_ROOTS = [
  ".github",
  "core",
  "desktop",
  "hub",
  "lib",
  "plugins",
  "scripts",
  "server",
  "shared",
  "tests",
];

const EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".md",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const SKIP_DIRS = new Set([
  ".cache",
  ".git",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "dist-folder",
  "dist-renderer",
  "dist-sandbox",
  "dist-server",
  "dist-server-bundle",
  "node_modules",
  "out",
  "release",
  "vendor",
]);

const SKIP_FILES = new Set(["package-lock.json"]);

const MOJIBAKE_CODEPOINTS = new Set([
  0xfffd,
  0x922b,
  0x9225,
  0x9236,
  0x9239,
  0x923a,
  0x934b,
  0x934f,
  0x9350,
  0x9352,
  0x9356,
  0x9357,
  0x93ba,
  0x93c2,
  0x93c3,
  0x93c9,
  0x93cd,
  0x9422,
  0x951b,
  0x95b8,
  0x95ba,
  0x5a34,
  0x6d93,
  0x6fe1,
  0x7e47,
  0x7efe,
  0x3125,
  0x4f78,
  0x52eb,
  0x53c6,
  0x53ff,
  0x58ca,
  0x5a09,
  0x5d89,
  0x608a,
  0x6262,
  0x6427,
  0x6722,
  0x6b13,
  0x6d60,
  0x6e36,
  0x70b6,
  0x7481,
  0x7586,
  0x7455,
  0x756c,
  0x6924,
  0x769f,
  0x7caf,
  0x9365,
  0x93c1,
  0x93c4,
  0x93cb,
  0x940f,
  0x95c8,
  0x9722,
  0x9983,
]);

const SAFE_FALSE_POSITIVE_RE = [
  /MOJIBAKE/i,
  /MOJIBAKE_CODEPOINTS/,
  /MOJIBAKE_TEXT_RE/,
  /not\.toMatch/,
  /not\.toContain/,
  /expect\(.*\)\.not\./,
  /String\.fromCodePoint/,
];

const MOJIBAKE_TEXT_RE = /鑱婂ぉ璁板綍/u;

function usage() {
  console.log(`mojibake-audit

Scans source files for common mojibake markers and replacement characters.

Options:
  --json              Print JSON only
  --report=<path>     Write JSON report
  --markdown=<path>   Write Markdown report
`);
}

if (help) {
  usage();
  process.exit(0);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || /^openhanako-\d/.test(entry.name)) continue;
      walk(path.join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".bundle.cjs")) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(path.join(dir, entry.name));
  }
  return files;
}

function rel(file) {
  return toPosix(path.relative(ROOT, file));
}

function isKnownSafeFalsePositive(fileRel, line) {
  if (fileRel === "scripts/mojibake-audit.mjs") return true;
  return SAFE_FALSE_POSITIVE_RE.some((pattern) => pattern.test(line));
}

function markerScore(line) {
  let score = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0);
    if (MOJIBAKE_CODEPOINTS.has(cp)) score += cp === 0xfffd ? 20 : 3;
    else if (cp >= 0xe000 && cp <= 0xf8ff) score += 8;
    else if (cp === 0x20ac) score += 2;
  }
  if (/\?{3,}/.test(line)) score += 8;
  if (/[\u9225\u9239\u923a]\u20ac/u.test(line)) score += 8;
  if (/(?:\u951b|\u9239|\u923a|\u934b|\u9352|\u95b8|\u95ba).{0,3}\?/u.test(line)) score += 6;
  if (MOJIBAKE_TEXT_RE.test(line)) score += 12;
  return score;
}

function scanFile(file) {
  const fileRel = rel(file);
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    const score = markerScore(line);
    if (score <= 0) return;
    if (isKnownSafeFalsePositive(fileRel, line)) return;
    hits.push({
      file: fileRel,
      line: index + 1,
      score,
      source: line.trim().slice(0, 240),
    });
  });
  return hits;
}

const files = SCAN_ROOTS.flatMap((item) => walk(path.join(ROOT, item)));
const hits = files.flatMap(scanFile);
const report = {
  ok: hits.length === 0,
  generatedAt: new Date().toISOString(),
  scope: SCAN_ROOTS,
  scannedFiles: files.length,
  counts: {
    blockers: hits.length,
    warnings: 0,
  },
  blockers: hits,
  warnings: [],
};

if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (markdownPath) {
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf8");
}

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[mojibake-audit] scanned ${files.length} files; blockers=${hits.length}; warnings=0`);
  for (const item of hits.slice(0, 30)) {
    console.log(`BLOCKER ${item.file}:${item.line} ${item.source}`);
  }
}

process.exit(report.ok ? 0 : 1);

function renderMarkdown(report) {
  const lines = [
    "# Mojibake Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Scanned files: ${report.scannedFiles}`,
    `Blockers: ${report.counts.blockers}`,
    `Warnings: ${report.counts.warnings}`,
    "",
  ];
  for (const item of report.blockers) {
    lines.push(`- BLOCKER ${item.file}:${item.line} ${item.source}`);
  }
  return `${lines.join("\n")}\n`;
}
