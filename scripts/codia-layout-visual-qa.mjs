#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startIsolatedVisualRuntime } from './codia-qa-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outputDir = path.join(root, 'artifacts', 'codia-layout-qa');
fs.mkdirSync(outputDir, { recursive: true });
const runtime = await startIsolatedVisualRuntime(root);
const { baseUrl, token } = runtime;
let browser;
const report = { baseUrl, isolatedHome: runtime.home, modelEndpoint: runtime.mock.baseUrl, generatedAt: new Date().toISOString(), captures: [], consoleErrors: [], httpErrors: [] };

try {
  browser = await launchBrowser();
  for (const target of [
    { id: 'welcome-1440x900', width: 1440, height: 900, deviceScaleFactor: 1 },
    { id: 'welcome-1280x800', width: 1280, height: 800, deviceScaleFactor: 1 },
    { id: 'welcome-1440x900-effective-125pct', width: 1152, height: 720, deviceScaleFactor: 1.25 },
    { id: 'welcome-low-height', width: 1100, height: 650, deviceScaleFactor: 1 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: target.width, height: target.height },
      deviceScaleFactor: target.deviceScaleFactor,
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    watchPage(page, target.id);
    await authenticate(page);
    await page.locator('[aria-label="Codia 小豆蔻"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(650);
    await freezeMascot(page, 'center');

    const metrics = await page.evaluate(() => {
      const rect = (element) => element ? (() => {
        const value = element.getBoundingClientRect();
        return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
      })() : null;
      const hero = document.querySelector('[aria-label="Codia 小豆蔻"]');
      const quick = document.querySelector('[aria-label="快捷任务"]');
      const input = document.querySelector('.input-area:not(.hidden)');
      const chatArea = document.querySelector('.main-content.welcome-mode .chat-area');
      const welcome = document.querySelector('#welcome');
      const welcomeRoot = welcome?.firstElementChild;
      const heroStage = hero?.parentElement;
      const actionDock = quick?.parentElement;
      return {
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
        hero: rect(hero),
        heroCopy: rect(hero?.querySelector('[class*="codiaHeroCopy"]')),
        heroArt: rect(hero?.querySelector('[data-codia-mascot-frame]')),
        heroStage: rect(heroStage),
        quick: rect(quick),
        actionDock: rect(actionDock),
        input: rect(input),
        chatArea: rect(chatArea),
        welcome: rect(welcome),
        welcomeRoot: rect(welcomeRoot),
        chatScrollHeight: chatArea?.scrollHeight || 0,
        chatClientHeight: chatArea?.clientHeight || 0,
      };
    });

    if (!metrics.hero || !metrics.quick || !metrics.input || !metrics.chatArea) {
      throw new Error(`${target.id}: welcome layout elements are missing`);
    }
    if (metrics.input.bottom > target.height + 1 || metrics.input.top < 0) {
      throw new Error(`${target.id}: composer is outside the viewport`);
    }
    if (metrics.heroArt?.width > 0 && metrics.heroCopy?.right > metrics.heroArt.left) {
      throw new Error(`${target.id}: welcome copy overlaps the kitten`);
    }
    const screenshotPath = path.join(outputDir, `${target.id}.png`);
    await page.screenshot({ path: screenshotPath, animations: 'disabled' });
    report.captures.push({ ...target, screenshotPath, metrics });

    if (target.id === 'welcome-1440x900') {
      for (const gaze of ['left', 'right']) {
        await freezeMascot(page, gaze);
        const mascotScreenshot = path.join(outputDir, `mascot-${gaze}-1440x900.png`);
        await page.locator('[aria-label="Codia 小豆蔻"]').screenshot({ path: mascotScreenshot, animations: 'disabled' });
        report.captures.push({
          id: `mascot-${gaze}-1440x900`,
          screenshotPath: mascotScreenshot,
          gaze,
        });
      }
      await freezeMascot(page, 'center');
      const editor = page.locator('.input-area:not(.hidden) .tiptap').first();
      await editor.click();
      await page.keyboard.type('@');
      const mentionMenu = page.getByRole('dialog', { name: '引用内容' });
      await mentionMenu.waitFor({ state: 'visible' });
      const mentionTabLabels = await mentionMenu.getByRole('tab').allTextContents();
      const mentionScreenshot = path.join(outputDir, 'mention-menu-1440x900.png');
      await page.screenshot({ path: mentionScreenshot, animations: 'disabled' });
      report.captures.push({
        id: 'mention-menu-1440x900',
        width: target.width,
        height: target.height,
        deviceScaleFactor: target.deviceScaleFactor,
        screenshotPath: mentionScreenshot,
        mentionTabLabels: mentionTabLabels.map(label => label.trim()).filter(Boolean),
      });
    }
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  watchPage(page, 'settings-1280x800');
  await authenticate(page);
  await page.locator('[aria-label="Codia 小豆蔻"]').waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
  await page.goto(`${baseUrl}/settings.html`, { waitUntil: 'networkidle' });
  await page.locator('[data-settings-category="general-devices"]').waitFor({ state: 'visible' });
  const categoryOrder = await page.locator('[data-settings-category]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-settings-category')));
  await page.locator('[data-settings-category="general-devices"]').click();
  await page.locator('[data-settings-module="about"]').waitFor({ state: 'visible' });
  const moduleLabels = await page.locator('[data-settings-module]').evaluateAll(nodes => nodes.map(node => node.textContent?.trim()));
  const settingsScreenshot = path.join(outputDir, 'settings-1280x800.png');
  await page.screenshot({ path: settingsScreenshot, animations: 'disabled' });
  report.captures.push({
    id: 'settings-1280x800',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    screenshotPath: settingsScreenshot,
    categoryOrder,
    moduleLabels,
  });

  await page.locator('[data-settings-module="about"]').click();
  const productLogo = page.getByRole('img', { name: 'Codia 小豆蔻' });
  await productLogo.waitFor({ state: 'visible' });
  await productLogo.scrollIntoViewIfNeeded();
  const productInfoScreenshot = path.join(outputDir, 'settings-product-info-1280x800.png');
  await page.screenshot({ path: productInfoScreenshot, animations: 'disabled' });
  report.captures.push({
    id: 'settings-product-info-1280x800',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    screenshotPath: productInfoScreenshot,
  });

  await page.locator('[data-settings-category="account-agent"]').click();
  await page.locator('[data-settings-module="agent"]').click();
  await page.locator('[data-testid="agent-identity-card"]').waitFor({ state: 'visible' });
  const agentSettingsScreenshot = path.join(outputDir, 'assistant-settings-1280x800.png');
  await page.screenshot({ path: agentSettingsScreenshot, animations: 'disabled' });
  report.captures.push({
    id: 'assistant-settings-1280x800',
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    screenshotPath: agentSettingsScreenshot,
  });
  await page.setViewportSize({ width: 1024, height: 720 });
  const identity = page.locator('[data-testid="agent-identity-card"]');
  const identityMetrics = await identity.evaluate(node => ({
    width: node.clientWidth, scrollWidth: node.scrollWidth,
    documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
  }));
  if (identityMetrics.scrollWidth > identityMetrics.width + 1 || identityMetrics.documentWidth > 1025) {
    throw new Error(`Assistant settings overflow: ${JSON.stringify(identityMetrics)}`);
  }
  const narrowSettingsScreenshot = path.join(outputDir, 'assistant-settings-1024x720.png');
  await page.screenshot({ path: narrowSettingsScreenshot, animations: 'disabled' });
  report.captures.push({ id: 'assistant-settings-1024x720', screenshotPath: narrowSettingsScreenshot, metrics: identityMetrics });
  await context.close();

  for (const comparison of [
    {
      id: 'comparison-welcome',
      title: 'Codia 新聊天页视觉对照',
      sourceLabel: '需求参考图',
      implementationLabel: '当前实现 · 1440 × 900',
      sourcePath: 'C:\\Users\\BAIQIA~1\\AppData\\Local\\Temp\\codex-clipboard-7115c6c0-337d-49e3-8d9c-f0f3ebd62c0c.png',
      implementationPath: path.join(outputDir, 'welcome-1440x900.png'),
      outputName: 'comparison-welcome.png',
    },
    {
      id: 'comparison-assistant-settings',
      title: 'Codia 助手配置页视觉对照',
      sourceLabel: '版式参考图',
      implementationLabel: '当前实现 · 保留 Codia 品牌与真实数据',
      sourcePath: 'C:\\Users\\BAIQIA~1\\AppData\\Local\\Temp\\codex-clipboard-b3c8ff82-d8bf-4d7b-bcc4-f744ed982b00.png',
      implementationPath: path.join(outputDir, 'assistant-settings-1280x800.png'),
      outputName: 'comparison-assistant-settings.png',
    },
  ]) {
    const comparisonCapture = await captureComparisonBoard(browser, comparison);
    if (comparisonCapture) report.captures.push(comparisonCapture);
  }

  fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[codia-layout-qa] captured ${report.captures.length} states in ${outputDir}`);
  if (report.consoleErrors.length || report.httpErrors.length) throw new Error('Visual QA observed errors; see report.json');
} catch (error) {
  report.error = error.message;
  throw error;
} finally {
  report.mockRequestCount = runtime.mock.requests.length;
  fs.writeFileSync(path.join(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'runtime.log'), runtime.logs());
  await browser?.close();
  await runtime.close();
}

function watchPage(page, target) {
  page.on('pageerror', error => report.consoleErrors.push({ target, message: error.message }));
  page.on('console', message => {
    if (message.type() === 'error') report.consoleErrors.push({
      target,
      message: message.text(),
      location: message.location(),
    });
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      report.httpErrors.push({ target, status: response.status(), url: response.url() });
    }
  });
}

async function captureComparisonBoard(browserInstance, {
  id,
  title,
  sourceLabel,
  implementationLabel,
  sourcePath,
  implementationPath,
  outputName,
}) {
  if (!fs.existsSync(sourcePath) || !fs.existsSync(implementationPath)) return null;

  const htmlPath = path.join(outputDir, `${id}.html`);
  const comparisonPath = path.join(outputDir, outputName);
  const sourceUrl = pathToFileURL(sourcePath).href;
  const implementationUrl = pathToFileURL(implementationPath).href;
  fs.writeFileSync(htmlPath, `<!doctype html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px; color: #342740; background: #f5f0fb; font: 15px system-ui, sans-serif; }
  h1 { margin: 0 0 18px; font-size: 22px; }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  figure { margin: 0; padding: 14px; border: 1px solid #ded4eb; border-radius: 16px; background: #fff; box-shadow: 0 10px 26px rgba(64, 42, 84, .08); }
  figcaption { margin-bottom: 10px; font-weight: 650; }
  img { display: block; width: 100%; height: 720px; object-fit: contain; object-position: top center; background: #faf8fd; border-radius: 10px; }
</style>
<h1>${title}</h1>
<main>
  <figure><figcaption>${sourceLabel}</figcaption><img src="${sourceUrl}"></figure>
  <figure><figcaption>${implementationLabel}</figcaption><img src="${implementationUrl}"></figure>
</main>`);

  const context = await browserInstance.newContext({ viewport: { width: 1800, height: 830 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.screenshot({ path: comparisonPath, animations: 'disabled' });
  await context.close();
  return {
    id,
    width: 1800,
    height: 830,
    deviceScaleFactor: 1,
    screenshotPath: comparisonPath,
    sourcePath,
    implementationPath,
  };
}

async function authenticate(page) {
  await page.goto(`${baseUrl}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => (
    Boolean(document.querySelector('[aria-label="Codia 小豆蔻"]'))
    || Boolean(document.querySelector('.pwa-login-card input'))
  ), undefined, { timeout: 15_000 });
  const accessKey = page.locator('.pwa-login-card input').first();
  if (await accessKey.isVisible().catch(() => false)) {
    await accessKey.fill(token);
    await page.locator('.pwa-login-card button[type="submit"]').click();
    await page.waitForLoadState('networkidle');
  }
}

async function freezeMascot(page, gaze) {
  await page.evaluate((requestedGaze) => {
    const frame = document.querySelector('[data-codia-mascot-frame]');
    const motion = frame?.querySelector('[class*="codiaMascotMotion"]');
    const sprite = frame?.querySelector('[class*="codiaMascotSprite"]');
    if (!(motion instanceof HTMLElement) || !(sprite instanceof HTMLElement)) return;
    const offsets = { center: '0', left: '-33.333333%', right: '-66.666667%' };
    motion.style.animation = 'none';
    motion.style.transform = 'translateY(0)';
    sprite.style.animation = 'none';
    sprite.style.transform = `translateX(${offsets[requestedGaze] || offsets.center})`;
  }, gaze);
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ headless: true, channel });
      } catch {
        // Try the next installed browser channel.
      }
    }
    throw bundledError;
  }
}
