#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/react-action-button-audit.mjs [options]

Audits icon/action button guardrails: fixed size, accessible name, disabled state, and focus-visible styling.

Options:
  --report=<path>       JSON report path
  --markdown=<path>     Markdown report path
  --json                Print the JSON report to stdout
`);
  process.exit(0);
}

const ROOT = process.cwd();
const reportPath = valueArg("--report");
const markdownPath = valueArg("--markdown");
const jsonOnly = args.includes("--json");
const SOURCE_ROOTS = ["desktop/src/react"];
const CSS_ROOTS = ["desktop/src"];
const EXTENSIONS = new Set([".tsx", ".jsx"]);
const CSS_EXTENSIONS = new Set([".css"]);
const REQUIREMENTS = [
  "fixed-size",
  "accessible-name",
  "disabled-state",
  "focus-visible",
];

const GUARDED_CLASS_NAMES = new Set([
  "actionBtn",
  "channelHeaderActionBtn",
  "exp-block-action",
  "fileAction",
  "fileOutputActionButton",
  "floatingPanelActionBtn",
  "iconBtn",
  "iconButton",
  "msgActionBtn",
  "pin-item-action",
  "prompt-queue-icon-btn",
  "provider-item-action",
  "pv-cred-conn-icon",
  "settings-icon-btn",
  "sidebar-action-btn",
  "skill-bundle-icon-button",
  "userActionBtn",
]);

const sourceFiles = SOURCE_ROOTS.flatMap((root) => collectFiles(path.join(ROOT, root), EXTENSIONS))
  .sort((a, b) => a.localeCompare(b));
const cssFiles = CSS_ROOTS.flatMap((root) => collectFiles(path.join(ROOT, root), CSS_EXTENSIONS))
  .sort((a, b) => a.localeCompare(b));

const cssIndex = new Map();
for (const file of cssFiles) {
  const source = fs.readFileSync(file, "utf-8");
  for (const rule of parseCssRules(source)) {
    for (const className of extractSelectorClasses(rule.selector)) {
      const item = cssIndex.get(className) || { base: [], disabled: [], focus: [] };
      if (rule.selector.includes(":disabled")) item.disabled.push({ file, rule });
      else if (rule.selector.includes(":focus-visible")) item.focus.push({ file, rule });
      else item.base.push({ file, rule });
      cssIndex.set(className, item);
    }
  }
}

const guarded = new Map();
const blockers = [];

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf-8");
  for (const tag of findButtonTags(source)) {
    const classes = extractClassNames(tag.text).filter(isGuardedClass);
    if (!classes.length) continue;
    const hasAccessibleName = hasButtonAccessibleName(tag.text);
    for (const className of classes) {
      const entry = guarded.get(className) || {
        className,
        usages: [],
        css: cssIndex.get(className) || { base: [], disabled: [], focus: [] },
      };
      entry.usages.push({
        file: slash(path.relative(ROOT, file)),
        line: lineNumber(source, tag.start),
        snippet: firstLine(tag.text),
      });
      guarded.set(className, entry);
      if (!hasAccessibleName) {
        blockers.push({
          kind: "missing-accessible-name",
          className,
          file: slash(path.relative(ROOT, file)),
          line: lineNumber(source, tag.start),
          message: "Icon/action buttons must expose title, aria-label, or visible text.",
        });
      }
    }
  }
}

for (const entry of guarded.values()) {
  const base = entry.css.base.map((item) => item.rule.body).join("\n");
  const disabled = entry.css.disabled.map((item) => item.rule.body).join("\n");
  const focus = entry.css.focus.map((item) => item.rule.body).join("\n");
  const firstUsage = entry.usages[0] || { file: "", line: 0 };

  if (!hasFixedSize(base)) {
    blockers.push({
      kind: "missing-fixed-size",
      className: entry.className,
      file: firstUsage.file,
      line: firstUsage.line,
      message: "Icon/action button classes need stable width and height or logical equivalents.",
    });
  }
  if (!hasDisabledState(disabled)) {
    blockers.push({
      kind: "missing-disabled-state",
      className: entry.className,
      file: firstUsage.file,
      line: firstUsage.line,
      message: "Icon/action button classes need a disabled state with contrast/cursor handling.",
    });
  }
  if (!hasFocusVisible(focus)) {
    blockers.push({
      kind: "missing-focus-visible",
      className: entry.className,
      file: firstUsage.file,
      line: firstUsage.line,
      message: "Icon/action button classes need visible :focus-visible styling.",
    });
  }
}

const report = {
  ok: blockers.length === 0,
  generatedAt: new Date().toISOString(),
  scope: SOURCE_ROOTS,
  requirements: REQUIREMENTS,
  scannedFiles: sourceFiles.length,
  counts: {
    guardedClasses: guarded.size,
    usages: Array.from(guarded.values()).reduce((sum, entry) => sum + entry.usages.length, 0),
    blockers: blockers.length,
  },
  blockers,
};

writeJson(reportPath, report);
writeMarkdown(markdownPath, report);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[react-action-button-audit] files=${report.scannedFiles} guardedClasses=${guarded.size} blockers=${blockers.length}`);
  for (const blocker of blockers.slice(0, 30)) {
    console.error(`[react-action-button-audit] ${blocker.file}:${blocker.line} ${blocker.className} ${blocker.message}`);
  }
  if (blockers.length > 30) console.error(`[react-action-button-audit] ... ${blockers.length - 30} more`);
  if (reportPath) console.log(`[react-action-button-audit] report: ${path.resolve(reportPath)}`);
  if (markdownPath) console.log(`[react-action-button-audit] markdown: ${path.resolve(markdownPath)}`);
}

process.exit(report.ok ? 0 : 1);

function collectFiles(root, extensions) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    const rel = slash(path.relative(ROOT, fullPath));
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      output.push(...collectFiles(fullPath, extensions));
      continue;
    }
    if (!extensions.has(path.extname(entry.name))) continue;
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

function extractClassNames(tag) {
  const values = [];
  for (const match of tag.matchAll(/className\s*=\s*"([^"]+)"/g)) values.push(...splitClasses(match[1]));
  for (const match of tag.matchAll(/className\s*=\s*'([^']+)'/g)) values.push(...splitClasses(match[1]));
  for (const match of tag.matchAll(/\b(?:styles|s|classes)\[['"]([^'"]+)['"]\]/g)) values.push(match[1]);
  for (const match of tag.matchAll(/\b(?:styles|s|classes)\.([A-Za-z0-9_-]+)/g)) values.push(match[1]);
  return [...new Set(values)];
}

function splitClasses(value) {
  return value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
}

function isGuardedClass(className) {
  return GUARDED_CLASS_NAMES.has(className);
}

function hasButtonAccessibleName(tag) {
  if (/\b(?:aria-label|title)\s*=/.test(tag)) return true;
  if (/\bt\s*\(\s*['"`][^'"`]+['"`]/.test(tag)) return true;
  const innerText = tag
    .replace(/<[^>]+>/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .trim();
  return /[\p{L}\p{N}]{2,}/u.test(innerText);
}

function parseCssRules(source) {
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    rules.push({ selector: match[1].trim(), body: match[2].trim() });
  }
  return rules;
}

function extractSelectorClasses(selector) {
  const classes = [];
  for (const match of selector.matchAll(/\.([A-Za-z0-9_-]+)/g)) classes.push(match[1]);
  return classes.filter(isGuardedClass);
}

function hasFixedSize(body) {
  const hasWidth = /(?:^|[;\s])(?:width|min-width|inline-size|min-inline-size)\s*:/i.test(body);
  const hasHeight = /(?:^|[;\s])(?:height|min-height|block-size|min-block-size)\s*:/i.test(body);
  return hasWidth && hasHeight;
}

function hasDisabledState(body) {
  return /(?:opacity|color|background|cursor|filter)\s*:/i.test(body);
}

function hasFocusVisible(body) {
  return /(?:outline|box-shadow|border-color|background|color)\s*:/i.test(body);
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
    "# React Action Button Audit",
    "",
    `Generated: ${data.generatedAt}`,
    `Scanned files: ${data.scannedFiles}`,
    `Guarded classes: ${data.counts.guardedClasses}`,
    `Button usages: ${data.counts.usages}`,
    `Blockers: ${data.counts.blockers}`,
    "",
  ];
  if (data.blockers.length) {
    lines.push("## Blockers", "");
    for (const item of data.blockers) {
      lines.push(`- ${item.file}:${item.line} ${item.className} - ${item.message}`);
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
