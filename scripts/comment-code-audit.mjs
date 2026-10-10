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
  "desktop",
  "server",
  "core",
  "lib",
  "hub",
  "shared",
  "plugins",
  "scripts",
  "tests",
];

const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const SKIP_DIRS = new Set([
  ".cache",
  ".git",
  "artifacts",
  "dist",
  "dist-folder",
  "dist-repack",
  "dist-renderer",
  "dist-sandbox",
  "dist-server",
  "dist-server-bundle",
  "node_modules",
  "vendor",
]);

const RISK_PATTERNS = Object.freeze([
  "// ... if (",
  "// ... window.",
  "// ... return",
  "// ... const ",
  "// ... let ",
  "// ... await ",
  "// ... function ",
]);

const CODEISH_PATTERNS = [
  /\bif\s*\(/,
  /\bfor\s*\(/,
  /\bwhile\s*\(/,
  /\bswitch\s*\(/,
  /\breturn\b/,
  /\bawait\b/,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/,
  /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/,
  /\bwindow\./,
  /\bdocument\./,
];

const INTENTIONAL_COMMENT_RE = /eslint-disable|ts-ignore|@ts-expect-error|istanbul ignore|c8 ignore|vitest|expect\(|toContain\(/;
const CORRUPTION_MARKER_RE = new RegExp(`[${[0x9225, 0x95b3, 0x93b4, 0x934f, 0x9422, 0x951b, 0x6d93, 0x7efe, 0x20ac].map((codePoint) => String.fromCodePoint(codePoint)).join("")}]`, "u");

function usage() {
  console.log(`comment-code-audit

Scans comments for mojibake or ellipsis-prefixed lines that look like executable
code was accidentally commented out.

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

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith("codia-")) continue;
      walk(path.join(dir, entry.name), files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".bundle.cjs")) continue;
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    files.push(path.join(dir, entry.name));
  }
  return files;
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, "/");
}

function isTestFile(fileRel) {
  return fileRel.includes("/tests/")
    || fileRel.includes("/__tests__/")
    || /(?:^|[./-])test\.[cm]?[jt]sx?$/.test(fileRel);
}

function commentText(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith("//")) return trimmed.slice(2).trim();
  if (trimmed.startsWith("/*")) return trimmed.replace(/^\/\*/, "").replace(/\*\/$/, "").trim();
  if (trimmed.startsWith("*")) return trimmed.replace(/^\*/, "").replace(/\*\/$/, "").trim();
  return null;
}

function hasSuspiciousPrefix(text) {
  return text.startsWith("...")
    || text.startsWith("…")
    || CORRUPTION_MARKER_RE.test(text.slice(0, 80));
}

function looksLikeCode(text) {
  return CODEISH_PATTERNS.some((pattern) => pattern.test(text));
}

function scanFile(file) {
  const fileRel = rel(file);
  const lines = fs.readFileSync(file, "utf-8").split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    const text = commentText(line);
    if (!text || INTENTIONAL_COMMENT_RE.test(text)) return;
    if (!hasSuspiciousPrefix(text) || !looksLikeCode(text)) return;
    hits.push({
      file: fileRel,
      line: index + 1,
      severity: isTestFile(fileRel) ? "warning" : "blocker",
      source: line.trim().slice(0, 240),
    });
  });
  return hits;
}

const files = SCAN_ROOTS.flatMap((item) => walk(path.join(ROOT, item)));
const hits = files.flatMap(scanFile);
const blockers = hits.filter((item) => item.severity === "blocker");
const warnings = hits.filter((item) => item.severity === "warning");
const report = {
  ok: blockers.length === 0,
  generatedAt: new Date().toISOString(),
  scope: SCAN_ROOTS,
  scannedFiles: files.length,
  riskPatterns: RISK_PATTERNS,
  counts: {
    blockers: blockers.length,
    warnings: warnings.length,
  },
  blockers,
  warnings,
};

if (reportPath) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (markdownPath) {
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, renderMarkdown(report), "utf-8");
}

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[comment-code-audit] scanned ${files.length} files; blockers=${blockers.length}; warnings=${warnings.length}`);
}

process.exit(report.ok ? 0 : 1);

function renderMarkdown(data) {
  const lines = [
    "# Comment-Code Audit",
    "",
    `Generated: ${data.generatedAt}`,
    `Scanned files: ${data.scannedFiles}`,
    `Blockers: ${data.counts.blockers}`,
    `Warnings: ${data.counts.warnings}`,
    "",
  ];
  for (const item of [...data.blockers, ...data.warnings]) {
    lines.push(`- ${item.severity.toUpperCase()} ${item.file}:${item.line} ${item.source}`);
  }
  return `${lines.join("\n")}\n`;
}
