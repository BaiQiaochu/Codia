#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = String(process.env.CODIA_PACKAGE_SMOKE_BASE_URL || "").replace(/\/+$/, "");
const token = String(process.env.CODIA_PACKAGE_SMOKE_TOKEN || "");
const screenshotsArg = String(process.env.CODIA_PACKAGE_SMOKE_SCREENSHOTS || "").trim();
const screenshotsDir = screenshotsArg === "none"
  ? null
  : path.resolve(screenshotsArg || "artifacts/packaged-runtime-smoke-screenshots");

if (!baseUrl) {
  console.error("[packaged-runtime-smoke] CODIA_PACKAGE_SMOKE_BASE_URL is required");
  process.exit(2);
}

const headers = token ? { Authorization: `Bearer ${token}` } : {};
const checks = [];
const screenshots = [];
let browser = null;

try {
  const mobileHtml = await httpText("/mobile/");
  assertIncludes(mobileHtml, "react-root", "/mobile/ shell root");
  assertIncludes(mobileHtml, "lib/theme.js", "/mobile/ theme runtime script");
  checks.push("built-in PWA accessible");

  const themeRuntime = await httpText("/mobile/lib/theme.js");
  assertIncludes(themeRuntime, "window.setTheme", "PWA browser theme runtime");

  const mobileBootstrap = await httpJson("/api/mobile/bootstrap");
  validateMobileBootstrap(mobileBootstrap);
  checks.push("PWA bootstrap identity");

  const skills = await httpJson("/api/skills?agentId=codia");
  if (!Array.isArray(skills?.skills)) {
    throw new Error("/api/skills did not return a skills array");
  }
  checks.push("skills API callable");

  browser = await launchChromium();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  if (token) {
    await loginPwaSession(page);
  }
  await page.goto(`${baseUrl}/mobile/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.setTheme === "function");
  if (token) {
    await waitForPwaShellReady(page);
    await assertPwaWelcomeIdentityVisible(page);
    await assertNoHorizontalOverflow(page, "mobile-ready");
    await captureSmokeScreenshot(page, "mobile-ready");
    checks.push("PWA welcome identity visible");
  } else {
    await captureSmokeScreenshot(page, "mobile-login");
  }
  await page.evaluate(() => window.setTheme("workbench"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "workbench");
  await waitForPwaShellReady(page);
  await assertNoHorizontalOverflow(page, "mobile-theme-workbench");
  const themeState = await page.evaluate(() => ({
    dataTheme: document.documentElement.getAttribute("data-theme"),
    storedTheme: localStorage.getItem("codia-theme"),
    cssHref: document.getElementById("themeSheet")?.getAttribute("href") || "",
  }));
  if (themeState.storedTheme !== "workbench") {
    throw new Error(`PWA theme storage did not persist workbench: ${JSON.stringify(themeState)}`);
  }
  if (!themeState.cssHref.includes("workbench")) {
    throw new Error(`PWA theme stylesheet did not switch to workbench: ${JSON.stringify(themeState)}`);
  }
  await captureSmokeScreenshot(page, "mobile-theme-workbench");
  checks.push("PWA theme sync");
} catch (error) {
  console.error(`[packaged-runtime-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}

if (!process.exitCode) {
  console.log(`[packaged-runtime-smoke] passed: ${checks.join(", ")}`);
  if (screenshots.length) console.log(`[packaged-runtime-smoke] screenshots: ${screenshotsDir}`);
}

function validateMobileBootstrap(data) {
  if (!data || typeof data !== "object") throw new Error("/api/mobile/bootstrap did not return an object");
  if (!data.currentAgentId) throw new Error("/api/mobile/bootstrap missing currentAgentId");
  if (!data.agentName) throw new Error("/api/mobile/bootstrap missing agentName");
  if (!Array.isArray(data.agents)) throw new Error("/api/mobile/bootstrap missing agents array");
  if (!data.avatars || typeof data.avatars !== "object") throw new Error("/api/mobile/bootstrap missing avatars object");
}

async function loginPwaSession(page) {
  const res = await page.request.post(`${baseUrl}/api/web-auth/login`, {
    data: { credential: token },
  });
  if (!res.ok()) {
    throw new Error(`/api/web-auth/login returned ${res.status()} ${res.statusText()}: ${(await res.text()).slice(0, 500)}`);
  }
}

async function waitForPwaShellReady(page) {
  if (token) {
    await page.waitForSelector(".mobile-desktop-root", { timeout: 20_000 });
    return;
  }
  await page.waitForSelector(".onboarding-step", { timeout: 20_000 });
}

async function assertPwaWelcomeIdentityVisible(page) {
  const state = await page.evaluate(() => {
    const root = document.querySelector(".mobile-desktop-root");
    const login = document.querySelector("form.onboarding-step");
    const welcome = document.querySelector("#welcome");
    const avatar = document.querySelector(".welcome img, .welcome span[aria-label], .welcomeAgentChip img, .onboarding-avatar");
    const identityControl = welcome?.querySelector("button[aria-label]");
    const title = welcome?.querySelector("h1");
    const rect = avatar?.getBoundingClientRect?.();
    const identityRect = identityControl?.getBoundingClientRect?.();
    return {
      ready: Boolean(root),
      loginVisible: Boolean(login),
      avatarVisible: Boolean(rect && rect.width >= 16 && rect.height >= 16),
      identityVisible: Boolean(identityRect && identityRect.width >= 16 && identityRect.height >= 16),
      welcomeTitleVisible: Boolean(title?.textContent?.trim()),
    };
  });
  if (!state.ready || state.loginVisible) {
    throw new Error(`PWA did not enter the authenticated mobile shell: ${JSON.stringify(state)}`);
  }
  if (!state.avatarVisible && !(state.identityVisible && state.welcomeTitleVisible)) {
    throw new Error(`PWA welcome identity was not visible: ${JSON.stringify(state)}`);
  }
}

async function assertNoHorizontalOverflow(page, surface) {
  const state = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return {
      scrollWidth: Math.max(doc?.scrollWidth || 0, body?.scrollWidth || 0),
      clientWidth: doc?.clientWidth || window.innerWidth || 0,
      textLength: (body?.innerText || "").trim().length,
    };
  });
  if (state.textLength <= 0) throw new Error(`${surface} rendered without visible text`);
  if (state.clientWidth > 0 && state.scrollWidth > state.clientWidth + 2) {
    throw new Error(`${surface} has horizontal overflow: ${JSON.stringify(state)}`);
  }
}

async function captureSmokeScreenshot(page, surface) {
  if (!screenshotsDir) return;
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const filePath = path.join(screenshotsDir, `${surface}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  screenshots.push(path.relative(process.cwd(), filePath).replace(/\\/g, "/"));
}

async function httpText(path) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  if (!res.ok) throw new Error(`${path} returned ${res.status} ${res.statusText}: ${await safeBody(res)}`);
  return await res.text();
}

async function httpJson(path) {
  const text = await httpText(path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} did not return JSON: ${text.slice(0, 200)}`);
  }
}

async function safeBody(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}

function assertIncludes(value, needle, label) {
  if (!String(value).includes(needle)) {
    throw new Error(`${label} missing ${needle}`);
  }
}

async function launchChromium() {
  const baseOptions = {
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  };
  try {
    return await chromium.launch(baseOptions);
  } catch (error) {
    if (!isMissingHeadlessShell(error)) throw error;
  }
  return chromium.launch({ ...baseOptions, channel: "chromium" });
}

function isMissingHeadlessShell(error) {
  return /chromium_headless_shell|chrome-headless-shell|Executable doesn't exist/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
