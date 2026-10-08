#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const reportPath = valueArg("--report");
const markdownPath = valueArg("--markdown");
const jsonOnly = args.includes("--json");

const ROOT = process.cwd();
const THEME_DIR = path.join(ROOT, "desktop/src/themes");

const REQUIRED_THEME_TOKENS = [
  "--bg",
  "--bg-main",
  "--bg-card",
  "--bg-card-alt",
  "--bg-input",
  "--text",
  "--text-light",
  "--text-muted",
  "--text-link",
  "--text-error",
  "--accent",
  "--accent-bg",
  "--accent-hover",
  "--accent-light",
  "--accent-rgb",
  "--border",
  "--border-light",
  "--shadow",
  "--green",
  "--green-rgb",
  "--success",
  "--coral",
  "--danger",
  "--danger-rgb",
  "--error",
  "--overlay-subtle",
  "--overlay-light",
  "--overlay-medium",
  "--overlay-strong",
  "--sidebar-bg",
  "--bg-secondary",
  "--bg-tertiary",
  "--border-muted",
  "--surface-raised",
  "--focus-ring",
  "--control-bg",
  "--control-bg-hover",
  "--control-bg-active",
  "--control-border",
  "--control-text",
  "--control-muted",
  "--primary-button-bg",
  "--primary-button-hover",
  "--primary-button-text",
  "--danger-button-bg",
  "--danger-button-hover",
  "--danger-button-text",
];

const REQUIRED_ALIAS_TOKENS = [
  "--text-primary",
  "--text-secondary",
  "--text-tertiary",
  "--bg-main",
  "--bg-card-alt",
  "--bg-input",
  "--bg-secondary",
  "--bg-tertiary",
  "--bg-hover",
  "--border-muted",
  "--border-light",
  "--surface-raised",
  "--accent-bg",
  "--text-link",
  "--text-error",
  "--error",
  "--success",
  "--warning",
  "--warning-color",
];

const VISUAL_SURFACES = [
  "desktop/src/styles.css",
  "desktop/src/react/settings/Settings.module.css",
  "desktop/src/react/settings/tabs/BridgeTab.module.css",
  "desktop/src/react/settings/tabs/MediaTab.tsx",
  "desktop/src/react/components/plugin/PluginPageView.module.css",
];

const CONTRAST_CHECKS = [
  { token: "--text", background: "--bg", min: 4.5, severity: "error" },
  { token: "--text", background: "--bg-card", min: 4.5, severity: "error" },
  { token: "--text-light", background: "--bg", min: 3.0, severity: "warn" },
  { token: "--text-light", background: "--bg-card", min: 3.0, severity: "warn" },
  { token: "--text-muted", background: "--bg", min: 2.5, severity: "warn" },
  { token: "--text-muted", background: "--bg-card", min: 2.5, severity: "warn" },
  { token: "--accent", background: "--bg-card", min: 3.0, severity: "warn" },
  { token: "--danger", background: "--bg-card", min: 3.0, severity: "warn" },
  { token: "--green", background: "--bg-card", min: 3.0, severity: "warn" },
  { token: "--focus-ring", background: "--bg", min: 3.0, severity: "warn" },
  { token: "--control-text", background: "--control-bg", min: 4.5, severity: "error" },
  { token: "--control-muted", background: "--control-bg", min: 3.0, severity: "warn" },
  { token: "--primary-button-text", background: "--primary-button-bg", min: 4.5, severity: "error" },
  { token: "--danger-button-text", background: "--danger-button-bg", min: 4.5, severity: "error" },
];

const blockers = [];
const warnings = [];
const themes = [];

const surfaceChecks = VISUAL_SURFACES.map((relativePath) => {
  const ok = fs.existsSync(path.join(ROOT, relativePath));
  if (!ok) blockers.push({ kind: "surface-missing", file: relativePath, message: "visual audit target is missing" });
  return { path: relativePath, ok };
});

const rootStylePath = path.join(ROOT, "desktop/src/styles.css");
const rootTokens = fs.existsSync(rootStylePath) ? parseCustomProperties(fs.readFileSync(rootStylePath, "utf-8")) : new Map();
for (const token of REQUIRED_ALIAS_TOKENS) {
  if (!rootTokens.has(token)) {
    blockers.push({ kind: "alias-missing", file: "desktop/src/styles.css", token, message: `${token} alias is missing` });
  }
}

if (fs.existsSync(THEME_DIR)) {
  for (const entry of fs.readdirSync(THEME_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".css") || entry.name.includes("fonts")) continue;
    const filePath = path.join(THEME_DIR, entry.name);
    const relativePath = slash(path.relative(ROOT, filePath));
    const text = fs.readFileSync(filePath, "utf-8");
    const themeName = themeNameFromCss(text) || entry.name.replace(/\.css$/, "");
    const tokens = parseCustomProperties(text);
    const missingTokens = REQUIRED_THEME_TOKENS.filter((token) => !tokens.has(token));
    for (const token of missingTokens) {
      blockers.push({ kind: "token-missing", file: relativePath, theme: themeName, token, message: `${token} is missing` });
    }

    const contrast = [];
    for (const check of CONTRAST_CHECKS) {
      const fg = parseColor(tokens.get(check.token));
      const bg = parseColor(tokens.get(check.background));
      if (!fg || !bg) continue;
      const ratio = contrastRatio(fg, bg);
      const item = {
        kind: "contrast",
        file: relativePath,
        theme: themeName,
        token: check.token,
        background: check.background,
        ratio: Number(ratio.toFixed(2)),
        minimum: check.min,
        severity: check.severity,
      };
      contrast.push(item);
      if (ratio < check.min) {
        if (check.severity === "error") blockers.push(item);
        else warnings.push(item);
      }
    }

    themes.push({ file: relativePath, name: themeName, missingTokens, contrast });
  }
} else {
  blockers.push({ kind: "theme-dir-missing", file: "desktop/src/themes", message: "theme directory is missing" });
}

const report = {
  ok: blockers.length === 0,
  generatedAt: new Date().toISOString(),
  scannedThemes: themes.length,
  surfaces: surfaceChecks,
  requiredThemeTokens: REQUIRED_THEME_TOKENS,
  requiredAliasTokens: REQUIRED_ALIAS_TOKENS,
  counts: {
    blockers: blockers.length,
    warnings: warnings.length,
  },
  blockers,
  warnings,
  themes,
};

writeJson(reportPath, report);
writeMarkdown(markdownPath, report);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[theme-visual-audit] themes=${themes.length} blockers=${blockers.length} warnings=${warnings.length}`);
  for (const item of blockers.slice(0, 20)) console.error(formatFinding(item));
  if (reportPath) console.log(`[theme-visual-audit] report: ${path.resolve(reportPath)}`);
  if (markdownPath) console.log(`[theme-visual-audit] markdown: ${path.resolve(markdownPath)}`);
}

process.exit(report.ok ? 0 : 1);

function parseCustomProperties(text) {
  const map = new Map();
  for (const match of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(match[1], match[2].trim());
  }
  return map;
}

function themeNameFromCss(text) {
  const match = /\[data-theme=["']([^"']+)["']\]/.exec(text);
  return match?.[1] || null;
}

function parseColor(value) {
  const raw = String(value || "").trim();
  const hex = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/.exec(raw);
  if (hex) {
    let valueHex = hex[1];
    if (valueHex.length === 3) valueHex = valueHex.split("").map((ch) => ch + ch).join("");
    return [0, 2, 4].map((index) => Number.parseInt(valueHex.slice(index, index + 2), 16));
  }

  const rgb = /rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i.exec(raw);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function writeJson(target, data) {
  if (!target) return;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function writeMarkdown(target, data) {
  if (!target) return;
  const lines = [
    "# Theme Visual Audit",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    `- Themes: ${data.scannedThemes}`,
    `- Blockers: ${data.counts.blockers}`,
    `- Warnings: ${data.counts.warnings}`,
    "",
    "## Surfaces",
    "",
    "| Surface | Status |",
    "| --- | --- |",
  ];
  for (const item of data.surfaces) lines.push(`| ${item.path} | ${item.ok ? "OK" : "Missing"} |`);

  lines.push("", "## Blockers", "");
  if (!data.blockers.length) {
    lines.push("None.", "");
  } else {
    lines.push("| File | Theme | Finding |", "| --- | --- | --- |");
    for (const item of data.blockers) lines.push(`| ${item.file || ""} | ${item.theme || ""} | ${escapeCell(formatFinding(item))} |`);
    lines.push("");
  }

  lines.push("## Warning Sample", "");
  if (!data.warnings.length) {
    lines.push("None.", "");
  } else {
    lines.push("| File | Theme | Finding |", "| --- | --- | --- |");
    for (const item of data.warnings.slice(0, 80)) lines.push(`| ${item.file || ""} | ${item.theme || ""} | ${escapeCell(formatFinding(item))} |`);
    lines.push("");
  }

  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function formatFinding(item) {
  if (item.kind === "contrast") {
    return `${item.token} on ${item.background} contrast ${item.ratio} < ${item.minimum}`;
  }
  return item.message || `${item.kind}: ${item.token || item.file || "unknown"}`;
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
