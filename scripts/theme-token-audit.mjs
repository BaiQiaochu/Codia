#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const reportPath = valueArg("--report");
const markdownPath = valueArg("--markdown");
const jsonOnly = args.includes("--json");

const ROOT = process.cwd();
const SCAN_TARGETS = [
  "desktop/src/styles.css",
  "desktop/src/react/settings",
  "desktop/src/react/components",
];
const EXTENSIONS = new Set([".css", ".ts", ".tsx"]);
const MAX_ITEMS = 500;

const STYLE_PROP_RE = /(?:\bcolor\b|background(?:Color)?|border(?:Color)?|boxShadow|box-shadow|outline|fill|stroke)\s*[:=]/i;
const RAW_HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const FIXED_RGB_RE = /rgba?\(\s*(?!var\()/ig;
const RISK_CONTEXT_RE = /(status|badge|diagnostic|bridge|health|success|warning|danger|error|fail|ok)/i;

const files = [];
for (const target of SCAN_TARGETS) {
  const fullPath = path.join(ROOT, target);
  if (fs.existsSync(fullPath)) collectFiles(fullPath);
}

const warnings = [];
const blockers = [];
const ignored = [];

for (const filePath of files) {
  const rel = slash(path.relative(ROOT, filePath));
  const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
  let selector = "";

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.endsWith("{") || /^\.[\w-]/.test(trimmed)) {
      selector = trimmed.replace(/\{$/, "").trim();
    }
    if (!STYLE_PROP_RE.test(line)) return;

    const rawSegment = stripThemeSafeColorSyntax(line);
    const hasRawHex = RAW_HEX_RE.test(rawSegment);
    RAW_HEX_RE.lastIndex = 0;
    const hasFixedRgb = FIXED_RGB_RE.test(rawSegment);
    FIXED_RGB_RE.lastIndex = 0;
    if (!hasRawHex && !hasFixedRgb) return;

    const ignoredReason = getIntentionalColorReason(rel, selector, trimmed);
    const item = {
      file: rel,
      line: index + 1,
      selector: selector || null,
      text: trimmed,
      kind: hasFixedRgb ? "fixed-rgb" : "raw-hex",
      severity: ignoredReason ? "ignored" : (isBlockingContext(rel, selector, trimmed) ? "error" : "warn"),
      ...(ignoredReason && { reason: ignoredReason }),
    };
    if (item.severity === "ignored") ignored.push(item);
    else if (item.severity === "error") blockers.push(item);
    else warnings.push(item);
  });
}

const report = {
  ok: blockers.length === 0,
  scannedAt: new Date().toISOString(),
  scannedFiles: files.length,
  blockers: blockers.slice(0, MAX_ITEMS),
  warnings: warnings.slice(0, MAX_ITEMS),
  ignored: ignored.slice(0, MAX_ITEMS),
  counts: {
    blockers: blockers.length,
    warnings: warnings.length,
    ignored: ignored.length,
  },
  policy: {
    blocking: "Raw colors in status, badge, diagnostic, bridge, or health UI must use theme tokens.",
    warning: "Other raw colors are reported for follow-up, but may be legitimate theme previews, overlays, or shadows.",
    ignored: "Known intentional fixed colors are tracked separately so the warning list stays actionable.",
  },
};

writeJson(reportPath, report);
writeMarkdown(markdownPath, report);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[theme-token-audit] scanned ${files.length} files`);
  console.log(`[theme-token-audit] blockers=${blockers.length} warnings=${warnings.length} ignored=${ignored.length}`);
  if (blockers.length) {
    for (const item of blockers.slice(0, 20)) {
      console.error(`${item.file}:${item.line}: ${item.text}`);
    }
  }
  if (reportPath) console.log(`[theme-token-audit] report: ${path.resolve(reportPath)}`);
  if (markdownPath) console.log(`[theme-token-audit] markdown: ${path.resolve(markdownPath)}`);
}

process.exit(report.ok ? 0 : 1);

function collectFiles(current) {
  const stat = fs.statSync(current);
  if (stat.isFile()) {
    if (EXTENSIONS.has(path.extname(current))) files.push(current);
    return;
  }
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist-renderer") continue;
    collectFiles(path.join(current, entry.name));
  }
}

function stripThemeSafeColorSyntax(line) {
  let text = String(line);
  text = text.replace(/url\([^)]*\)/g, "");
  text = text.replace(/rgba?\(\s*var\([^)]*\)\s*(?:,\s*[\d.]+%?)?\s*\)/ig, "");
  text = text.replace(/color-mix\([^;{}]*var\([^)]*\)[^;{}]*\)/ig, "");
  text = text.replace(/var\([^)]*\)/g, "");
  return text;
}

function isBlockingContext(file, selector, line) {
  const context = `${file} ${selector || ""} ${line}`;
  if (!RISK_CONTEXT_RE.test(context)) return false;
  if (/theme-(preview|swatch)|screenshot-themes|overlay|shadow/i.test(context)) return false;
  return true;
}

function getIntentionalColorReason(file, selector, line) {
  const context = `${file} ${selector || ""} ${line}`;
  if (/desktop\/src\/react\/settings\/Settings\.module\.css/i.test(file)
    && /\.theme-card(?:\[data-theme=| |$|:)/i.test(context)) {
    return "theme-card-preview-palette";
  }
  if (/desktop\/src\/react\/settings\/tabs\/SharingTab\.tsx/i.test(file)
    && /\{\s*key:\s*['"](light|dark|sakura)['"]/i.test(line)) {
    return "share-theme-preview-palette";
  }
  if (/desktop\/src\/react\/components\/shared\/MediaViewer\/MediaViewer\.module\.css/i.test(file)) {
    return "fixed-media-viewer-chrome";
  }
  return null;
}

function writeJson(target, data) {
  if (!target) return;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function writeMarkdown(target, reportData) {
  if (!target) return;
  const lines = [
    "# Theme Token Audit",
    "",
    `- Scanned files: ${reportData.scannedFiles}`,
    `- Blockers: ${reportData.counts.blockers}`,
    `- Warnings: ${reportData.counts.warnings}`,
    "",
    "## Blocking Findings",
    "",
  ];
  if (!reportData.blockers.length) {
    lines.push("None.", "");
  } else {
    lines.push("| File | Line | Selector | Finding |", "| --- | ---: | --- | --- |");
    for (const item of reportData.blockers) {
      lines.push(`| ${item.file} | ${item.line} | ${escapeCell(item.selector || "")} | ${escapeCell(item.text)} |`);
    }
    lines.push("");
  }
  lines.push("## Warning Sample", "");
  if (!reportData.warnings.length) {
    lines.push("None.", "");
  } else {
    lines.push("| File | Line | Selector | Finding |", "| --- | ---: | --- | --- |");
    for (const item of reportData.warnings.slice(0, 80)) {
      lines.push(`| ${item.file} | ${item.line} | ${escapeCell(item.selector || "")} | ${escapeCell(item.text)} |`);
    }
    lines.push("");
  }
  lines.push("## Ignored Intentional Colors", "");
  if (!reportData.ignored.length) {
    lines.push("None.", "");
  } else {
    lines.push("| File | Line | Reason | Selector | Finding |", "| --- | ---: | --- | --- | --- |");
    for (const item of reportData.ignored.slice(0, 80)) {
      lines.push(`| ${item.file} | ${item.line} | ${escapeCell(item.reason || "")} | ${escapeCell(item.selector || "")} | ${escapeCell(item.text)} |`);
    }
    lines.push("");
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function valueArg(name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}
