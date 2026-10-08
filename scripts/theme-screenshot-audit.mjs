#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const themeRegistry = require("../desktop/src/shared/theme-registry.cjs");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/theme-screenshot-audit.mjs [options]\n\nOptions:\n  --report=<path>       JSON report path, default artifacts/theme-screenshot-audit.json\n  --markdown=<path>     Markdown report path, default artifacts/theme-screenshot-audit.md\n  --screenshots=<dir>   Screenshot output directory, default artifacts/theme-screenshots\n  --json                Print the JSON report to stdout\n`);
  process.exit(0);
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const reportPath = resolveOutput(valueArg("--report") || "artifacts/theme-screenshot-audit.json");
const markdownPath = resolveOutput(valueArg("--markdown") || "artifacts/theme-screenshot-audit.md");
const screenshotsDir = resolveOutput(valueArg("--screenshots") || "artifacts/theme-screenshots");
const jsonOnly = args.includes("--json");

const VIEWPORTS = [
  { id: "desktop", width: 1366, height: 900 },
  { id: "mobile", width: 390, height: 844 },
];

const THEME_IDS = Object.keys(themeRegistry.THEMES);
const STYLE_HREF = pathToFileURL(path.join(ROOT, "desktop/src/styles.css")).href;
const fixturePath = path.join(ROOT, "artifacts/theme-screenshot-fixture.html");

const report = {
  ok: false,
  generatedAt: new Date().toISOString(),
  screenshotsDir: slash(path.relative(ROOT, screenshotsDir)),
  themes: THEME_IDS,
  viewports: VIEWPORTS,
  counts: {
    screenshots: 0,
    blockers: 0,
    warnings: 0,
  },
  setup: {
    package: "playwright",
    browser: "chromium",
    installCommand: "npx playwright install chromium",
  },
  browserRuntime: null,
  blockers: [],
  warnings: [],
  results: [],
};

let browser;
try {
  const { chromium } = await import("playwright");
  browser = await launchChromium(chromium);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report.blockers.push({
    kind: "playwright-runtime",
    message: runtimeMessage(message),
    detail: message,
    fix: report.setup.installCommand,
  });
  finish(1);
}

async function launchChromium(chromium) {
  const baseOptions = {
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  };
  const failures = [];
  try {
    const browser = await chromium.launch(baseOptions);
    report.browserRuntime = "bundled-chromium";
    return browser;
  } catch (error) {
    failures.push(formatRuntimeFailure("bundled-chromium", error));
    if (!isMissingBrowserLaunchFailure(error)) throw error;
  }
  const fallbackChannels = uniqueStrings([
    process.env.PLAYWRIGHT_CHROMIUM_CHANNEL,
    "msedge",
    "chrome",
    "chromium",
  ].filter(Boolean));
  for (const channel of fallbackChannels) {
    try {
      const browser = await chromium.launch({ ...baseOptions, channel });
      report.browserRuntime = `channel:${channel}`;
      return browser;
    } catch (error) {
      failures.push(formatRuntimeFailure(`channel:${channel}`, error));
      if (!isMissingBrowserLaunchFailure(error)) throw error;
    }
  }
  throw new Error([
    "Playwright could not start a Chromium runtime.",
    "Tried bundled Chromium and installed browser channels.",
    ...failures.map((failure) => `- ${failure}`),
  ].join("\n"));
}

try {
  fs.rmSync(screenshotsDir, { recursive: true, force: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const context = await browser.newContext({ deviceScaleFactor: 1 });

  for (const themeId of THEME_IDS) {
    for (const viewport of VIEWPORTS) {
      const result = await auditCombination(context, themeId, viewport);
      report.results.push(result);
      report.blockers.push(...result.blockers);
      report.warnings.push(...result.warnings);
      if (result.screenshot) report.counts.screenshots += 1;
    }
  }

  await context.close();
} finally {
  await browser?.close().catch(() => {});
}

finish(report.blockers.length === 0 ? 0 : 1);

async function auditCombination(context, themeId, viewport) {
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const result = {
    theme: themeId,
    viewport: viewport.id,
    size: { width: viewport.width, height: viewport.height },
    screenshot: null,
    pixelStats: null,
    blockers: [],
    warnings: [],
  };

  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    writeFixture(themeId);
    await page.goto(pathToFileURL(fixturePath).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(120);

    const domReport = await page.evaluate(runDomAudit);
    for (const item of domReport.blockers) result.blockers.push({ theme: themeId, viewport: viewport.id, ...item });
    for (const item of domReport.warnings) result.warnings.push({ theme: themeId, viewport: viewport.id, ...item });

    const screenshotPath = path.join(screenshotsDir, `${safeFile(themeId)}-${viewport.id}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
    const pixelStats = analyzePng(screenshotPath);
    result.screenshot = slash(path.relative(ROOT, screenshotPath));
    result.pixelStats = pixelStats;
    if (pixelStats.uniqueColors < 24 || pixelStats.colorSpread < 12) {
      result.blockers.push({
        theme: themeId,
        viewport: viewport.id,
        kind: "blank-or-flat-screenshot",
        message: `screenshot has too little visual variance: colors=${pixelStats.uniqueColors}, spread=${pixelStats.colorSpread}`,
      });
    }
  } catch (error) {
    result.blockers.push({
      theme: themeId,
      viewport: viewport.id,
      kind: "render-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const message of consoleErrors.slice(0, 5)) {
      result.warnings.push({ theme: themeId, viewport: viewport.id, kind: "console-error", message });
    }
    for (const message of pageErrors.slice(0, 5)) {
      result.blockers.push({ theme: themeId, viewport: viewport.id, kind: "page-error", message });
    }
    await page.close().catch(() => {});
  }
  return result;
}

function writeFixture(themeId) {
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, buildFixtureHtml(themeId), "utf-8");
}

function buildFixtureHtml(themeId) {
  const theme = themeRegistry.THEMES[themeId];
  const themeHref = pathToFileURL(path.join(ROOT, "desktop/src", theme.cssPath)).href;
  return `<!doctype html>
<html lang="en" data-theme="${escapeAttr(themeId)}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${STYLE_HREF}" />
  <link rel="stylesheet" href="${themeHref}" />
  <style>${fixtureCss()}</style>
</head>
<body class="no-paper-texture">
  <div class="audit-shell">
    <nav class="audit-nav" data-layout-box="settings-nav" data-audit-key="settings-nav">
      <div class="audit-brand" data-contrast="strong" data-no-overflow>G-SAP</div>
      <button class="audit-nav-item active" data-contrast="badge" data-no-overflow>Settings</button>
      <button class="audit-nav-item" data-contrast="muted" data-no-overflow>Connectors</button>
      <button class="audit-nav-item" data-contrast="muted" data-no-overflow>Plugins</button>
      <button class="audit-nav-item" data-contrast="muted" data-no-overflow>Media</button>
    </nav>

    <main class="audit-main">
      <header class="audit-header">
        <div>
          <p class="audit-kicker" data-contrast="muted">Theme screenshot regression</p>
          <h1 data-contrast="strong">${escapeHtml(themeId)}</h1>
        </div>
        <span class="audit-badge success" data-contrast="badge" data-no-overflow>Theme ready</span>
      </header>

      <section class="audit-grid">
        <article class="audit-panel" data-layout-box="settings-core" data-audit-key="settings-core">
          <div class="audit-panel-head">
            <div>
              <h2 data-contrast="strong">Core settings</h2>
              <p data-contrast="muted">Provider, context, and workspace controls share the active theme tokens.</p>
            </div>
            <span class="audit-badge neutral" data-contrast="badge" data-no-overflow>Saved</span>
          </div>
          <label class="audit-field">
            <span data-contrast="strong">Model context length</span>
            <input value="200000" aria-label="Model context length" />
          </label>
          <label class="audit-field">
            <span data-contrast="strong">Workspace root</span>
            <input value="E:\\GSAPmaim\\workspace" aria-label="Workspace root" />
          </label>
          <div class="audit-actions">
            <button class="audit-button primary" data-contrast="badge" data-no-overflow>Save</button>
            <button class="audit-button" data-contrast="strong" data-no-overflow>Reset</button>
          </div>
        </article>

        ${themeSelectorPanel("settings-theme-selector", "Settings appearance", themeId)}

        ${themeSelectorPanel("onboarding-theme-selector", "Onboarding theme step", themeId)}

        ${themeComparatorPanel("theme-preview-comparator", themeId)}

        <article class="audit-panel" data-layout-box="connector-diagnostics" data-audit-key="connector-diagnostics">
          <div class="audit-panel-head">
            <div>
              <h2 data-contrast="strong">Connector diagnostics</h2>
              <p data-contrast="muted">Adapter, sync, retry, and media capability state stay readable.</p>
            </div>
            <span class="audit-badge warning" data-contrast="badge" data-no-overflow>Retry 1</span>
          </div>
          ${connectorRow("Telegram", "adapter 1.4.0", "Online", "success")}
          ${connectorRow("Feishu", "sync 30s ago", "Syncing", "neutral")}
          ${connectorRow("QQ", "media: file + image", "Ready", "success")}
          ${connectorRow("WeChat", "last error cleared", "Watch", "warning")}
          ${connectorRow("WhatsApp", "session restored", "Ready", "success")}
        </article>

        <article class="audit-panel" data-layout-box="plugin-page" data-audit-key="plugin-page">
          <div class="audit-panel-head">
            <div>
              <h2 data-contrast="strong">Plugin page</h2>
              <p data-contrast="muted">Plugin cards, embedded surfaces, and retry states use the same palette.</p>
            </div>
            <span class="audit-badge danger" data-contrast="badge" data-no-overflow>Needs auth</span>
          </div>
          <div class="audit-plugin-frame">
            <div class="audit-plugin-title" data-contrast="strong">Open workspace helper</div>
            <div class="audit-plugin-copy" data-contrast="muted">The embedded view is framed by theme background, border, and muted text tokens.</div>
          </div>
          <div class="audit-actions">
            <button class="audit-button primary" data-contrast="badge" data-no-overflow>Enable</button>
            <button class="audit-button" data-contrast="strong" data-no-overflow>Retry</button>
          </div>
        </article>

        <article class="audit-panel" data-layout-box="media-video" data-audit-key="media-video">
          <div class="audit-panel-head">
            <div>
              <h2 data-contrast="strong">Video generation</h2>
              <p data-contrast="muted">Default video models, provider parameters, and task status stay readable.</p>
            </div>
            <span class="audit-badge success" data-contrast="badge" data-no-overflow>Model ready</span>
          </div>
          <div class="audit-preset-row">
            <button class="audit-chip" data-contrast="badge" data-no-overflow>Seedance</button>
            <button class="audit-chip" data-contrast="badge" data-no-overflow>16:9</button>
            <button class="audit-chip" data-contrast="badge" data-no-overflow>5s</button>
          </div>
          <label class="audit-field">
            <span data-contrast="strong">Default video model</span>
            <input value="volcengine / Seedance 2.0" aria-label="Default video model" />
          </label>
          <div class="audit-status-list">
            <span class="audit-badge success" data-contrast="badge" data-no-overflow>Provider OK</span>
            <span class="audit-badge neutral" data-contrast="badge" data-no-overflow>Task polling</span>
            <span class="audit-badge warning" data-contrast="badge" data-no-overflow>Async</span>
          </div>
        </article>
      </section>
    </main>
  </div>
</body>
</html>`;
}

function themeSelectorPanel(key, title, activeThemeId) {
  const states = ["active", "hover", "focus"];
  const cards = themeRegistry.getThemeIds().map((themeId, index) => themeChoice(themeId, states[index] || "idle", activeThemeId));
  cards.push(disabledAutoThemeChoice());
  return `<article class="audit-panel audit-theme-panel" data-layout-box="${key}" data-audit-key="${key}">
    <div class="audit-panel-head">
      <div>
        <h2 data-contrast="strong">${escapeHtml(title)}</h2>
        <p data-contrast="muted">Theme buttons cover active, hover, focus, and disabled visual states.</p>
      </div>
      <span class="audit-badge neutral" data-contrast="badge" data-no-overflow>Synced</span>
    </div>
    <div class="audit-theme-grid">
      ${cards.join("")}
    </div>
  </article>`;
}

function themeComparatorPanel(key, activeThemeId) {
  return `<article class="audit-panel audit-comparator-panel" data-layout-box="${key}" data-audit-key="${key}">
    <div class="audit-panel-head">
      <div>
        <h2 data-contrast="strong">Theme preview comparator</h2>
        <p data-contrast="muted">Desktop, PWA, settings, and modal surfaces should read as one product.</p>
      </div>
      <span class="audit-badge neutral" data-contrast="badge" data-no-overflow>${escapeHtml(activeThemeId)}</span>
    </div>
    <div class="audit-comparator-grid">
      ${themeComparatorSurface("Desktop", "Nav, chat, and workspace chrome", "primary")}
      ${themeComparatorSurface("PWA", "Mobile header and message list", "success")}
      ${themeComparatorSurface("Settings", "Forms, selects, and preference rows", "neutral")}
      ${themeComparatorSurface("Modal", "Dialog header, body, and actions", "warning")}
    </div>
  </article>`;
}

function themeComparatorSurface(title, detail, tone) {
  return `<div class="audit-comparator-surface">
    <div class="audit-comparator-topline">
      <strong data-contrast="strong" data-no-overflow>${escapeHtml(title)}</strong>
      <span class="audit-badge ${tone}" data-contrast="badge" data-no-overflow>live</span>
    </div>
    <p data-contrast="muted">${escapeHtml(detail)}</p>
    <div class="audit-comparator-preview">
      <span class="audit-comparator-dot"></span>
      <span class="audit-comparator-line strong"></span>
      <span class="audit-comparator-line"></span>
    </div>
  </div>`;
}

function themeChoice(themeId, state, activeThemeId) {
  const entry = themeRegistry.THEMES[themeId];
  const label = entry.i18nName.split(".").pop() || themeId;
  const mode = state === "active" ? "current" : state;
  const disabled = state === "disabled" ? " disabled" : "";
  const active = themeId === activeThemeId || state === "active" ? "true" : "false";
  return `<button type="button" class="audit-theme-card" data-theme-state="${state}" data-active="${active}" aria-pressed="${active}"${disabled}>
    <span class="audit-theme-swatch" style="background:${entry.backgroundColor}"></span>
    <span class="audit-theme-name" data-contrast="strong" data-no-overflow>${escapeHtml(label)}</span>
    <span class="audit-theme-state" data-contrast="strong" data-no-overflow>${escapeHtml(mode)}</span>
  </button>`;
}

function disabledAutoThemeChoice() {
  return `<button type="button" class="audit-theme-card" data-theme-state="disabled" data-active="false" aria-pressed="false" disabled>
    <span class="audit-theme-swatch audit-theme-swatch-auto"></span>
    <span class="audit-theme-name" data-contrast="strong" data-no-overflow>auto</span>
    <span class="audit-theme-state" data-contrast="strong" data-no-overflow>disabled</span>
  </button>`;
}

function connectorRow(name, detail, state, tone) {
  return `<div class="audit-connector-row">
    <div>
      <strong data-contrast="strong">${escapeHtml(name)}</strong>
      <span data-contrast="muted">${escapeHtml(detail)}</span>
    </div>
    <span class="audit-badge ${tone}" data-contrast="badge" data-no-overflow>${escapeHtml(state)}</span>
  </div>`;
}

function fixtureCss() {
  return `
html, body {
  min-height: 100%;
  height: auto;
  overflow: auto;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui, system-ui, sans-serif);
  line-height: 1.5;
}
button, input {
  font: inherit;
}
.audit-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(176px, 220px) minmax(0, 1fr);
  gap: 20px;
  padding: 22px;
}
.audit-nav,
.audit-panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: min(var(--radius-card, 8px), 8px);
  box-shadow: 0 8px 24px var(--shadow);
}
.audit-nav {
  align-self: start;
  position: sticky;
  top: 22px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
}
.audit-brand {
  min-height: 32px;
  display: flex;
  align-items: center;
  font-weight: 700;
  letter-spacing: 0;
}
.audit-nav-item,
.audit-button,
.audit-chip {
  min-height: 34px;
  border-radius: min(var(--radius-input, 6px), 8px);
  cursor: default;
  white-space: nowrap;
}
.audit-nav-item {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  text-align: left;
  padding: 7px 10px;
}
.audit-nav-item.active {
  background: var(--accent-light);
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 22%, transparent);
}
.audit-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.audit-header {
  min-height: 78px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 0 2px;
}
.audit-header h1,
.audit-panel h2,
.audit-kicker,
.audit-panel p {
  margin: 0;
}
.audit-header h1 {
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: 0;
}
.audit-kicker {
  font-size: 0.76rem;
  color: var(--text-muted);
}
.audit-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}
.audit-panel {
  min-width: 0;
  padding: 16px;
}
.audit-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.audit-panel h2 {
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0;
  color: var(--text);
}
.audit-panel p,
.audit-plugin-copy,
.audit-connector-row span:not(.audit-badge) {
  color: var(--text-muted);
  font-size: 0.78rem;
}
.audit-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
}
.audit-field span {
  color: var(--text);
  font-size: 0.82rem;
  font-weight: 600;
}
.audit-field input {
  min-width: 0;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: min(var(--radius-input, 6px), 8px);
  outline: none;
}
.audit-actions,
.audit-preset-row,
.audit-status-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.audit-button,
.audit-chip {
  padding: 6px 12px;
  border: 1px solid var(--border);
  color: var(--text);
  background: var(--bg);
}
.audit-button.primary {
  color: var(--bg-card);
  background: var(--accent);
  border-color: var(--accent);
}
.audit-theme-panel {
  min-height: 260px;
}
.audit-comparator-panel {
  min-height: 278px;
}
.audit-theme-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.audit-comparator-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.audit-comparator-surface {
  min-width: 0;
  min-height: 104px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: min(var(--radius-card, 8px), 8px);
}
.audit-comparator-topline {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.audit-comparator-topline strong {
  min-width: 0;
  color: var(--text);
  font-size: 0.82rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audit-comparator-surface p {
  min-height: 32px;
  margin: 0;
}
.audit-comparator-preview {
  min-height: 28px;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 4px 8px;
  align-items: center;
  padding: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: min(var(--radius-input, 6px), 8px);
}
.audit-comparator-dot {
  grid-row: 1 / 3;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--accent);
}
.audit-comparator-line {
  height: 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 42%, transparent);
}
.audit-comparator-line.strong {
  width: 72%;
  background: color-mix(in srgb, var(--accent) 54%, transparent);
}
.audit-theme-card {
  min-width: 0;
  min-height: 76px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  grid-template-rows: 1fr 1fr;
  align-items: center;
  gap: 4px 10px;
  padding: 10px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: min(var(--radius-card, 8px), 8px);
  text-align: left;
}
.audit-theme-card[data-active="true"] {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}
.audit-theme-card[data-theme-state="hover"] {
  background: color-mix(in srgb, var(--accent) 8%, var(--bg));
  border-color: color-mix(in srgb, var(--accent) 28%, var(--border));
}
.audit-theme-card[data-theme-state="focus"] {
  outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
  outline-offset: 2px;
}
.audit-theme-card[data-theme-state="disabled"] {
  opacity: 0.58;
  cursor: not-allowed;
}
.audit-theme-swatch {
  grid-row: 1 / 3;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: min(var(--radius-input, 6px), 8px);
}
.audit-theme-swatch-auto {
  background: linear-gradient(135deg, var(--bg-card) 0 48%, var(--accent-light) 48% 100%);
}
.audit-theme-name,
.audit-theme-state {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audit-theme-name {
  font-size: 0.82rem;
  font-weight: 700;
}
.audit-theme-state {
  font-size: 0.72rem;
  color: var(--text);
}
.audit-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  max-width: 100%;
  padding: 2px 8px;
  border-radius: min(var(--radius-input, 6px), 8px);
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.audit-badge.success {
  color: var(--success, var(--green));
  background: color-mix(in srgb, var(--success, var(--green)) 14%, transparent);
}
.audit-badge.warning {
  color: var(--warning, var(--coral));
  background: color-mix(in srgb, var(--warning, var(--coral)) 14%, transparent);
}
.audit-badge.danger {
  color: var(--danger, var(--coral));
  background: color-mix(in srgb, var(--danger, var(--coral)) 14%, transparent);
}
.audit-badge.neutral,
.audit-chip {
  color: var(--accent);
  background: var(--accent-light);
  border-color: color-mix(in srgb, var(--accent) 20%, transparent);
}
.audit-connector-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 0;
  border-top: 1px solid var(--border);
}
.audit-connector-row div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.audit-connector-row strong {
  color: var(--text);
  font-size: 0.83rem;
}
.audit-plugin-frame {
  min-height: 124px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 14px;
  background: var(--bg);
  border: 1px dashed var(--border);
  border-radius: min(var(--radius-card, 8px), 8px);
}
.audit-plugin-title {
  color: var(--text);
  font-weight: 700;
}
@media (max-width: 720px) {
  .audit-shell {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    padding: 12px;
  }
  .audit-nav {
    position: static;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .audit-brand {
    grid-column: 1 / -1;
  }
  .audit-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .audit-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .audit-panel-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .audit-theme-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .audit-comparator-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
`;
}

function runDomAudit() {
  const blockers = [];
  const warnings = [];
  const html = document.documentElement;

  if (html.scrollWidth > html.clientWidth + 1) {
    blockers.push({
      kind: "horizontal-overflow",
      message: `document scrollWidth ${html.scrollWidth} exceeds clientWidth ${html.clientWidth}`,
    });
  }

  for (const el of document.querySelectorAll("[data-audit-key]")) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 20) {
      blockers.push({
        kind: "invisible-surface",
        key: el.getAttribute("data-audit-key"),
        message: `${el.getAttribute("data-audit-key")} is too small (${Math.round(rect.width)}x${Math.round(rect.height)})`,
      });
    }
  }

  const boxes = Array.from(document.querySelectorAll("[data-layout-box]")).map((el) => ({
    key: el.getAttribute("data-layout-box"),
    rect: rectObject(el.getBoundingClientRect()),
  }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const overlap = overlapArea(boxes[i].rect, boxes[j].rect);
      if (overlap > 4) {
        blockers.push({
          kind: "layout-overlap",
          message: `${boxes[i].key} overlaps ${boxes[j].key} by ${Math.round(overlap)}px`,
        });
      }
    }
  }

  for (const el of document.querySelectorAll("[data-no-overflow]")) {
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      blockers.push({
        kind: "text-overflow",
        message: `${labelFor(el)} overflows its container`,
      });
    }
  }

  for (const el of document.querySelectorAll("[data-contrast]")) {
    const contrast = contrastFor(el);
    if (!contrast) {
      warnings.push({ kind: "contrast-unreadable", message: `${labelFor(el)} contrast could not be computed` });
      continue;
    }
    const mode = el.getAttribute("data-contrast");
    const minimum = mode === "strong" ? 4.5 : 3.0;
    const blockerMinimum = mode === "strong" ? minimum : mode === "badge" ? 1.8 : 1.5;
    const item = {
      kind: "contrast",
      message: `${labelFor(el)} contrast ${contrast.ratio.toFixed(2)} < ${minimum}`,
      ratio: Number(contrast.ratio.toFixed(2)),
      minimum,
    };
    if (contrast.ratio < minimum) {
      if (contrast.ratio < blockerMinimum) blockers.push(item);
      else warnings.push(item);
    }
  }

  return { blockers, warnings };

  function rectObject(rect) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  }

  function overlapArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function contrastFor(el) {
    const styles = getComputedStyle(el);
    const fg = parseCssColor(styles.color);
    const bg = resolvedBackground(el);
    if (!fg || !bg) return null;
    return { ratio: contrastRatio(fg, bg), foreground: fg, background: bg };
  }

  function resolvedBackground(el) {
    let current = el;
    while (current) {
      const color = parseCssColor(getComputedStyle(current).backgroundColor);
      if (color && color.a > 0.05) return blend(color, current.parentElement ? resolvedBackground(current.parentElement) : null);
      current = current.parentElement;
    }
    return parseCssColor(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  }

  function parseCssColor(value) {
    const raw = String(value || "").trim();
    if (!raw || raw === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const rgb = raw.match(/^rgba?\((.+)\)$/i);
    if (rgb) {
      const parts = rgb[1].replace(/\s*\/\s*/, " ").split(/[\s,]+/).filter(Boolean);
      if (parts.length >= 3) {
        return { r: component(parts[0]), g: component(parts[1]), b: component(parts[2]), a: parts[3] === undefined ? 1 : Number(parts[3]) };
      }
    }
    const srgb = raw.match(/^color\(srgb\s+([^\s]+)\s+([^\s]+)\s+([^\s/]+)(?:\s*\/\s*([^\s]+))?\)$/i);
    if (srgb) {
      return {
        r: Number(srgb[1]) * 255,
        g: Number(srgb[2]) * 255,
        b: Number(srgb[3]) * 255,
        a: srgb[4] === undefined ? 1 : Number(srgb[4]),
      };
    }
    return null;
  }

  function component(token) {
    return token.endsWith("%") ? Number.parseFloat(token) * 2.55 : Number.parseFloat(token);
  }

  function blend(top, bottom) {
    if (!bottom || top.a >= 1) return top;
    const a = top.a + bottom.a * (1 - top.a);
    if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
      g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
      b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
      a,
    };
  }

  function contrastRatio(foreground, background) {
    const a = relativeLuminance(foreground);
    const b = relativeLuminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function relativeLuminance(color) {
    const [r, g, b] = [color.r, color.g, color.b].map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function labelFor(el) {
    return el.getAttribute("data-audit-key") || el.textContent.trim().replace(/\s+/g, " ").slice(0, 48) || el.tagName.toLowerCase();
  }
}

function analyzePng(filePath) {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  const totalPixels = png.width * png.height;
  const step = Math.max(1, Math.floor(totalPixels / 50000));
  const colors = new Set();
  let min = 255;
  let max = 0;
  let sampled = 0;
  for (let pixel = 0; pixel < totalPixels; pixel += step) {
    const offset = pixel * 4;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];
    const a = png.data[offset + 3];
    const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    colors.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
    sampled += 1;
  }
  return {
    width: png.width,
    height: png.height,
    sampled,
    uniqueColors: colors.size,
    colorSpread: max - min,
  };
}

function finish(exitCode) {
  report.counts.blockers = report.blockers.length;
  report.counts.warnings = report.warnings.length;
  report.ok = report.blockers.length === 0;
  writeJson(reportPath, report);
  writeMarkdown(markdownPath, report);
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[theme-screenshot-audit] themes=${report.themes.length} viewports=${report.viewports.length} screenshots=${report.counts.screenshots} blockers=${report.counts.blockers} warnings=${report.counts.warnings}`);
    for (const item of report.blockers.slice(0, 20)) console.error(formatFinding(item));
    if (reportPath) console.log(`[theme-screenshot-audit] report: ${reportPath}`);
    if (markdownPath) console.log(`[theme-screenshot-audit] markdown: ${markdownPath}`);
    if (report.counts.screenshots) console.log(`[theme-screenshot-audit] screenshots: ${screenshotsDir}`);
  }
  process.exit(exitCode);
}

function runtimeMessage(message) {
  if (/Executable doesn't exist|browser.*not.*found|playwright install/i.test(message)) {
    return `Playwright Chromium runtime is missing. Run \`${report.setup.installCommand}\` and retry.`;
  }
  if (/Cannot find package|Cannot find module/i.test(message)) {
    return "Playwright package is missing. Run `npm install` and retry.";
  }
  return `Playwright could not start Chromium. Run \`${report.setup.installCommand}\` and retry.`;
}

function isMissingHeadlessShell(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /chromium_headless_shell|chrome-headless-shell|Executable doesn't exist/i.test(message);
}

function isMissingBrowserRuntime(message) {
  return /Executable doesn't exist|browser.*not.*found|playwright install|chromium_headless_shell|chrome-headless-shell/i.test(message);
}

function isMissingBrowserLaunchFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return isMissingHeadlessShell(error) || isMissingBrowserRuntime(message);
}

function formatRuntimeFailure(label, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}: ${message.split(/\r?\n/)[0] || "unknown error"}`;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function writeJson(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function writeMarkdown(target, data) {
  const lines = [
    "# Theme Screenshot Audit",
    "",
    `Generated: ${data.generatedAt}`,
    "",
    `- Themes: ${data.themes.length}`,
    `- Viewports: ${data.viewports.map((viewport) => `${viewport.id} ${viewport.width}x${viewport.height}`).join(", ")}`,
    `- Screenshots: ${data.counts.screenshots}`,
    `- Blockers: ${data.counts.blockers}`,
    `- Warnings: ${data.counts.warnings}`,
    `- Screenshot directory: ${data.screenshotsDir}`,
    "",
    "## Blockers",
    "",
  ];
  if (!data.blockers.length) lines.push("None.", "");
  else {
    lines.push("| Theme | Viewport | Finding |", "| --- | --- | --- |");
    for (const item of data.blockers) lines.push(`| ${item.theme || ""} | ${item.viewport || ""} | ${escapeCell(formatFinding(item))} |`);
    lines.push("");
  }

  lines.push("## Warning Sample", "");
  if (!data.warnings.length) lines.push("None.", "");
  else {
    lines.push("| Theme | Viewport | Finding |", "| --- | --- | --- |");
    for (const item of data.warnings.slice(0, 80)) lines.push(`| ${item.theme || ""} | ${item.viewport || ""} | ${escapeCell(formatFinding(item))} |`);
    lines.push("");
  }

  lines.push("## Screenshots", "", "| Theme | Viewport | File |", "| --- | --- | --- |");
  for (const item of data.results) lines.push(`| ${item.theme} | ${item.viewport} | ${item.screenshot || "not generated"} |`);
  lines.push("");

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function formatFinding(item) {
  if (item.fix) return `${item.kind}: ${item.message} Fix: ${item.fix}`;
  return `${item.kind}: ${item.message}`;
}

function valueArg(name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function resolveOutput(target) {
  return path.resolve(ROOT, target);
}

function safeFile(value) {
  return String(value).replace(/[^a-z0-9._-]+/gi, "-");
}

function slash(value) {
  return value.split(path.sep).join("/");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}
