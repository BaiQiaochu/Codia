#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import WebSocket from "ws";
import {
  createIsolatedE2EHome,
  getAvailablePort,
  removeE2EHome,
  startMockOpenAI,
} from "./e2e-env.mjs";
import { desktopLaunchCommand, desktopLaunchEnv } from "./e2e-desktop-launcher.mjs";

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, "artifacts", process.env.GSAP_GPU_SAFE_MODE === "1" ? "desktop-full-smoke-gpu-safe" : "desktop-full-smoke");
const REPORT_PATH = path.join(ARTIFACT_DIR, "report.json");
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, "workflow.png");
const LAYOUT_1440_PATH = path.join(ARTIFACT_DIR, "layout-1440x900.png");
const LAYOUT_1280_PATH = path.join(ARTIFACT_DIR, "layout-1280x800-125.png");
const SKILLS_PANEL_PATH = path.join(ARTIFACT_DIR, "skills-panel.png");
const TOOL_MENU_PATH = path.join(ARTIFACT_DIR, "workspace-tool-menu.png");
const WORKFLOW_TEMPLATE_PREVIEW_PATH = path.join(ARTIFACT_DIR, "workflow-template-preview.png");
const WORKFLOW_TEMPLATE_FAILURE_PATH = path.join(ARTIFACT_DIR, "workflow-template-failure.png");
const MOCK_REPLY = "Codia desktop full smoke mock response.";
let capturedStdout = "";
let capturedStderr = "";
let visualToolOutputDir = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs = 30_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(250);
  }
}

async function listTargets(remoteDebugPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/list`);
    return response.ok ? await response.json() : [];
  } catch {
    return [];
  }
}

function createCdpClient(wsUrl, exceptions = []) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (!message.id) {
      if (message.method === "Runtime.exceptionThrown") {
        exceptions.push(message.params?.exceptionDetails?.exception?.description || message.params?.exceptionDetails?.text || "renderer exception");
      }
      return;
    }
    const ticket = pending.get(message.id);
    if (!ticket) return;
    pending.delete(message.id);
    if (message.error) ticket.reject(new Error(message.error.message || "CDP error"));
    else ticket.resolve(message.result);
  });

  async function send(method, params = {}) {
    await ready;
    const requestId = ++id;
    const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    ws.send(JSON.stringify({ id: requestId, method, params }));
    return result;
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Runtime.evaluate failed");
    return result.result?.value;
  }

  return { ready, send, evaluate, close: () => ws.close() };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      return;
    } catch {}
  }
  try { child.kill("SIGKILL"); } catch {}
}

async function selectSidebarDestination(cdp, label) {
  await cdp.evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.codia-primary-nav button'))
      .find((item) => (item.textContent || '').trim().startsWith(${JSON.stringify(label)}));
    if (!button) throw new Error('sidebar destination missing: ${label}');
    button.click();
  })()`);
}

async function readChatLayout(cdp) {
  return await cdp.evaluate(`(() => {
    const input = document.querySelector('.input-area:not(.hidden)');
    const editor = input?.querySelector('[contenteditable="true"]');
    const send = input?.querySelector('button[class*="send-btn"]');
    const rect = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; })() : null;
    return {
      viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio },
      input: rect(input), editor: rect(editor), send: rect(send),
      navMenuCount: Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).filter((button) => (button.getAttribute('aria-label') || '').includes('页面导航')).length,
      duplicateLabels: document.body.innerText.includes('模式：') || document.body.innerText.includes('页面：'),
      brandVisible: Array.from(document.querySelectorAll('*')).some((node) => node.children.length === 0 && (node.textContent || '').trim() === 'Codia' && node.getBoundingClientRect().width > 0),
    };
  })()`);
}

function assertChatLayout(layout, label) {
  if (layout.navMenuCount !== 0) throw new Error(`${label}: expected no titlebar navigation menu, got ${layout.navMenuCount}`);
  if (layout.duplicateLabels) throw new Error(`${label}: duplicate mode/page labels are visible`);
  if (!layout.brandVisible) throw new Error(`${label}: Codia brand is not visible`);
  for (const [name, rect] of Object.entries({ input: layout.input, editor: layout.editor, send: layout.send })) {
    if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`${label}: ${name} is not visible`);
    if (rect.top < 0 || rect.bottom > layout.viewport.height + 1) throw new Error(`${label}: ${name} is outside viewport`);
  }
}

async function checkWelcomeLive2D(cdp, checks) {
  const gpu = await cdp.evaluate("(window.gsap || window.platform).getGpuRuntimeState()");
  const expectedRenderer = gpu.gpuSafeMode || !gpu.hardwareAccelerationEnabled ? "fallback" : "live2d";
  const readMascot = () => cdp.evaluate(`(() => {
    const mascot = document.querySelector('[data-codia-renderer]');
    if (!mascot) return null;
    const rect = node => { const r = node?.getBoundingClientRect(); return r ? { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height } : null; };
    const canvas = mascot.querySelector('canvas');
    const fallback = mascot.querySelector('[data-codia-mascot-frame]');
    return {
      renderer: mascot.getAttribute('data-codia-renderer'), error: mascot.getAttribute('data-codia-load-error'),
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      viewport: { width:innerWidth, height:innerHeight, scale:devicePixelRatio },
      bounds: rect(mascot), canvas: rect(canvas),
      canvasBuffer: { width:canvas?.width, height:canvas?.height },
      canvasVisible: Boolean(canvas && getComputedStyle(canvas).visibility === 'visible'),
      fallbackVisible: Boolean(fallback && fallback.getBoundingClientRect().width > 0 && !fallback.closest('[hidden]')),
      insideSpriteClip: Boolean(mascot.closest('[data-codia-mascot-frame]')),
    };
  })()`);
  await waitFor(async () => {
    const state = await readMascot();
    if (state?.error && expectedRenderer === "live2d") throw new Error(`Live2D startup failed: ${state.error}`);
    return state?.renderer === expectedRenderer;
  }, `welcome ${expectedRenderer} renderer`, 45_000);
  // Hold the fully raised pose for reproducible layout screenshots, instead of
  // occasionally capturing the intentional hidden phase of the peek animation.
  await cdp.send("Emulation.setEmulatedMedia", { features:[{ name:"prefers-reduced-motion", value:"reduce" }] });
  for (const size of [
    { name:"1440x900", width:1440, height:900, deviceScaleFactor:1 },
    { name:"1280x800", width:1280, height:800, deviceScaleFactor:1 },
    // 1280x800 physical pixels at 125% scaling gives 1024x640 CSS pixels.
    { name:"1280x800-125", width:1024, height:640, deviceScaleFactor:1.25 },
  ]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width:size.width, height:size.height, deviceScaleFactor:size.deviceScaleFactor, mobile:false });
    await sleep(800);
    const layout = await readChatLayout(cdp);
    assertChatLayout(layout, `welcome ${size.name}`);
    const state = await readMascot();
    if (state.renderer !== expectedRenderer || state.insideSpriteClip) throw new Error(`welcome renderer mismatch: ${JSON.stringify(state)}`);
    if (state.bounds.width > 0 && (expectedRenderer === "live2d" ? !state.canvasVisible || state.fallbackVisible : !state.fallbackVisible || state.canvasVisible)) {
      throw new Error(`welcome renderer visibility mismatch: ${JSON.stringify(state)}`);
    }
    if (state.bounds.width > 0 && (state.bounds.width < 105 || state.bounds.width > 201 || state.bounds.left < 0 || state.bounds.right > size.width || state.bounds.top < 0 || state.bounds.bottom > size.height)) {
      throw new Error(`welcome mascot outside size limits: ${JSON.stringify(state)}`);
    }
    const screenshotPath = path.join(ARTIFACT_DIR, `welcome-live2d-${size.name}.png`);
    const screenshot = await cdp.send("Page.captureScreenshot", { format:"png" });
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    checks.push({ name:`welcome-live2d-${size.name}`, ok:true, gpu, expectedRenderer, detail:state, layout,
      screenshot:path.relative(ROOT, screenshotPath).replace(/\\/g, "/") });
  }
  console.log(`[e2e-full-desktop-smoke] welcome ${expectedRenderer} verified at 3 sizes; gpu=${JSON.stringify(gpu)}`);
  await cdp.send("Emulation.setEmulatedMedia", { features:[] });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width:1440, height:900, deviceScaleFactor:1, mobile:false });
  // Restoring motion restarts the welcome CSS entrance animations. Let the last
  // staggered card settle before measuring row alignment in the full smoke.
  await sleep(1_000);
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
}

function requestedToolResponse({ body }) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages.at(-1);
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const prompt = messageText(lastUser);
  const offeredTools = new Set((body?.tools || []).map(tool => tool?.function?.name || tool?.name));

  if (last?.role === "tool") {
    return { reply: "可交互结果已显示在当前对话中。" };
  }
  if (prompt.includes("冒烟知识图谱") && offeredTools.has('knowledge-graph_build-graph')) {
    return {
      toolCall: {
        id: "call_e2e_knowledge_graph",
        name: "knowledge-graph_build-graph",
        arguments: {
          title: "Codia 冒烟知识图谱",
          text: "Codia 是工作台。聊天连接知识图谱。工作流连接 Agent 小队。",
          maxNodes: 12,
        },
      },
    };
  }
  if (prompt.includes("冒烟思维导图") && offeredTools.has('mind-map_build-mind-map')) {
    return {
      toolCall: {
        id: "call_e2e_mind_map",
        name: "mind-map_build-mind-map",
        arguments: {
          title: "Codia 冒烟思维导图",
          text: "# Codia\n## 聊天\n- 生成内容\n## 工作流\n- 编排任务\n## Agent 小队\n- 协作执行",
          name: "codia-smoke.xmind",
          outputDir: visualToolOutputDir,
        },
      },
    };
  }

  const systemText = messages.filter((message) => message?.role === "system").map(messageText).join("\n");
  if (systemText.includes("Generate a practical directed acyclic workflow")) {
    if (prompt.includes("模拟无效模板")) {
      return {
        reply: JSON.stringify({
          title: "无效模板",
          nodes: [{ id: "only", title: "唯一节点", prompt: "应被拒绝", agentId: "" }],
          edges: [],
        }),
      };
    }
    return {
      reply: JSON.stringify({
        title: "Codia 冒烟模板",
        nodes: [
          { id: "collect", title: "收集需求", prompt: "收集并整理用户需求", agentId: "" },
          { id: "review", title: "复核输出", prompt: "复核结果并形成摘要", agentId: "" },
        ],
        edges: [{ from: "collect", to: "review" }],
      }),
    };
  }
  if (systemText.includes("Create a concise mind map")) {
    return { reply: '{"title":"Codia 冒烟思维导图","topics":[{"title":"聊天","children":[]},{"title":"工作流","children":[]},{"title":"Agent 小队","children":[]}]}' };
  }
  return { reply: MOCK_REPLY };
}

function summarizeMockRequests(requests) {
  return requests.map((body, index) => {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const last = messages.at(-1);
    const lastUser = [...messages].reverse().find((message) => message?.role === "user");
    return {
      index,
      model: body?.model || null,
      lastRole: last?.role || null,
      lastText: messageText(last).slice(0, 240),
      lastUserText: messageText(lastUser).slice(0, 240),
      tools: Array.isArray(body?.tools)
        ? body.tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean)
        : [],
    };
  });
}

async function main() {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const remoteDebugPort = Number(process.env.GSAP_E2E_REMOTE_DEBUG_PORT || await getAvailablePort());
  const mockOpenAI = await startMockOpenAI({ reply: MOCK_REPLY, responseFactory: requestedToolResponse });
  const e2eHome = createIsolatedE2EHome({ mockBaseUrl: mockOpenAI.baseUrl });
  visualToolOutputDir = path.join(e2eHome, "generated");
  const exceptions = [];
  const checks = [];
  const launch = desktopLaunchCommand(ROOT, [`--remote-debugging-port=${remoteDebugPort}`, "--remote-allow-origins=*"]);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: desktopLaunchEnv({
      GSAP_HOME: e2eHome,
      GSAP_E2E: "1",
      GSAP_E2E_REMOTE_DEBUG_PORT: String(remoteDebugPort),
      GSAP_DESKTOP_SERVER_MODE: "dist",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { capturedStdout += String(chunk); });
  child.stderr.on("data", (chunk) => { capturedStderr += String(chunk); });
  console.log(`[e2e-full-desktop-smoke] isolated home=${e2eHome}; debugPort=${remoteDebugPort}; mock=${mockOpenAI.baseUrl}`);

  let cdp = null;
  let succeeded = false;
  try {
    const target = await waitFor(async () => (await listTargets(remoteDebugPort)).find((item) => item.type === "page" && String(item.url || "").includes("index.html")), "main Electron page", 120_000);
    cdp = createCdpClient(target.webSocketDebuggerUrl, exceptions);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await waitFor(() => cdp.evaluate("window.__GSAP_E2E__?.appReady === true"), "renderer ready", 60_000);

    await checkWelcomeLive2D(cdp, checks);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const initialLayout = await readChatLayout(cdp);
    assertChatLayout(initialLayout, "1440x900");
    const initialScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(LAYOUT_1440_PATH, Buffer.from(initialScreenshot.data, "base64"));
    checks.push({
      name: "cold-start-layout",
      ok: true,
      detail: initialLayout,
      screenshot: path.relative(ROOT, LAYOUT_1440_PATH).replace(/\\/g, "/"),
    });

    const compactQuickActions = await cdp.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('[aria-label="快捷任务"] button'));
      const rects = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
      });
      return {
        count: buttons.length,
        maxHeight: rects.length ? Math.max(...rects.map((rect) => rect.height)) : 0,
        rows: new Set(rects.map((rect) => Math.round(rect.top))).size,
        horizontal: buttons.every((button) => {
          const style = getComputedStyle(button);
          return style.flexDirection === 'row' && style.alignItems === 'center';
        }),
      };
    })()`);
    if (compactQuickActions.count !== 4 || !compactQuickActions.horizontal || compactQuickActions.maxHeight > 92 || compactQuickActions.rows > 2) {
      throw new Error(`welcome quick actions are not compact: ${JSON.stringify(compactQuickActions)}`);
    }
    checks.push({ name: "compact-welcome-actions", ok: true, detail: compactQuickActions });

    const inputUtilities = await cdp.evaluate(`(() => ({
      skillsButton: Boolean(document.querySelector('.input-area:not(.hidden) button[aria-label*="技能"]')),
      attachButton: Boolean(document.querySelector('.input-area:not(.hidden) button[aria-label*="附件"], .input-area:not(.hidden) button[aria-label*="文件"]')),
    }))()`);
    if (!inputUtilities.skillsButton || !inputUtilities.attachButton) {
      throw new Error(`input utility buttons are missing: ${JSON.stringify(inputUtilities)}`);
    }
    await cdp.evaluate(`(() => {
      const button = document.querySelector('.input-area:not(.hidden) button[aria-label*="技能"]');
      if (!button) throw new Error('skills utility button missing');
      button.click();
    })()`);
    await waitFor(() => cdp.evaluate("!!document.querySelector('#skillsPanel')"), "skills panel from sparkle button");
    const skillsScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SKILLS_PANEL_PATH, Buffer.from(skillsScreenshot.data, "base64"));
    await cdp.evaluate(`(() => {
      const close = document.querySelector('#skillsPanel button[aria-label]');
      if (!close) throw new Error('skills panel close button missing');
      close.click();
    })()`);
    await waitFor(() => cdp.evaluate("!document.querySelector('#skillsPanel')"), "skills panel closed");

    await cdp.evaluate(`(() => {
      const button = document.querySelector('[data-testid="workspace-tool-menu-button"]');
      if (!button) throw new Error('workspace tool button missing');
      button.click();
    })()`);
    const workspaceToolMenu = await waitFor(() => cdp.evaluate(`(() => {
      const menu = Array.from(document.querySelectorAll('[role="menu"]')).find((node) => (node.textContent || '').includes('工作流模板'));
      if (!menu) return null;
      const rect = menu.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        firstOption: menu.querySelector('[role="menuitemradio"]')?.textContent?.trim() || '',
        optionCount: menu.querySelectorAll('[role="menuitemradio"]').length,
        parentIsBody: menu.parentElement === document.body,
      };
    })()`), "workspace tool portal menu");
    if (workspaceToolMenu.top < 0 || workspaceToolMenu.bottom > 900 || workspaceToolMenu.left < 0 || workspaceToolMenu.right > 1440
      || workspaceToolMenu.optionCount < 6 || !workspaceToolMenu.firstOption.includes('不使用工具') || !workspaceToolMenu.parentIsBody) {
      throw new Error(`workspace tool menu is clipped or incomplete: ${JSON.stringify(workspaceToolMenu)}`);
    }
    const toolMenuScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(TOOL_MENU_PATH, Buffer.from(toolMenuScreenshot.data, "base64"));
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await waitFor(() => cdp.evaluate("!Array.from(document.querySelectorAll('[role=\\\"menu\\\"]')).some((node) => (node.textContent || '').includes('工作流模板'))"), "workspace tool menu escape close");
    checks.push({
      name: "input-skills-and-tool-menu",
      ok: true,
      detail: { ...inputUtilities, workspaceToolMenu },
      screenshots: [SKILLS_PANEL_PATH, TOOL_MENU_PATH].map((file) => path.relative(ROOT, file).replace(/\\/g, "/")),
    });

    await cdp.evaluate(`(() => {
      const action = Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').includes('整理我的想法'));
      if (!action) throw new Error('welcome quick action not found');
      action.click();
    })()`);
    await waitFor(() => cdp.evaluate("!!document.querySelector('.input-area:not(.hidden) [contenteditable=\"true\"] [data-quick-action=\"ideas\"]')"), "welcome quick action badge");
    checks.push({ name: "welcome-quick-action", ok: true });

    await cdp.evaluate("window.__GSAP_E2E__.ensureSession()");
    await waitFor(() => cdp.evaluate("typeof window.__GSAP_E2E__.setInputText === 'function'"), "chat input helper");
    await cdp.evaluate(`window.__GSAP_E2E__.setInputText(${JSON.stringify("请回复桌面冒烟测试。")})`);
    await cdp.evaluate("window.__GSAP_E2E__.clickSendButton()");
    await waitFor(() => cdp.evaluate(`JSON.stringify(window.__GSAP_E2E__.getSessionMessages()).includes(${JSON.stringify(MOCK_REPLY)})`), "mock chat response", 45_000);
    checks.push({ name: "mock-chat", ok: true, requestCount: mockOpenAI.requests.length });

    await waitFor(() => cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot().streamingSessions.length === 0"), "reply completed before compaction");
    const compactSessionPath = await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot().currentSessionPath");
    const serverInfo = JSON.parse(fs.readFileSync(path.join(e2eHome, 'server-info.desktop.json'), 'utf8'));
    const compactResponse = await fetch(`http://127.0.0.1:${serverInfo.port}/api/sessions/fresh-compact`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serverInfo.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: compactSessionPath }),
      signal: AbortSignal.timeout(45_000),
    });
    const compactResult = await compactResponse.json();
    if (!compactResponse.ok || !compactResult.ok) throw new Error(`fresh compact failed: ${JSON.stringify(compactResult)}`);
    checks.push({ name: 'fresh-compact-extension-runtime', ok: true, detail: compactResult });

    const navigationSimplified = await cdp.evaluate(`(() => ({
      destinations: Array.from(document.querySelectorAll('.codia-primary-nav button')).map((button) => (button.textContent || '').trim()),
      titlebarMenuCount: Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).filter((button) => (button.getAttribute('aria-label') || '').includes('页面导航')).length,
      filesEntryCount: Array.from(document.querySelectorAll('.codia-primary-nav button')).filter((button) => (button.textContent || '').includes('文件与项目')).length,
      toolHeadingCount: Array.from(document.querySelectorAll('.codia-sidebar-section-label')).filter((node) => (node.textContent || '').trim() === '工具').length,
      bridgeEntryCount: document.querySelectorAll('#bridgeBar').length,
      assistantActivityEntryCount: document.querySelectorAll('#activityBar').length,
      conversationCollapseCount: document.querySelectorAll('#sidebarCollapseBtn').length,
      conversationTitleCount: Array.from(document.querySelectorAll('.sidebar-title')).filter((node) => (node.textContent || '').trim() === '对话').length,
      conversationSettingsCount: document.querySelectorAll('#settingsBtn').length,
      automationEntryCount: document.querySelectorAll('#automationBar').length,
      skillsEntryCount: document.querySelectorAll('#skillsBar').length,
      newSessionInChatRow: Boolean(document.querySelector('.codia-chat-nav-row > #newSessionBtn')),
      legacyClass: document.body.classList.contains('obsidian-mode')
    }))()`);
    const expectedDestinations = ["聊天", "Agent 小队", "工作流", "活动与插件"];
    if (navigationSimplified.titlebarMenuCount !== 0 || navigationSimplified.filesEntryCount !== 0
      || navigationSimplified.toolHeadingCount !== 0 || navigationSimplified.bridgeEntryCount !== 0
      || navigationSimplified.assistantActivityEntryCount !== 0 || navigationSimplified.conversationCollapseCount !== 0
      || navigationSimplified.conversationTitleCount !== 0 || navigationSimplified.conversationSettingsCount !== 0
      || navigationSimplified.automationEntryCount !== 0 || navigationSimplified.skillsEntryCount !== 0
      || !navigationSimplified.newSessionInChatRow
      || navigationSimplified.legacyClass
      || expectedDestinations.some((label) => !navigationSimplified.destinations.some((value) => value.startsWith(label)))) {
      throw new Error(`navigation simplification failed: ${JSON.stringify(navigationSimplified)}`);
    }
    checks.push({ name: "navigation-simplified", ok: true, detail: navigationSimplified });

    await cdp.evaluate("window.__GSAP_E2E__.setStore({ channelTotalUnread: 3 })");
    await waitFor(() => cdp.evaluate("!!document.querySelector('[aria-label=\"3 条未读消息\"]')"), "channel unread badge");
    await cdp.evaluate("window.__GSAP_E2E__.setStore({ channelTotalUnread: 0 })");
    checks.push({ name: "channel-unread-badge", ok: true });

    await cdp.evaluate("document.querySelector('[data-testid=\"workspace-tool-menu-button\"]')?.click()");
    await waitFor(() => cdp.evaluate("Array.from(document.querySelectorAll('[role=\"menu\"]')).some((node) => (node.textContent || '').includes('工作流模板'))"), "workspace tool menu reopened");
    await selectSidebarDestination(cdp, "活动与插件");
    await waitFor(() => cdp.evaluate("!!document.querySelector('#activityPanel')"), "activity panel");
    await waitFor(() => cdp.evaluate("!Array.from(document.querySelectorAll('[role=\"menu\"]')).some((node) => (node.textContent || '').includes('工作流模板'))"), "workspace tool menu closed on page switch");
    const activitySelected = await cdp.evaluate("document.querySelector('.codia-primary-nav button.active')?.textContent?.trim() || ''");
    if (activitySelected !== "活动与插件") throw new Error(`activity navigation is not selected: ${activitySelected}`);
    await selectSidebarDestination(cdp, "聊天");
    await waitFor(() => cdp.evaluate("!document.querySelector('#activityPanel')"), "activity panel closed from chat navigation");
    checks.push({ name: "activity-navigation", ok: true });

    await cdp.evaluate(`(() => {
      const sidebar = document.querySelector('.jian-sidebar');
      if (!sidebar) throw new Error('right workspace sidebar missing');
      if (sidebar.classList.contains('collapsed')) {
        const button = document.querySelector('#tbToggleRight');
        if (!button) throw new Error('right workspace toggle missing');
        button.click();
      }
    })()`);
    await waitFor(() => cdp.evaluate("!!document.querySelector('.jian-sidebar:not(.collapsed) [role=\"tab\"][aria-selected=\"true\"]')"), "right workspace opened");
    const fileWorkspaceState = await cdp.evaluate(`(() => ({
      readerClass: document.body.classList.contains('obsidian-mode'),
      activeTab: document.querySelector('.jian-sidebar [role="tab"][aria-selected="true"]')?.textContent?.trim() || ''
    }))()`);
    if (fileWorkspaceState.readerClass) throw new Error("files navigation entered retired reader mode");
    checks.push({ name: "files-remain-in-right-workspace", ok: true, detail: fileWorkspaceState });

    await selectSidebarDestination(cdp, "聊天");
    await waitFor(() => cdp.evaluate("!!document.querySelector('.input-area:not(.hidden)')"), "chat mode restored");
    checks.push({ name: "chat-navigation", ok: true });

    await selectSidebarDestination(cdp, "Agent 小队");
    await waitFor(() => cdp.evaluate("!!document.querySelector('.channel-page')"), "channels page");
    checks.push({ name: "channels-navigation", ok: true });

    await selectSidebarDestination(cdp, "工作流");
    await waitFor(() => cdp.evaluate("!!document.querySelector('[aria-label=\"工作流页面\"]')"), "workflow page");
    const workflowHealthy = await cdp.evaluate("!document.body.innerText.includes('此区域出现问题') && !document.body.innerText.includes('发生了未预期的错误')");
    if (!workflowHealthy) throw new Error("workflow page entered the React error boundary");
    await cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('[aria-label="工作流页面"] button')).find((item) => (item.textContent || '').trim() === '生成模板');
      if (!button) throw new Error('generate workflow template button not found');
      button.click();
    })()`);
    await waitFor(() => cdp.evaluate("!!document.querySelector('section[role=\"dialog\"][aria-labelledby=\"workflowTemplateTitle\"]')"), "workflow template dialog");
    const templateDialogAccessibility = await waitFor(() => cdp.evaluate(`(() => {
      const dialog = document.querySelector('section[role="dialog"][aria-labelledby="workflowTemplateTitle"]');
      const textarea = dialog?.querySelector('textarea');
      if (!dialog || !textarea || document.activeElement !== textarea) return null;
      const backdrop = dialog.parentElement;
      const inertSiblings = backdrop?.parentElement
        ? Array.from(backdrop.parentElement.children).filter((element) => element !== backdrop && element.hasAttribute('inert')).length
        : 0;
      return { initialFocus: true, inertSiblings };
    })()`), "workflow template keyboard focus");
    if (templateDialogAccessibility.inertSiblings < 2) {
      throw new Error(`workflow template background is not inert: ${JSON.stringify(templateDialogAccessibility)}`);
    }
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('section[role="dialog"][aria-labelledby="workflowTemplateTitle"]');
      const textarea = dialog?.querySelector('textarea');
      if (!textarea) throw new Error('workflow template description missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '收集需求后复核并形成摘要');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('section[role="dialog"][aria-labelledby="workflowTemplateTitle"]');
      const button = Array.from(dialog?.querySelectorAll('button') || []).find((item) => (item.textContent || '').trim() === '生成草稿');
      if (!button || button.disabled) throw new Error('generate draft button unavailable');
      button.click();
    })()`);
    const templatePreview = await waitFor(() => cdp.evaluate(`(() => {
      const preview = document.querySelector('[data-workflow-template-preview="true"]');
      if (!preview) return null;
      return {
        nodeEditors: preview.querySelectorAll('article').length,
        edgeEditors: preview.querySelectorAll('[aria-label*="连线起点"]').length,
        text: (preview.textContent || '').trim(),
      };
    })()`), "workflow template preview", 45_000);
    if (templatePreview.nodeEditors !== 2 || templatePreview.edgeEditors !== 1) {
      throw new Error(`workflow template preview is invalid: ${JSON.stringify(templatePreview)}`);
    }
    const beforeTemplateApply = await cdp.evaluate(`(() => {
      const key = Object.keys(localStorage).find((item) => item.startsWith('gsap.channel.workflow.draft.'));
      const serialized = key ? localStorage.getItem(key) : null;
      const value = serialized ? JSON.parse(serialized) : null;
      return { key, serialized, nodeCount: value?.nodes?.length || 0, edgeCount: value?.edges?.length || 0 };
    })()`);
    if (beforeTemplateApply.nodeCount !== 0 || beforeTemplateApply.edgeCount !== 0) {
      throw new Error(`workflow canvas changed before template confirmation: ${JSON.stringify(beforeTemplateApply)}`);
    }
    const templatePreviewScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(WORKFLOW_TEMPLATE_PREVIEW_PATH, Buffer.from(templatePreviewScreenshot.data, "base64"));
    await cdp.evaluate(`(() => {
      const preview = document.querySelector('[data-workflow-template-preview="true"]');
      const label = Array.from(preview?.querySelectorAll('label') || []).find((item) => (item.textContent || '').includes('节点名称'));
      const input = label?.querySelector('input');
      if (!input) throw new Error('editable workflow node title missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, '收集需求（已编辑）');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const dialog = document.querySelector('section[role="dialog"][aria-labelledby="workflowTemplateTitle"]');
      const confirm = Array.from(dialog?.querySelectorAll('button') || []).find((item) => (item.textContent || '').trim() === '确认应用');
      if (!confirm || confirm.disabled) throw new Error('confirm workflow template button unavailable');
      confirm.click();
    })()`);
    await waitFor(() => cdp.evaluate("!document.querySelector('section[role=\"dialog\"][aria-labelledby=\"workflowTemplateTitle\"]') && document.body.innerText.includes('收集需求（已编辑）')"), "workflow template applied");
    await waitFor(() => cdp.evaluate("(document.activeElement?.textContent || '').trim() === '生成模板'"), "workflow template focus restored");
    const draft = await waitFor(() => cdp.evaluate(`(() => {
      const key = Object.keys(localStorage).find((item) => item.startsWith('gsap.channel.workflow.draft.'));
      const value = key ? JSON.parse(localStorage.getItem(key) || '{}') : null;
      if (!key || value?.nodes?.length !== 2) return null;
      return {
        key,
        nodeCount: value.nodes.length,
        edgeCount: value.edges?.length || 0,
        nodeTitles: value.nodes.map((node) => node.title),
        serialized: localStorage.getItem(key),
      };
    })()`), "standalone workflow template persisted");
    if (draft.edgeCount !== 1 || !draft.nodeTitles.includes('收集需求（已编辑）')) {
      throw new Error(`standalone workflow template was not persisted correctly: ${JSON.stringify(draft)}`);
    }
    await cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('[aria-label="工作流页面"] button')).find((item) => (item.textContent || '').trim() === '生成模板');
      if (!button) throw new Error('generate template button missing for failure case');
      button.click();
    })()`);
    await waitFor(() => cdp.evaluate("!!document.querySelector('section[role=\"dialog\"][aria-labelledby=\"workflowTemplateTitle\"]')"), "workflow template failure dialog");
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('section[role="dialog"][aria-labelledby="workflowTemplateTitle"]');
      const textarea = dialog?.querySelector('textarea');
      if (!textarea) throw new Error('workflow failure description missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(textarea, '模拟无效模板');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      const button = Array.from(dialog.querySelectorAll('button')).find((item) => ['生成草稿', '重新生成'].includes((item.textContent || '').trim()));
      if (!button || button.disabled) throw new Error('workflow failure generate button unavailable');
      button.click();
    })()`);
    const templateFailure = await waitFor(() => cdp.evaluate(`(() => {
      const dialog = document.querySelector('section[role="dialog"][aria-labelledby="workflowTemplateTitle"]');
      const alert = dialog?.querySelector('[role="alert"]');
      if (!alert || !(alert.textContent || '').includes('2 到 8')) return null;
      const key = Object.keys(localStorage).find((item) => item.startsWith('gsap.channel.workflow.draft.'));
      return { error: (alert.textContent || '').trim(), serialized: key ? localStorage.getItem(key) : null };
    })()`), "invalid workflow template rejected", 45_000);
    if (templateFailure.serialized !== draft.serialized) {
      throw new Error('invalid workflow template changed the saved canvas');
    }
    const templateFailureScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(WORKFLOW_TEMPLATE_FAILURE_PATH, Buffer.from(templateFailureScreenshot.data, "base64"));
    await cdp.evaluate("document.querySelector('button[aria-label=\"关闭模板生成器\"]')?.click()");
    await waitFor(() => cdp.evaluate("!document.querySelector('section[role=\"dialog\"][aria-labelledby=\"workflowTemplateTitle\"]')"), "workflow template failure dialog closed");
    await cdp.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll('[aria-label="工作流页面"] button')).find((item) => (item.textContent || '').trim() === '执行');
      if (!button) throw new Error('execute workflow button not found');
      button.click();
    })()`);
    await waitFor(() => cdp.evaluate("!!document.querySelector('section[role=\"dialog\"][aria-labelledby=\"workflowSetupTitle\"]')"), "workflow execution setup");
    await cdp.evaluate(`(() => {
      const dialog = document.querySelector('section[role="dialog"][aria-labelledby="workflowSetupTitle"]');
      const cancel = Array.from(dialog?.querySelectorAll('button') || []).find((item) => (item.textContent || '').trim() === '取消');
      if (!cancel) throw new Error('workflow setup cancel button missing');
      cancel.click();
    })()`);
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(screenshot.data, "base64"));
    checks.push({
      name: "standalone-workflow-template",
      ok: true,
      detail: { accessibility: templateDialogAccessibility, preview: templatePreview, beforeTemplateApply, draft, failure: templateFailure },
      screenshots: [WORKFLOW_TEMPLATE_PREVIEW_PATH, WORKFLOW_TEMPLATE_FAILURE_PATH, SCREENSHOT_PATH].map((file) => path.relative(ROOT, file).replace(/\\/g, "/")),
    });

    await selectSidebarDestination(cdp, "聊天");
    await waitFor(() => cdp.evaluate("!!document.querySelector('.input-area:not(.hidden)')"), "chat restored for visual tools");

    const visualToolCases = [
      { pluginId: "knowledge-graph", prompt: "请根据这些内容生成冒烟知识图谱。" },
      { pluginId: "mind-map", prompt: "请根据这些内容生成冒烟思维导图。" },
    ];
    for (const visualTool of visualToolCases) {
      await cdp.evaluate(`window.__GSAP_E2E__.setInputText(${JSON.stringify(visualTool.prompt)})`);
      await cdp.evaluate("window.__GSAP_E2E__.clickSendButton()");
      const approvalRequired = await waitFor(() => cdp.evaluate(`(() => {
        if (document.querySelector('iframe[src*="/api/plugins/${visualTool.pluginId}/card"]')) return 'card';
        const approve = Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').trim() === '同意');
        return approve ? 'approval' : null;
      })()`), `${visualTool.pluginId} approval or card`, 30_000);
      if (approvalRequired === 'approval') {
        await cdp.evaluate(`(() => {
          const approve = Array.from(document.querySelectorAll('button')).find((button) => (button.textContent || '').trim() === '同意');
          if (!approve) throw new Error('tool approval button missing');
          approve.click();
        })()`);
      }
      const pluginFrame = await waitFor(() => cdp.evaluate(`(() => {
        const iframe = document.querySelector('iframe[src*="/api/plugins/${visualTool.pluginId}/card"]');
        if (!iframe || !iframe.getAttribute('src')) return null;
        const opacity = Number.parseFloat(getComputedStyle(iframe).opacity || '0');
        return opacity >= 0.99 ? { src: iframe.getAttribute('src'), opacity } : null;
      })()`), `${visualTool.pluginId} inline chat card`, 45_000);
      checks.push({ name: `inline-${visualTool.pluginId}`, ok: true, detail: pluginFrame });
    }

    const visualSessionPath = await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot().currentSessionPath");
    await cdp.evaluate(`window.__GSAP_E2E__.switchSession(${JSON.stringify(visualSessionPath)})`);
    await waitFor(() => cdp.evaluate(`(() => {
      const graph = document.querySelector('iframe[src*="/api/plugins/knowledge-graph/card"]');
      const mindMap = document.querySelector('iframe[src*="/api/plugins/mind-map/card"]');
      return Boolean(graph && mindMap
        && Number.parseFloat(getComputedStyle(graph).opacity || '0') >= 0.99
        && Number.parseFloat(getComputedStyle(mindMap).opacity || '0') >= 0.99);
    })()`), "visual cards restored from session history", 45_000);
    checks.push({ name: "inline-visual-history-restore", ok: true, sessionPath: visualSessionPath });

    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1.25, mobile: false });
    const compactLayout = await readChatLayout(cdp);
    assertChatLayout(compactLayout, "1280x800@125%");
    const compactScreenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(LAYOUT_1280_PATH, Buffer.from(compactScreenshot.data, "base64"));
    checks.push({
      name: "compact-layout",
      ok: true,
      detail: compactLayout,
      screenshot: path.relative(ROOT, LAYOUT_1280_PATH).replace(/\\/g, "/"),
    });

    await cdp.evaluate("window.__GSAP_E2E__.openSettings('general')");
    const settingsModal = await waitFor(() => cdp.evaluate(`(() => {
      const modal = document.querySelector('[data-testid="settings-modal-overlay"] [role="dialog"]');
      return modal ? { label: modal.getAttribute('aria-label'), state: modal.getAttribute('data-state') } : null;
    })()`), "settings modal", 30_000);
    checks.push({ name: "settings-modal", ok: true, detail: settingsModal });

    const brandSurfaces = await waitFor(() => cdp.evaluate(`(() => {
      const home = document.querySelector('.codia-brand-lockup img');
      const general = document.querySelector('[data-tab="about"] img[alt="Codia 小豆蔻"]');
      const modal = document.querySelector('[data-testid="settings-modal-overlay"] [role="dialog"]');
      if (document.querySelector('#settingsLoadingMask') || !modal || Number(getComputedStyle(modal).opacity) < 0.99) return null;
      if (!home?.complete || !general?.complete || !home.naturalWidth || !general.naturalWidth) return null;
      return { home: home.src, general: general.src, width: general.naturalWidth };
    })()`), 'shared Codia brand images');
    if (brandSurfaces.home !== brandSurfaces.general || brandSurfaces.width !== 512) {
      throw new Error(`Product icons are inconsistent: ${JSON.stringify(brandSurfaces)}`);
    }
    await cdp.evaluate(`document.querySelector('[data-tab="about"] img[alt="Codia 小豆蔻"]').scrollIntoView({ block: 'center', behavior: 'instant' })`);
    await waitFor(() => cdp.evaluate(`(() => {
      const image = document.querySelector('[data-tab="about"] img[alt="Codia 小豆蔻"]');
      const rect = image.getBoundingClientRect();
      return rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight
        && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === image;
    })()`), 'visible general product icon');
    const settingsFailure = await cdp.evaluate(`document.querySelector('[data-testid="settings-modal-overlay"]')?.innerText.match(/保存失败[^\\n]*|server connection not ready[^\\n]*/)?.[0] || null`);
    if (settingsFailure) throw new Error(`Settings initialization failed: ${settingsFailure}`);
    const brandScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'general-branding.png'), Buffer.from(brandScreenshot.data, 'base64'));
    checks.push({ name: 'shared-product-branding', ok: true, detail: brandSurfaces });

    if (exceptions.length > 0) throw new Error(`renderer exception: ${exceptions[0]}`);
    if (mockOpenAI.requests.length < 1) throw new Error("mock model received no chat request");
    if (/mind map LLM failed|LLM_EMPTY_RESPONSE/.test(capturedStdout + capturedStderr)) {
      throw new Error('Mind map structured model generation failed; fallback does not satisfy this smoke check');
    }

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      modelEndpoint: mockOpenAI.baseUrl,
      mockOnly: mockOpenAI.baseUrl.startsWith("http://127.0.0.1:"),
      mockRequestCount: mockOpenAI.requests.length,
      mockRequests: summarizeMockRequests(mockOpenAI.requests),
      checks,
      rendererExceptions: exceptions,
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    succeeded = true;
    console.log(`[e2e-full-desktop-smoke] passed ${checks.length} checks; report=${REPORT_PATH}`);
  } catch (error) {
    let rendererDiagnostics = null;
    try {
      rendererDiagnostics = cdp ? await cdp.evaluate(`(() => ({
        state: window.__GSAP_E2E__?.getStateSnapshot?.() || null,
        messages: window.__GSAP_E2E__?.getSessionMessages?.() || [],
        bodyTextTail: (document.body?.innerText || '').slice(-4000),
        pluginFrames: Array.from(document.querySelectorAll('iframe[src*="/api/plugins/"]')).map((frame) => frame.getAttribute('src')),
      }))()`) : null;
    } catch {}
    const report = {
      ok: false,
      isolatedHome: e2eHome,
      generatedAt: new Date().toISOString(),
      error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      modelEndpoint: mockOpenAI.baseUrl,
      mockOnly: mockOpenAI.baseUrl.startsWith("http://127.0.0.1:"),
      mockRequestCount: mockOpenAI.requests.length,
      mockRequests: summarizeMockRequests(mockOpenAI.requests),
      checks,
      rendererExceptions: exceptions,
      rendererDiagnostics,
      stdoutTail: capturedStdout.slice(-6000),
      stderrTail: capturedStderr.slice(-3000),
    };
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    throw error;
  } finally {
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'stdout.log'), capturedStdout);
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'stderr.log'), capturedStderr);
    cdp?.close();
    killProcessTree(child);
    await mockOpenAI.close().catch(() => {});
    if (succeeded) removeE2EHome(e2eHome);
  }
}

main().catch((error) => {
  console.error("[e2e-full-desktop-smoke]", error);
  process.exit(1);
});
