#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/react-button-type-audit.mjs [options]\n\nOptions:\n  --report=<path>       JSON report path\n  --markdown=<path>     Markdown report path\n  --json                Print the JSON report to stdout\n`);
  process.exit(0);
}

const ROOT = process.cwd();
const reportPath = valueArg("--report");
const markdownPath = valueArg("--markdown");
const jsonOnly = args.includes("--json");
const SOURCE_ROOTS = ["desktop/src/react"];
const EXTENSIONS = new Set([".tsx", ".jsx"]);

const files = SOURCE_ROOTS.flatMap((root) => collectFiles(path.join(ROOT, root)))
  .sort((a, b) => a.localeCompare(b));

const blockers = [];
let buttonCount = 0;

for (const file of files) {
  const source = fs.readFileSync(file, "utf-8");
  for (const tag of findButtonTags(source)) {
    buttonCount += 1;
    if (!/\btype\s*=/.test(tag.text)) {
      blockers.push({
        file: slash(path.relative(ROOT, file)),
        line: lineNumber(source, tag.start),
        kind: "missing-button-type",
        message: "React <button> must declare type explicitly to avoid accidental form submission.",
        snippet: firstLine(tag.text),
      });
    }
  }
}

const report = {
  ok: blockers.length === 0,
  generatedAt: new Date().toISOString(),
  scope: SOURCE_ROOTS,
  scannedFiles: files.length,
  counts: {
    buttons: buttonCount,
    blockers: blockers.length,
  },
  blockers,
};

writeJson(reportPath, report);
writeMarkdown(markdownPath, report);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[react-button-type-audit] files=${report.scannedFiles} buttons=${buttonCount} blockers=${blockers.length}`);
  for (const blocker of blockers.slice(0, 20)) {
    console.error(`[react-button-type-audit] ${blocker.file}:${blocker.line} ${blocker.message}`);
  }
  if (blockers.length > 20) console.error(`[react-button-type-audit] ... ${blockers.length - 20} more`);
  if (reportPath) console.log(`[react-button-type-audit] report: ${path.resolve(reportPath)}`);
  if (markdownPath) console.log(`[react-button-type-audit] markdown: ${path.resolve(markdownPath)}`);
}

process.exit(report.ok ? 0 : 1);

function collectFiles(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    const rel = slash(path.relative(ROOT, fullPath));
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      output.push(...collectFiles(fullPath));
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    if (/\.test\.[tj]sx$/i.test(entry.name)) continue;
    if (/\.spec\.[tj]sx$/i.test(entry.name)) continue;
    if (rel.includes("/fixtures/")) continue;
    output.push(fullPath);
  }
  return output;
}

function findButtonTags(source) {
  const tags = [];
  let index = 0;
  while ((index = source.indexOf("<button", index)) !== -1) {
    const start = index;
    index += "<button".length;
    if (/[A-Za-z0-9_$:-]/.test(source[index] || "")) continue;
    const end = findTagEnd(source, index);
    if (end === -1) break;
    tags.push({ start, text: source.slice(start, end + 1) });
    index = end + 1;
  }
  return tags;
}

function findTagEnd(source, start) {
  let quote = null;
  let braceDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }
    if (char === ">" && braceDepth === 0) return index;
  }
  return -1;
}

function lineNumber(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function firstLine(value) {
  return value.trim().split(/\r?\n/)[0].slice(0, 160);
}

function writeJson(target, data) {
  if (!target) return;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function writeMarkdown(target, data) {
  if (!target) return;
  const lines = [
    "# React Button Type Audit",
    "",
    `Generated: ${data.generatedAt}`,
    `Scanned files: ${data.scannedFiles}`,
    `Buttons: ${data.counts.buttons}`,
    `Blockers: ${data.counts.blockers}`,
    "",
  ];
  if (data.blockers.length) {
    lines.push("## Blockers", "");
    for (const item of data.blockers) {
      lines.push(`- ${item.file}:${item.line} - ${item.message}`);
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function slash(value) {
  return value.replace(/\\/g, "/");
}

function valueArg(name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}
