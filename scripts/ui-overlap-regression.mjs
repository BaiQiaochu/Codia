#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/ui-overlap-regression.mjs [options]

Options:
  --report=<path>       JSON report path, default artifacts/ui-overlap-regression/report.json
  --screenshots=<dir>   Screenshot output directory, default artifacts/ui-overlap-regression
  --skip-missing-browser Exit 0 with a skipped report when Playwright Chromium is not installed
  --json                Print the JSON report to stdout
`);
  process.exit(0);
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const reportPath = resolveOutput(valueArg("--report") || "artifacts/ui-overlap-regression/report.json");
const screenshotsDir = resolveOutput(valueArg("--screenshots") || "artifacts/ui-overlap-regression");
const fixtureDir = path.join(screenshotsDir, "fixtures");
const failureCropsDir = path.join(screenshotsDir, "failure-crops");
const jsonOnly = args.includes("--json");
const skipMissingBrowser = args.includes("--skip-missing-browser");
const MISSING_BROWSER_EXIT_CODE = 78;
const thresholds = {
  horizontalOverflowPx: 1,
  boxMinWidth: 24,
  boxMinHeight: 20,
  overlapArea: 8,
  textOverflowPx: 1,
};

const cssLinks = [
  "desktop/src/styles.css",
  "desktop/src/react/settings/Settings.module.css",
  "desktop/src/react/components/input/InputArea.module.css",
  "desktop/src/react/components/channels/Channels.module.css",
].map((relPath) => pathToFileURL(path.join(ROOT, relPath)).href);

const surfaces = [
  { id: "settings", file: "settings.png", width: 960, height: 720, body: settingsSurface },
  { id: "reader", file: "reader.png", width: 1180, height: 760, body: readerSurface },
  { id: "chat", file: "chat.png", width: 920, height: 680, body: chatSurface },
  { id: "workflow", file: "workflow.png", width: 1366, height: 900, body: workflowSurface },
];

const report = {
  ok: false,
  generatedAt: new Date().toISOString(),
  screenshotsDir: slash(path.relative(ROOT, screenshotsDir)),
  browserRuntime: null,
  thresholds,
  surfaces: [],
  blockers: [],
  skipped: [],
};

let browser;
try {
  const { chromium } = await import("playwright");
  browser = await launchChromium(chromium);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const missingBrowser = isMissingBrowserRuntime(message);
  if (missingBrowser && skipMissingBrowser) {
    report.skipped.push({
      surface: "runtime",
      kind: "playwright-runtime",
      message: runtimeMessage(message),
      detail: message,
    });
    finish(0);
  }
  report.blockers.push({
    surface: "runtime",
    kind: "playwright-runtime",
    message: runtimeMessage(message),
    detail: message,
  });
  finish(missingBrowser ? MISSING_BROWSER_EXIT_CODE : 1);
}

try {
  fs.rmSync(screenshotsDir, { recursive: true, force: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const context = await browser.newContext({ deviceScaleFactor: 1 });

  for (const surface of surfaces) {
    const result = await auditSurface(context, surface);
    report.surfaces.push(result);
    report.blockers.push(...result.blockers);
  }

  await context.close();
} finally {
  await browser?.close().catch(() => {});
}

finish(report.blockers.length === 0 ? 0 : 1);

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
  const error = new Error([
    "Playwright could not start a Chromium runtime.",
    "Tried bundled Chromium and installed browser channels.",
    ...failures.map((failure) => `- ${failure}`),
  ].join("\n"));
  throw error;
}

async function auditSurface(context, surface) {
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const screenshotPath = path.join(screenshotsDir, surface.file);
  const result = {
    id: surface.id,
    viewport: { width: surface.width, height: surface.height },
    screenshot: slash(path.relative(ROOT, screenshotPath)),
    blockers: [],
  };

  try {
    await page.setViewportSize({ width: surface.width, height: surface.height });
    const fixturePath = writeFixture(surface);
    await page.goto(pathToFileURL(fixturePath).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(80);

    const domReport = await page.evaluate(runDomAudit);
    for (const item of domReport.blockers) {
      result.blockers.push({ surface: surface.id, ...decorateBlockerGeometry(item) });
    }
    const crops = await captureBlockerCrops(page, surface, result.blockers);
    if (crops.length > 0) result.failureCrops = crops;

    await page.screenshot({ path: screenshotPath, fullPage: true, animations: "disabled" });
  } catch (error) {
    result.blockers.push({
      surface: surface.id,
      kind: "render-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    for (const message of consoleErrors.slice(0, 5)) {
      result.blockers.push({ surface: surface.id, kind: "console-error", message });
    }
    await page.close().catch(() => {});
  }

  return result;
}

function writeFixture(surface) {
  fs.mkdirSync(fixtureDir, { recursive: true });
  const fixturePath = path.join(fixtureDir, `${surface.id}.html`);
  fs.writeFileSync(fixturePath, buildDocument(surface), "utf-8");
  return fixturePath;
}

function buildDocument(surface) {
  return `<!doctype html>
<html lang="zh-CN" data-theme="studio-light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${cssLinks.map((href) => `<link rel="stylesheet" href="${href}" />`).join("\n  ")}
  <style>${fixtureCss()}</style>
</head>
<body class="no-paper-texture ui-overlap-body">
  <main class="ui-overlap-page" data-ui-surface="${surface.id}">
    ${surface.body()}
  </main>
</body>
</html>`;
}

function settingsSurface() {
  return `
<section class="ui-surface-card ui-settings-shell">
  <header class="ui-surface-title" data-layout-box="settings-header">
    <span data-no-overflow>设置</span>
    <strong data-no-overflow>界面</strong>
  </header>
  <div class="settings-body settings-panel-modal ui-settings-body">
    <nav class="settings-nav" data-layout-box="settings-nav">
      ${["助手", "我", "界面", "AI 桌宠", "工作空间", "使用电脑", "技能", "插件", "安全", "关于"].map((item, index) => (
        `<button class="settings-nav-item${index === 2 ? " active" : ""}" data-no-overflow>${item}</button>`
      )).join("")}
    </nav>
    <section class="settings-main settings-main-wide" data-layout-box="settings-main">
      <h1 class="settings-tab-title">界面</h1>
      <div class="settings-tab-content">
        <section class="settings-section">
          <h2 class="settings-section-title">编辑器</h2>
          <div class="ui-setting-list">
            ${[
              ["正文字号", "20", "px"],
              ["一级标题字号", "28", "px"],
              ["三级标题字号", "18", "px"],
              ["行高", "1.72", ""],
              ["内容边距", "24", "px"],
            ].map(([label, value, unit]) => settingRow(label, value, unit)).join("")}
          </div>
        </section>
        <section class="settings-section">
          <h2 class="settings-section-title">系统</h2>
          <div class="ui-setting-list">
            ${settingRow("硬件加速", "开启", "")}
            ${settingRow("语言", "简体中文", "")}
          </div>
        </section>
      </div>
    </section>
  </div>
</section>`;
}

function settingRow(label, value, unit) {
  return `<div class="ui-setting-row" data-no-overflow>
    <div><strong>${escapeHtml(label)}</strong><span>用于文档和阅读器显示。</span></div>
    <label><input value="${escapeAttr(value)}" aria-label="${escapeAttr(label)}" />${escapeHtml(unit)}</label>
  </div>`;
}

function readerSurface() {
  return `
<section class="ui-reader-shell">
  <article class="ui-reader-document" data-layout-box="reader-document">
    <div class="ui-reader-image" data-layout-box="reader-image"></div>
    <h1>飞翔小鸟网页 设计规范</h1>
    <p>目标：纯 HTML + CSS 实现页面，并在编辑模式保持图片可见。</p>
    <h2>视觉设计 image</h2>
    <p>阅读器内容区域独立滚动，右侧聊天区和底部输入框不会覆盖正文。</p>
  </article>
  <aside class="gsap-reader-chat ui-reader-chat" data-layout-box="reader-chat">
    <div class="gsap-reader-chat-timeline ui-reader-timeline" data-layout-box="reader-timeline">
      <div class="ui-chat-bubble">已打开当前文档，可继续提问。</div>
      <div class="ui-chat-bubble muted">图片节点已经载入。</div>
    </div>
    <div class="gsap-reader-chat-input" data-layout-box="reader-input">
      ${inputFixture("reader")}
    </div>
  </aside>
</section>`;
}

function chatSurface() {
  return `
<section class="ui-chat-shell">
  <div class="ui-chat-thread" data-layout-box="chat-thread">
    <div class="ui-chat-bubble">当前会话正在处理。</div>
    <div class="ui-chat-bubble muted">新的问题会自动加入待执行队列。</div>
  </div>
  <div class="ui-chat-input" data-layout-box="chat-input">
    ${queueFixture()}
    ${inputFixture("chat")}
  </div>
</section>`;
}

function workflowSurface() {
  return `
<section class="workflowWindowOverlay ui-workflow-static">
  <div class="workflowWindowPanel" data-layout-box="workflow-panel">
    <header class="workflowWindowHeader" data-layout-box="workflow-header">
      <div>
        <div class="workflowWindowKicker">G-SAP 工作流画布</div>
        <div class="workflowWindowTitle" data-no-overflow># 工作群</div>
      </div>
      <div class="workflowWindowActions">
        <button class="workflowWindowButton workflowWindowRunButton" type="button" data-no-overflow>执行</button>
        <button class="workflowWindowButton" type="button" data-no-overflow>刷新</button>
        <button class="workflowWindowClose" type="button" aria-label="关闭">×</button>
      </div>
    </header>
    <div class="workflowWindowToolbar" data-layout-box="workflow-toolbar">
      <div class="workflowStageRail">
        ${["输入|38 条消息", "调度|待触发", "Agent 执行|5 个成员", "任务 / 回报|0/23 完成"].map(workflowStage).join("")}
      </div>
      <div class="workflowZoomControls" aria-label="缩放">
        <button type="button">75%</button><button type="button">100%</button><button class="workflowZoomActive" type="button">125%</button>
      </div>
    </div>
    <div class="workflowWindowMain" data-layout-box="workflow-main">
      <div class="workflowWindowCanvasScroll" data-layout-box="workflow-canvas">
        <div class="workflowCanvasStage" style="width:1160px;height:680px">
          <div class="workflowCanvas" style="width:1160px;height:680px">
            <svg class="workflowEdges" width="1160" height="680" aria-hidden="true">
              <path class="workflowEdge" data-state="done" d="M260 180 C330 180 330 180 400 180" />
              <path class="workflowEdge" data-state="running" d="M610 180 C680 180 680 120 750 120" />
              <path class="workflowEdge" d="M610 180 C690 180 690 292 770 292" />
            </svg>
            ${workflowNode("输入", "频道输入", "完成", 100, 140, "input", "done")}
            ${workflowNode("调度", "调度器", "等待", 420, 140, "scheduler", "idle")}
            ${workflowNode("Agent", "管理员A", "运行", 780, 82, "agent", "running")}
            ${workflowNode("任务", "图片节点 1", "等待", 780, 254, "task", "idle")}
          </div>
        </div>
      </div>
      <aside class="workflowInspector" data-layout-box="workflow-inspector">
        <div class="workflowInspectorSection">
          <div class="workflowInspectorTitle">执行概览</div>
          <div class="workflowInspectorGrid"><span>节点 <strong>24</strong></span><span>任务 <strong>23</strong></span><span>活动 <strong>0</strong></span><span>异常 <strong>0</strong></span></div>
        </div>
        <div class="workflowInspectorSection">
          <div class="workflowInspectorTitle">图例</div>
          <div class="workflowLegend"><span data-state="running"><i></i>运行</span><span data-state="done"><i></i>完成</span><span data-state="idle"><i></i>等待</span></div>
        </div>
      </aside>
    </div>
  </div>
</section>`;
}

function workflowStage(value) {
  const [label, detail] = value.split("|");
  return `<div class="workflowStage"><span>${escapeHtml(label)}</span><strong data-no-overflow>${escapeHtml(detail)}</strong></div>`;
}

function workflowNode(kind, title, stateLabel, x, y, nodeKind, state) {
  return `<div class="workflowNode" data-kind="${nodeKind}" data-state="${state}" style="left:${x}px;top:${y}px;width:210px;min-height:92px">
    <span class="workflowNodePort workflowNodePortIn" aria-hidden="true"></span>
    <span class="workflowNodePort workflowNodePortOut" aria-hidden="true"></span>
    <div class="workflowNodeTop">
      <span class="workflowNodeAvatar">${escapeHtml(kind[0])}</span>
      <span class="workflowNodeTitleWrap"><span class="workflowNodeKind">${escapeHtml(kind)}</span><strong class="workflowNodeTitle" data-no-overflow>${escapeHtml(title)}</strong><span class="workflowNodeSubtitle">等待频道调度</span></span>
      <span class="workflowNodeState">${escapeHtml(stateLabel)}</span>
    </div>
    <div class="workflowNodeMeta">Agent Phone</div>
  </div>`;
}

function queueFixture() {
  return `<div class="prompt-queue-panel" data-layout-box="chat-queue">
    <div class="prompt-queue-header"><div class="prompt-queue-title"><span class="prompt-queue-dot"></span><span>待执行队列</span><span class="prompt-queue-count">2</span></div><div class="prompt-queue-toolbar"><button class="prompt-queue-run">执行</button><button class="prompt-queue-clear">清空</button></div></div>
    <div class="prompt-queue-list"><div class="prompt-queue-item"><span class="prompt-queue-index">1</span><span class="prompt-queue-text">继续处理图片节点</span><span class="prompt-queue-state">等待</span><span class="prompt-queue-actions"><button class="prompt-queue-icon-btn">×</button></span></div></div>
  </div>`;
}

function inputFixture(surface) {
  const readerClass = surface === "reader" ? " input-surface-reader" : "";
  return `<div class="input-surface${readerClass}">
    <div class="input-wrapper">
      <div class="input-box"><div class="tiptap">输入额外问题</div></div>
      <div class="input-bottom-bar">
        <div class="input-actions">
          <button class="attach-btn" type="button" aria-label="添加">+</button>
          <button class="attach-btn" type="button" aria-label="命令">◇</button>
          <button class="plan-mode-btn" type="button" data-no-overflow>自动操作</button>
        </div>
        <div class="input-controls">
          <button class="context-ring-btn" type="button" aria-label="上下文">?</button>
          <button class="model-pill" type="button" data-no-overflow>DeepSeek V4 Pro</button>
          <button class="send-btn" type="button" data-no-overflow>发送</button>
        </div>
      </div>
    </div>
  </div>`;
}

function fixtureCss() {
  return `
html,
body {
  width: 100%;
  min-height: 100%;
  margin: 0;
  overflow: hidden;
}
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-ui, system-ui, sans-serif);
}
button,
input {
  font: inherit;
}
.ui-overlap-page {
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  padding: 24px;
}
.ui-surface-card {
  height: 100%;
  min-height: 0;
  border: 1px solid var(--overlay-medium);
  border-radius: 8px;
  background: var(--bg-card);
  box-shadow: 0 16px 40px var(--shadow);
  overflow: hidden;
}
.ui-surface-title {
  min-height: 54px;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 18px;
  border-bottom: 1px solid var(--overlay-light);
}
.ui-surface-title span {
  font-weight: 700;
}
.ui-settings-body {
  height: calc(100% - 55px);
}
.ui-setting-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--overlay-light);
  border-radius: 8px;
  overflow: hidden;
}
.ui-setting-row {
  min-height: 48px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--overlay-light);
}
.ui-setting-row:last-child {
  border-bottom: 0;
}
.ui-setting-row div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ui-setting-row strong,
.ui-setting-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ui-setting-row span {
  color: var(--text-muted);
  font-size: 0.72rem;
}
.ui-setting-row label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 0.76rem;
}
.ui-setting-row input {
  width: 58px;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  border: 1px solid var(--overlay-medium);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  text-align: right;
}
.ui-reader-shell {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 360px);
  gap: 16px;
}
.ui-reader-document,
.ui-reader-chat,
.ui-chat-thread,
.ui-chat-input {
  min-width: 0;
  border: 1px solid var(--overlay-light);
  border-radius: 8px;
  background: var(--bg-card);
  box-shadow: 0 8px 22px var(--shadow);
}
.ui-reader-document {
  min-height: 0;
  overflow: auto;
  padding: 20px;
}
.ui-reader-image {
  height: 220px;
  border: 1px solid var(--overlay-light);
  border-radius: 6px;
  background:
    radial-gradient(circle at 50% 45%, rgba(var(--accent-rgb), 0.36), transparent 24%),
    linear-gradient(135deg, rgba(var(--accent-rgb), 0.14), transparent 62%),
    var(--bg);
}
.ui-reader-document h1 {
  margin: 18px 0 10px;
  font-size: 1.4rem;
}
.ui-reader-document p {
  color: var(--text-muted);
  line-height: 1.75;
}
.ui-reader-chat {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ui-reader-timeline {
  min-height: 0;
  overflow: auto;
  padding: 12px;
}
.ui-chat-bubble {
  max-width: 84%;
  margin-bottom: 10px;
  padding: 9px 11px;
  border-radius: 8px;
  background: var(--overlay-subtle);
}
.ui-chat-bubble.muted {
  color: var(--text-muted);
}
.ui-chat-shell {
  height: 100%;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  gap: 16px;
}
.ui-chat-thread {
  overflow: auto;
  padding: 16px;
}
.ui-chat-input {
  padding: 12px;
}
.input-box {
  min-height: 42px;
  color: var(--text-muted);
}
.plan-mode-btn,
.context-ring-btn,
.model-pill,
.send-btn {
  min-height: 24px;
  border: 1px solid rgba(var(--accent-rgb), 0.14);
  border-radius: 6px;
  background: var(--bg-card);
  color: var(--text);
}
.plan-mode-btn,
.model-pill,
.send-btn {
  padding: 0 8px;
}
.context-ring-btn {
  width: 24px;
}
.ui-workflow-static {
  position: static;
  width: 100%;
  height: 100%;
  padding: 0;
  background: transparent;
  backdrop-filter: none;
}
.ui-workflow-static .workflowWindowPanel {
  width: 100%;
  height: 100%;
}
@media (max-width: 720px) {
  .ui-overlap-page {
    padding: 12px;
  }
  .ui-reader-shell {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .ui-reader-chat {
    min-height: 260px;
  }
}
`;
}

async function captureBlockerCrops(page, surface, blockers) {
  const crops = [];
  const viewport = page.viewportSize() || { width: surface.width, height: surface.height };
  for (let index = 0; index < blockers.length; index += 1) {
    const blocker = blockers[index];
    const boundingBox = blocker.boundingBox || blocker.rect || unionRects(blocker.rects || []);
    if (boundingBox && !blocker.boundingBox) blocker.boundingBox = boundingBox;
    const cropRect = normalizeCropRect(boundingBox, viewport);
    if (!cropRect) continue;
    const fileName = `${surface.id}-${String(index + 1).padStart(2, "0")}-${safeFilePart(blocker.kind)}.png`;
    const cropPath = path.join(failureCropsDir, fileName);
    fs.mkdirSync(path.dirname(cropPath), { recursive: true });
    await page.screenshot({ path: cropPath, clip: cropRect, animations: "disabled" });
    blocker.crop = slash(path.relative(ROOT, cropPath));
    blocker.cropRect = cropRect;
    crops.push(blocker.crop);
  }
  return crops;
}

function decorateBlockerGeometry(blocker) {
  const boundingBox = blocker.rect || unionRects(blocker.rects || []);
  return {
    ...blocker,
    ...(boundingBox ? { boundingBox } : {}),
    ...(Array.isArray(blocker.rects) ? { boundingBoxes: blocker.rects } : {}),
  };
}

function unionRects(rects) {
  const valid = rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);
  if (valid.length === 0) return null;
  const left = Math.min(...valid.map((rect) => rect.left));
  const top = Math.min(...valid.map((rect) => rect.top));
  const right = Math.max(...valid.map((rect) => rect.right));
  const bottom = Math.max(...valid.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function normalizeCropRect(rect, viewport) {
  if (!rect) return null;
  const padding = 12;
  const x = Math.max(0, Math.floor(rect.left - padding));
  const y = Math.max(0, Math.floor(rect.top - padding));
  const right = Math.min(viewport.width, Math.ceil(rect.right + padding));
  const bottom = Math.min(viewport.height, Math.ceil(rect.bottom + padding));
  const width = Math.max(0, right - x);
  const height = Math.max(0, bottom - y);
  if (width < 4 || height < 4) return null;
  return { x, y, width, height };
}

function safeFilePart(value) {
  return String(value || "blocker").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "blocker";
}

function runDomAudit() {
  const thresholds = {
    horizontalOverflowPx: 1,
    boxMinWidth: 24,
    boxMinHeight: 20,
    overlapArea: 8,
    textOverflowPx: 1,
  };
  const blockers = [];
  const html = document.documentElement;
  if (html.scrollWidth > html.clientWidth + thresholds.horizontalOverflowPx) {
    blockers.push({
      kind: "document-horizontal-overflow",
      message: `document scrollWidth ${html.scrollWidth} exceeds clientWidth ${html.clientWidth}`,
      threshold: thresholds.horizontalOverflowPx,
      selector: "html",
      rect: rectObject(html.getBoundingClientRect()),
    });
  }

  const boxes = Array.from(document.querySelectorAll("[data-layout-box]")).map((el) => ({
    key: el.getAttribute("data-layout-box"),
    el,
    selector: selectorFor(el),
    rect: rectObject(el.getBoundingClientRect()),
  }));

  for (const box of boxes) {
    if (box.rect.width < thresholds.boxMinWidth || box.rect.height < thresholds.boxMinHeight) {
      blockers.push({
        kind: "collapsed-box",
        key: box.key,
        message: `${box.key} is ${Math.round(box.rect.width)}x${Math.round(box.rect.height)}`,
        selector: box.selector,
        rect: box.rect,
        threshold: { width: thresholds.boxMinWidth, height: thresholds.boxMinHeight },
      });
    }
  }

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (boxes[i].el.contains(boxes[j].el) || boxes[j].el.contains(boxes[i].el)) continue;
      const overlap = overlapArea(boxes[i].rect, boxes[j].rect);
      if (overlap > thresholds.overlapArea) {
        blockers.push({
          kind: "layout-overlap",
          message: `${boxes[i].key} overlaps ${boxes[j].key} by ${Math.round(overlap)}px`,
          selector: `${boxes[i].selector} <> ${boxes[j].selector}`,
          selectors: [boxes[i].selector, boxes[j].selector],
          overlap,
          threshold: thresholds.overlapArea,
          rects: [boxes[i].rect, boxes[j].rect],
        });
      }
    }
  }

  for (const el of document.querySelectorAll("[data-no-overflow]")) {
    if (el.scrollWidth > el.clientWidth + thresholds.textOverflowPx || el.scrollHeight > el.clientHeight + thresholds.textOverflowPx) {
      blockers.push({
        kind: "text-overflow",
        message: `${labelFor(el)} overflows its container`,
        selector: selectorFor(el),
        rect: rectObject(el.getBoundingClientRect()),
        threshold: thresholds.textOverflowPx,
        scroll: {
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        },
      });
    }
  }

  return { blockers };

  function rectObject(rect) {
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
  }

  function overlapArea(a, b) {
    const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return width * height;
  }

  function labelFor(el) {
    return el.getAttribute("data-layout-box") || el.textContent.trim().replace(/\s+/g, " ").slice(0, 48) || el.tagName.toLowerCase();
  }

  function selectorFor(el) {
    const layout = el.getAttribute("data-layout-box");
    if (layout) return `[data-layout-box="${escapeAttr(layout)}"]`;
    if (el.id) return `#${escapeCss(el.id)}`;
    const className = String(el.className || "").trim().split(/\s+/).filter(Boolean)[0];
    if (className) return `${el.tagName.toLowerCase()}.${escapeCss(className)}`;
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const index = Array.from(parent.children).filter((child) => child.tagName === el.tagName).indexOf(el) + 1;
    return `${selectorFor(parent)} > ${el.tagName.toLowerCase()}:nth-of-type(${index})`;
  }

  function escapeAttr(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function escapeCss(value) {
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
  }
}

function finish(exitCode) {
  report.ok = report.blockers.length === 0;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  if (jsonOnly) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[ui-overlap-regression] surfaces=${report.surfaces.length} blockers=${report.blockers.length}`);
    for (const item of report.skipped || []) {
      console.warn(`${item.surface}: skipped ${item.kind}: ${item.message}`);
    }
    for (const blocker of report.blockers.slice(0, 20)) {
      const selector = blocker.selector ? ` selector=${blocker.selector}` : "";
      const boundingBox = blocker.boundingBox ? ` boundingBox=${formatRect(blocker.boundingBox)}` : "";
      const crop = blocker.crop ? ` crop=${blocker.crop}` : "";
      console.error(`${blocker.surface}: ${blocker.kind}: ${blocker.message}${selector}${boundingBox}${crop}`);
    }
    console.log(`[ui-overlap-regression] screenshots: ${slash(path.relative(ROOT, screenshotsDir))}`);
    console.log(`[ui-overlap-regression] report: ${slash(path.relative(ROOT, reportPath))}`);
  }
  process.exit(exitCode);
}

function formatRect(rect) {
  return `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)}`;
}

function runtimeMessage(message) {
  if (isMissingBrowserRuntime(message)) {
    return "Playwright Chromium runtime is missing. Run `npx playwright install chromium` and retry.";
  }
  if (/Cannot find package|Cannot find module/i.test(message)) {
    return "Playwright package is missing. Run `npm install` and retry.";
  }
  return "Playwright could not start Chromium.";
}

function isMissingBrowserRuntime(message) {
  return /Executable doesn't exist|browser.*not.*found|playwright install|chromium_headless_shell|chrome-headless-shell/i.test(message);
}

function isMissingHeadlessShell(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /chromium_headless_shell|chrome-headless-shell|Executable doesn't exist/i.test(message);
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

function valueArg(name) {
  const match = args.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : null;
}

function resolveOutput(target) {
  return path.resolve(ROOT, target);
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
