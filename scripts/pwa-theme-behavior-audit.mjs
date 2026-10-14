#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { chromium } from "playwright";
import registry from "../desktop/src/shared/theme-registry.cjs";
import { PWA_DISPLAY_NAME } from "../shared/product-branding.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`pwa-theme-behavior-audit

Runs a browser behavior audit for theme sync across the real /mobile/ static route and an Access & Devices surface.

Checks:
  - /mobile/ is served by server/routes/mobile-static.js
  - lib/theme.js applies and persists the selected theme
  - Access & Devices reloads the same stored theme on the same PWA origin
  - theme sync updates data-theme and #themeSheet without UI blockers

Options:
  --json              Print JSON only
  --report=<path>     Write JSON report
  --markdown=<path>   Write Markdown report
  --screenshots=<dir> Write behavior screenshots, default artifacts/pwa-theme-behavior-screenshots
`);
  process.exit(0);
}

const ROOT = process.cwd();
const jsonOnly = args.includes("--json");
const reportPath = valueArg("--report");
const markdownPath = valueArg("--markdown");
const screenshotsArg = valueArg("--screenshots");
const screenshotsDir = screenshotsArg === "none"
  ? null
  : path.resolve(screenshotsArg || "artifacts/pwa-theme-behavior-screenshots");
const blockers = [];
const screenshots = [];
let tempDir = null;
let server = null;
let browser = null;
let browserRuntime = null;

try {
  ensureThemeRuntime();
  tempDir = prepareMobileDistFixture();
  const { app, port } = await startAuditServer(tempDir);
  void app;
  const baseUrl = `http://127.0.0.1:${port}`;

  browser = await launchChromium();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => {
    const message = String(error?.message || error);
    if (!message.includes("service worker registration failed")) blockers.push({ surface: "browser", message });
  });

  await page.goto(`${baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  await expectPageState(page, {
    surface: "mobile",
    titleIncludes: PWA_DISPLAY_NAME,
    expectedTheme: registry.DEFAULT_THEME,
    expectedCss: registry.THEMES[registry.DEFAULT_THEME].cssPath,
  });
  await assertNoVisualBlockers(page, "mobile");
  await captureBehaviorScreenshot(page, "mobile");

  await page.evaluate(() => window.setTheme("workbench"));
  await expectPageState(page, {
    surface: "mobile-legacy-theme-normalized",
    titleIncludes: PWA_DISPLAY_NAME,
    expectedTheme: registry.DEFAULT_THEME,
    expectedCss: registry.THEMES[registry.DEFAULT_THEME].cssPath,
    expectedStoredTheme: registry.DEFAULT_THEME,
  });
  await assertNoVisualBlockers(page, "mobile-legacy-theme-normalized");
  await captureBehaviorScreenshot(page, "mobile-legacy-theme-normalized");

  await page.goto(`${baseUrl}/settings/access`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-surface=\"access-devices\"]");
  await expectPageState(page, {
    surface: "access-devices",
    titleIncludes: "Access & Devices",
    expectedTheme: registry.DEFAULT_THEME,
    expectedCss: registry.THEMES[registry.DEFAULT_THEME].cssPath,
    expectedStoredTheme: registry.DEFAULT_THEME,
  });
  const accessText = await page.locator("[data-surface=\"access-devices\"]").innerText();
  if (!accessText.includes("Access & Devices") || !accessText.includes("Access and device settings")) {
    blockers.push({
      surface: "access-devices",
      message: "Access & Devices surface did not render the expected bilingual heading.",
    });
  }
  await assertNoVisualBlockers(page, "access-devices");
  await captureBehaviorScreenshot(page, "access-devices");
} catch (error) {
  blockers.push({ surface: "audit", message: error instanceof Error ? error.message : String(error) });
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve)).catch(() => {});
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
}

const report = {
  ok: blockers.length === 0,
  generatedAt: new Date().toISOString(),
  checks: [
    "/mobile/",
    "lib/theme.js",
    "Access & Devices",
    "theme sync",
    "behavior screenshots",
    "visual blocker scan",
  ],
  counts: {
    blockers: blockers.length,
    screenshots: screenshots.length,
  },
  browserRuntime,
  blockers,
  screenshots,
};

writeJson(reportPath, report);
writeMarkdown(markdownPath, report);

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[pwa-theme-behavior-audit] blockers=${blockers.length}`);
  for (const blocker of blockers) {
    console.error(`[pwa-theme-behavior-audit] ${blocker.surface}: ${blocker.message}`);
  }
  if (reportPath) console.log(`[pwa-theme-behavior-audit] report: ${path.resolve(reportPath)}`);
  if (markdownPath) console.log(`[pwa-theme-behavior-audit] markdown: ${path.resolve(markdownPath)}`);
  if (screenshots.length) console.log(`[pwa-theme-behavior-audit] screenshots: ${screenshotsDir}`);
}

process.exit(report.ok ? 0 : 1);

function prepareMobileDistFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-pwa-theme-audit-"));
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(dir, "locales"), { recursive: true });
  fs.mkdirSync(path.join(dir, "modules"), { recursive: true });
  fs.cpSync(path.join(ROOT, "desktop", "src", "themes"), path.join(dir, "themes"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "desktop", "src", "icon.png"), path.join(dir, "icon.png"));

  const themeBundle = path.join(ROOT, "desktop", "dist-renderer", "lib", "theme.js");
  if (!fs.existsSync(themeBundle)) {
    throw new Error("desktop/dist-renderer/lib/theme.js missing after automatic npm run build:theme");
  }
  fs.copyFileSync(themeBundle, path.join(dir, "lib", "theme.js"));
  fs.writeFileSync(path.join(dir, "lib", "i18n.js"), "window.t = window.t || ((key) => key);\n", "utf-8");
  fs.writeFileSync(path.join(dir, "modules", "platform.js"), "window.platform = window.platform || { getPlatform: async () => 'web' };\n", "utf-8");
  fs.writeFileSync(path.join(dir, "assets", "mobile-stub.js"), renderMobileStubScript(), "utf-8");
  fs.writeFileSync(path.join(dir, "styles.css"), "body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,sans-serif}.pwa-shell{min-height:100vh;padding:24px}.pwa-action{min-width:44px;min-height:36px}\n", "utf-8");
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), JSON.stringify({ name: PWA_DISPLAY_NAME, start_url: "/mobile/" }), "utf-8");
  fs.writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {});\n", "utf-8");
  fs.writeFileSync(path.join(dir, "locales", "zh.json"), "{}", "utf-8");

  const mobileHtml = fs.readFileSync(path.join(ROOT, "desktop", "src", "mobile.html"), "utf-8")
    .replace('<script type="module" src="./mobile-main.tsx"></script>', '<script type="module" src="./assets/mobile-stub.js"></script>');
  fs.writeFileSync(path.join(dir, "mobile.html"), mobileHtml, "utf-8");
  return dir;
}

function renderMobileStubScript() {
  return `document.body.dataset.mobileStubReady = '1';
const root = document.getElementById('react-root');
if (root) {
  root.innerHTML = '<main class="pwa-shell" data-surface="mobile"><h1>${PWA_DISPLAY_NAME}</h1><p>Web sessions, themes, and access are loaded.</p><button class="pwa-action" type="button" title="Open chat">Chat</button></main>';
}
`;
}

function ensureThemeRuntime() {
  const themeBundle = path.join(ROOT, "desktop", "dist-renderer", "lib", "theme.js");
  if (!isThemeRuntimeStale(themeBundle)) return;

  const result = runNpmScript("build:theme");
  if (result.status !== 0) {
    const detail = [
      result.error?.message,
      result.stderr,
      result.stdout,
    ].filter(Boolean).join("\n").trim();
    throw new Error(`automatic npm run build:theme failed${detail ? `: ${detail}` : ""}`);
  }
}

function runNpmScript(scriptName) {
  const ioOptions = jsonOnly
    ? { stdio: "pipe", encoding: "utf-8" }
    : { stdio: "inherit" };
  const commandArgs = ["run", scriptName];
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...commandArgs], {
      cwd: ROOT,
      shell: false,
      windowsHide: true,
      ...ioOptions,
    });
  }
  return spawnSync("npm", commandArgs, {
    cwd: ROOT,
    shell: false,
    windowsHide: true,
    ...ioOptions,
  });
}

function isThemeRuntimeStale(themeBundle) {
  if (!fs.existsSync(themeBundle)) return true;
  const bundleMtime = fs.statSync(themeBundle).mtimeMs;
  for (const source of themeRuntimeSources()) {
    if (!fs.existsSync(source)) continue;
    if (fs.statSync(source).mtimeMs > bundleMtime) return true;
  }
  return false;
}

function themeRuntimeSources() {
  const sources = [
    path.join(ROOT, "desktop", "src", "lib", "theme.ts"),
    path.join(ROOT, "desktop", "src", "shared", "theme-registry.cjs"),
    path.join(ROOT, "vite.config.theme.js"),
  ];
  const themesDir = path.join(ROOT, "desktop", "src", "themes");
  if (fs.existsSync(themesDir)) {
    for (const entry of fs.readdirSync(themesDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".css")) {
        sources.push(path.join(themesDir, entry.name));
      }
    }
  }
  return sources;
}

async function startAuditServer(distDir) {
  const { createMobileStaticRoute } = await loadMobileStaticRoute();
  const app = new Hono();
  app.route("", createMobileStaticRoute({ distDir }));
  app.get("/settings/access", (c) => c.html(renderAccessDevicesPage()));
  app.get("/api/access/summary", (c) => c.json({
    network: {
      mode: "lan",
      localMobileUrl: "http://127.0.0.1/mobile/",
      lanMobileUrl: "http://127.0.0.1/mobile/",
    },
    devices: [],
    credentials: [],
  }));
  const serverInstance = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((resolve) => {
    if (serverInstance.listening) resolve();
    else serverInstance.on("listening", resolve);
  });
  server = serverInstance;
  const address = serverInstance.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { app, port };
}

async function loadMobileStaticRoute() {
  try {
    return await import("../server/routes/mobile-static.ts");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNKNOWN_FILE_EXTENSION") {
      throw error;
    }
    return import("../server/routes/mobile-static.js");
  }
}

function renderAccessDevicesPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Access & Devices</title>
  <link rel="stylesheet" href="/mobile/styles.css">
  <link rel="stylesheet" href="/mobile/themes/studio-light.css" id="themeSheet">
</head>
<body>
  <main class="pwa-shell" data-surface="access-devices">
    <h1>Access & Devices</h1>
    <p>Access and device settings</p>
    <button class="pwa-action" type="button" title="Copy web URL">Copy</button>
  </main>
  <script type="module" src="/mobile/lib/theme.js"></script>
</body>
</html>`;
}

async function launchChromium() {
  const baseOptions = {
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  };
  const failures = [];
  try {
    const launched = await chromium.launch(baseOptions);
    browserRuntime = "bundled-chromium";
    return launched;
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
      const launched = await chromium.launch({ ...baseOptions, channel });
      browserRuntime = `channel:${channel}`;
      return launched;
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

function isMissingHeadlessShell(error) {
  return /chromium_headless_shell|chrome-headless-shell|Executable doesn't exist/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

function isMissingBrowserLaunchFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return isMissingHeadlessShell(error)
    || /Executable doesn't exist|browser.*not.*found|playwright install|chromium_headless_shell|chrome-headless-shell/i.test(message);
}

function formatRuntimeFailure(label, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}: ${message.split(/\r?\n/)[0] || "unknown error"}`;
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

async function expectPageState(page, { surface, titleIncludes, expectedTheme, expectedCss, expectedStoredTheme }) {
  const state = await page.evaluate(() => ({
    title: document.title,
    dataTheme: document.documentElement.getAttribute("data-theme"),
    cssHref: document.getElementById("themeSheet")?.getAttribute("href") || "",
    stored: localStorage.getItem("codia-theme"),
    legacyStored: localStorage.getItem("codia-theme"),
  }));
  if (!state.title.includes(titleIncludes)) {
    blockers.push({ surface, message: `Expected title to include "${titleIncludes}", got "${state.title}".` });
  }
  if (state.dataTheme !== expectedTheme) {
    blockers.push({ surface, message: `Expected data-theme ${expectedTheme}, got ${state.dataTheme || "<empty>"}.` });
  }
  if (!state.cssHref.includes(expectedCss)) {
    blockers.push({ surface, message: `Expected CSS path ${expectedCss}, got ${state.cssHref || "<empty>"}.` });
  }
  if (expectedStoredTheme && (state.stored !== expectedStoredTheme || state.legacyStored !== expectedStoredTheme)) {
    blockers.push({ surface, message: `Expected stored theme ${expectedStoredTheme}, got ${state.stored || "<empty>"}.` });
  }
}

async function assertNoVisualBlockers(page, surface) {
  const state = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const textLength = (body?.innerText || "").trim().length;
    const scrollWidth = Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0);
    const clientWidth = doc?.clientWidth || window.innerWidth || 0;
    const rootVisible = Boolean(document.querySelector("#react-root, [data-surface=\"access-devices\"]"));
    const center = document.elementFromPoint(
      Math.max(1, Math.floor((window.innerWidth || clientWidth || 1) / 2)),
      Math.max(1, Math.floor((window.innerHeight || 1) / 2)),
    );
    return {
      rootVisible,
      textLength,
      scrollWidth,
      clientWidth,
      centerTag: center ? center.tagName.toLowerCase() : null,
    };
  });
  if (!state.rootVisible) {
    blockers.push({ surface, message: "Expected a visible PWA root or Access & Devices surface." });
  }
  if (state.textLength <= 0) {
    blockers.push({ surface, message: "Surface rendered without visible text." });
  }
  if (state.clientWidth > 0 && state.scrollWidth > state.clientWidth + 2) {
    blockers.push({
      surface,
      message: `Horizontal overflow detected: scrollWidth=${state.scrollWidth}, clientWidth=${state.clientWidth}.`,
    });
  }
  if (!state.centerTag) {
    blockers.push({ surface, message: "Center point did not resolve to a visible element." });
  }
}

async function captureBehaviorScreenshot(page, surface) {
  if (!screenshotsDir) return;
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const filePath = path.join(screenshotsDir, `${surface}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  const state = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme") || "",
    title: document.title,
  }));
  screenshots.push({
    surface,
    theme: state.theme,
    title: state.title,
    viewport: page.viewportSize(),
    file: path.relative(ROOT, filePath).replace(/\\/g, "/"),
  });
}

function writeJson(target, data) {
  if (!target) return;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function writeMarkdown(target, data) {
  if (!target) return;
  const lines = [
    "# PWA Theme Behavior Audit",
    "",
    `Generated: ${data.generatedAt}`,
    `Blockers: ${data.counts.blockers}`,
    `Screenshots: ${data.counts.screenshots}`,
    "",
  ];
  if (data.blockers.length) {
    lines.push("## Blockers", "");
    for (const item of data.blockers) lines.push(`- ${item.surface}: ${item.message}`);
  }
  if (data.screenshots.length) {
    lines.push("", "## Screenshots", "", "| Surface | Theme | File |", "| --- | --- | --- |");
    for (const item of data.screenshots) {
      lines.push(`| ${item.surface} | ${item.theme || "-"} | ${item.file} |`);
    }
  }
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
}

function valueArg(name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}
