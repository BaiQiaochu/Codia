#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import YAML from "js-yaml";
import JSZip from "jszip";
import WebSocket from "ws";
import {
  createIsolatedE2EHome,
  getAvailablePort,
  removeE2EHome,
  startMockOpenAI,
} from "./e2e-env.mjs";
import { desktopLaunchCommand, desktopLaunchEnv } from "./e2e-desktop-launcher.mjs";

const ROOT = process.cwd();
const RESULT_PATH = path.join(ROOT, "tmp-e2e-desk-workflow-result.json");
let capturedStdout = "";
let capturedStderr = "";
let currentStage = "start";

function stage(name) {
  currentStage = name;
  console.log(`[e2e-desk-workflow] ${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs = 30000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`${label} timed out`);
    }
    await sleep(250);
  }
}

async function getPageTarget(remoteDebugPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/list`);
    if (!res.ok) return null;
    const targets = await res.json();
    return targets.find((target) => target.type === "page" && String(target.url || "").includes("index.html")) || null;
  } catch {
    return null;
  }
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  function rejectPending(error) {
    for (const ticket of pending.values()) {
      clearTimeout(ticket.timer);
      ticket.reject(error);
    }
    pending.clear();
  }

  ws.on("error", rejectPending);
  ws.on("close", () => rejectPending(new Error("CDP websocket closed")));

  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (!msg.id) return;
    const ticket = pending.get(msg.id);
    if (!ticket) return;
    pending.delete(msg.id);
    clearTimeout(ticket.timer);
    if (msg.error) ticket.reject(new Error(msg.error.message || "CDP error"));
    else ticket.resolve(msg.result);
  });

  async function send(method, params = {}) {
    await ready;
    if (ws.readyState !== WebSocket.OPEN) throw new Error("CDP websocket is not open");
    const requestId = ++id;
    const payload = { id: requestId, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`CDP ${method} timed out at ${currentStage}`));
      }, 30000);
      pending.set(requestId, { resolve, reject, timer });
    });
    ws.send(JSON.stringify(payload));
    return promise;
  }

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  }

  return {
    ready,
    send,
    evaluate,
    close() {
      ws.close();
    },
  };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      return;
    } catch {}
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

function writeYaml(filePath, data) {
  fs.writeFileSync(
    filePath,
    YAML.dump(data, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
    "utf-8",
  );
}

function patchDeskHome(homeDir, deskHome) {
  const configPath = path.join(homeDir, "agents", "gsap", "config.yaml");
  const raw = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
  raw.desk = {
    ...(raw.desk || {}),
    home_folder: deskHome,
    heartbeat_enabled: false,
  };
  writeYaml(configPath, raw);
}

async function createWorkspaceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-e2e-desk-"));
  const workspace1 = path.join(root, "workspace-one");
  const workspace2 = path.join(root, "workspace-two");
  fs.mkdirSync(workspace1, { recursive: true });
  fs.mkdirSync(workspace2, { recursive: true });
  fs.writeFileSync(path.join(workspace1, "readme.md"), "# Desk Readme\n\nhello", "utf-8");
  fs.writeFileSync(path.join(workspace1, "move-me.txt"), "move this file", "utf-8");
  fs.writeFileSync(path.join(workspace2, "second.txt"), "second workspace", "utf-8");

  const skillSourceDir = path.join(root, "sample-skill");
  fs.mkdirSync(skillSourceDir, { recursive: true });
  const skillMarkdown = "---\nname: sample-skill\ndescription: desk e2e skill\n---\n# sample\n";
  fs.writeFileSync(path.join(skillSourceDir, "SKILL.md"), skillMarkdown, "utf-8");
  const skillZipPath = path.join(root, "sample-skill.zip");
  const zip = new JSZip();
  zip.file("SKILL.md", skillMarkdown);
  fs.writeFileSync(skillZipPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

  return { root, workspace1, workspace2, skillZipPath };
}

async function waitForDeskItem(cdp, name, timeoutMs = 20000) {
  return await waitFor(
    async () => {
      const found = await cdp.evaluate(`!!document.querySelector('[data-desk-item][data-name="${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]')`);
      return found ? true : null;
    },
    `desk item ${name}`,
    timeoutMs,
  );
}

async function main() {
  const remoteDebugPort = Number(process.env.GSAP_E2E_REMOTE_DEBUG_PORT || await getAvailablePort());
  const mockOpenAI = await startMockOpenAI({ reply: "Desk E2E reply." });
  const fixture = await createWorkspaceFixture();
  const e2eHome = createIsolatedE2EHome({ mockBaseUrl: mockOpenAI.baseUrl });
  patchDeskHome(e2eHome, fixture.workspace1);
  const workspace1Expr = JSON.stringify(fixture.workspace1);
  const workspace2Expr = JSON.stringify(fixture.workspace2);
  const skillZipExpr = JSON.stringify(fixture.skillZipPath);

  const launch = desktopLaunchCommand(ROOT, [
    `--remote-debugging-port=${remoteDebugPort}`,
    "--remote-allow-origins=*",
  ]);
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

  let cdp = null;
  try {
    stage("wait electron page");
    const target = await waitFor(() => getPageTarget(remoteDebugPort), "electron page target", 60000);
    cdp = createCdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");

    stage("wait renderer ready");
    await waitFor(
      async () => await cdp.evaluate(
        "typeof window.__GSAP_RUNTIME_DIAGNOSTICS__ !== 'undefined' && window.__GSAP_E2E__?.appReady === true",
      ),
      "renderer app ready",
      60000,
    );

    stage("create session one");
    const session1 = await cdp.evaluate(`window.__GSAP_E2E__.createSession({ cwd: ${workspace1Expr} })`);
    if (!session1?.ok || !session1.currentSessionPath) {
      throw new Error("failed to create initial desk session");
    }

    stage("wait readme item");
    await waitForDeskItem(cdp, "readme.md");

    stage("open readme preview");
    await cdp.evaluate(`(() => {
      const node = document.querySelector('[data-desk-item][data-name="readme.md"]');
      if (!node) throw new Error('readme item missing');
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return true;
    })()`);

    stage("wait preview");
    const openedPreview = await waitFor(
      async () => {
        const preview = await cdp.evaluate("window.__GSAP_E2E__.getPreviewSnapshot()");
        return preview?.artifacts?.some((artifact) => artifact.title === "readme.md") ? preview : null;
      },
      "desk preview open",
      20000,
    );

    stage("open desk context menu for mind map");
    await cdp.evaluate(`(() => {
      const list = document.querySelector('[data-empty-text]');
      if (!list) throw new Error('desk list missing');
      const rect = list.getBoundingClientRect();
      list.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 28,
        clientY: rect.top + 28,
      }));
      return true;
    })()`);

    stage("create mind map from context menu");
    const mindmapName = await cdp.evaluate(`(() => {
      const label = window.t('desk.ctx.newMindmap');
      const items = Array.from(document.querySelectorAll('.context-menu-item'));
      const target = items.find((item) => (item.textContent || '').trim() === label);
      if (!target) throw new Error('new mind map menu item missing');
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return window.t('desk.newMindmapFile');
    })()`);

    stage("wait mind map item");
    await waitForDeskItem(cdp, mindmapName);

    stage("open mind map preview");
    await cdp.evaluate(`(() => {
      const name = ${JSON.stringify(mindmapName)};
      const node = Array.from(document.querySelectorAll('[data-desk-item]')).find((item) => item.dataset.name === name);
      if (!node) throw new Error('mind map item missing');
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return true;
    })()`);

    stage("wait mind map preview");
    const mindmapPreview = await waitFor(
      async () => {
        const preview = await cdp.evaluate("window.__GSAP_E2E__.getPreviewSnapshot()");
        return preview?.artifacts?.some((artifact) => artifact.title === mindmapName && artifact.type === "design-document")
          ? preview
          : null;
      },
      "mind map preview open",
      20000,
    );

    const mindmapPreviewText = await waitFor(
      async () => await cdp.evaluate(`(() => {
        const node = document.querySelector('.preview-design-document');
        if (!node) return null;
        const text = node.textContent || '';
        return text.includes('XMind') && text.includes('mindmap') ? text : null;
      })()`),
      "mind map design preview text",
      20000,
    );

    stage("open desk context menu");
    await cdp.evaluate(`(() => {
      const list = document.querySelector('[data-empty-text]');
      if (!list) throw new Error('desk list missing');
      const rect = list.getBoundingClientRect();
      list.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 20,
        clientY: rect.top + 20,
      }));
      return true;
    })()`);

    stage("create folder from context menu");
    await cdp.evaluate(`(() => {
      const label = window.t('desk.ctx.newFolder');
      const items = Array.from(document.querySelectorAll('.context-menu-item'));
      const target = items.find((item) => (item.textContent || '').trim() === label);
      if (!target) throw new Error('new folder menu item missing');
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);

    stage("wait rename input");
    await waitFor(
      async () => await cdp.evaluate(`!!document.querySelector('[data-desk-rename-input]')`),
      "rename input",
      10000,
    );

    stage("commit folder rename");
    await cdp.evaluate(`(() => {
      const input = document.querySelector('[data-desk-rename-input]');
      if (!input) throw new Error('rename input missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('input value setter missing');
      setter.call(input, 'renamed-folder');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
      input.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    })()`);

    stage("wait renamed folder");
    await waitForDeskItem(cdp, "renamed-folder");

    stage("drag file into renamed folder");
    await cdp.evaluate(`(() => {
      const source = document.querySelector('[data-desk-item][data-name="move-me.txt"]');
      const target = document.querySelector('[data-desk-item][data-name="renamed-folder"]');
      if (!source || !target) throw new Error('drag source or target missing');
      const dataTransfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
      return true;
    })()`);

    stage("wait drag move completed");
    await waitFor(
      async () => {
        const snap = await cdp.evaluate("window.__GSAP_E2E__.getDeskSnapshot()");
        return !snap?.deskFiles?.some((file) => file.name === "move-me.txt") ? snap : null;
      },
      "drag move completed",
      20000,
    );

    stage("expand renamed folder in workspace tree");
    await cdp.evaluate(`(() => {
      const node = document.querySelector('[data-desk-item][data-name="renamed-folder"]');
      if (!node) throw new Error('renamed folder missing');
      node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return true;
    })()`);

    stage("wait moved file in expanded tree");
    await waitForDeskItem(cdp, "move-me.txt");

    stage("edit jian content");
    await cdp.evaluate(`(() => {
      const textarea = document.querySelector('[data-desk-editor] textarea');
      if (!textarea) throw new Error('desk textarea missing');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) throw new Error('textarea value setter missing');
      setter.call(textarea, 'jian e2e saved');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      textarea.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    })()`);

    stage("wait jian saved");
    await waitFor(
      async () => fs.existsSync(path.join(fixture.workspace1, 'jian.md'))
        ? fs.readFileSync(path.join(fixture.workspace1, 'jian.md'), 'utf-8').includes('jian e2e saved')
        : null,
      "jian saved to disk",
      10000,
    );

    stage("create session two");
    const session2 = await cdp.evaluate(`window.__GSAP_E2E__.createSession({ cwd: ${workspace2Expr} })`);
    if (!session2?.ok || !session2.currentSessionPath) {
      throw new Error("failed to create second session");
    }

    stage("wait session two file");
    await waitForDeskItem(cdp, "second.txt");
    stage("switch back to session one");
    await cdp.evaluate(`window.__GSAP_E2E__.switchSession(${JSON.stringify(session1.currentSessionPath)})`);

    stage("wait session one restored");
    const switchedBack = await waitFor(
      async () => {
        const snap = await cdp.evaluate("window.__GSAP_E2E__.getDeskSnapshot()");
        return snap?.deskBasePath === fixture.workspace1
          && snap?.deskCurrentPath === ''
          ? snap
          : null;
      },
      "switch back to session one",
      20000,
    );

    stage("install project skill");
    const installSkill = await cdp.evaluate(`window.__GSAP_E2E__.installProjectSkill(${skillZipExpr}, ${workspace1Expr})`);
    if (!installSkill?.ok) {
      throw new Error(`project skill install failed: ${installSkill?.error || 'unknown error'}`);
    }

    stage("open cwd skills panel");
    await cdp.evaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((node) => (node.textContent || '').includes(window.t('desk.cwdSkills')));
      if (!btn) throw new Error('cwd skills button missing');
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);

    stage("wait cwd skill visible");
    await waitFor(
      async () => {
        const snap = await cdp.evaluate("window.__GSAP_E2E__.getDeskSnapshot()");
        return snap?.cwdSkills?.some((skill) => skill.name === 'sample-skill') ? snap : null;
      },
      "cwd skill visible",
      20000,
    );

    const result = {
      ok: true,
      remoteDebugPort,
      fixture,
      checks: {
        openFile: {
          ok: true,
          preview: openedPreview,
        },
        mindmap: {
          ok: true,
          fileName: mindmapName,
          filePath: path.join(fixture.workspace1, mindmapName),
          preview: mindmapPreview,
          previewText: mindmapPreviewText.slice(0, 500),
        },
        rename: {
          ok: true,
          folderName: 'renamed-folder',
        },
        dragMove: {
          ok: true,
          movedFile: 'move-me.txt',
        },
        jianSave: {
          ok: true,
          filePath: path.join(fixture.workspace1, 'jian.md'),
        },
        sessionSwitch: {
          ok: true,
          session1: session1.currentSessionPath,
          session2: session2.currentSessionPath,
          restoredDesk: switchedBack,
        },
        projectSkillInstall: {
          ok: true,
          installSkill,
        },
      },
      diagnostics: {
        deskSnapshot: await cdp.evaluate("window.__GSAP_E2E__.getDeskSnapshot()"),
        previewSnapshot: await cdp.evaluate("window.__GSAP_E2E__.getPreviewSnapshot()"),
        stateSnapshot: await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot()"),
        stdoutTail: capturedStdout.slice(-4000),
        stderrTail: capturedStderr.slice(-4000),
      },
    };

    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    console.log(`[e2e-desk-workflow] wrote ${RESULT_PATH}`);
  } catch (error) {
    let stateSnapshot = null;
    let deskSnapshot = null;
    try {
      stateSnapshot = cdp ? await cdp.evaluate("window.__GSAP_E2E__?.getStateSnapshot?.()") : null;
      deskSnapshot = cdp ? await cdp.evaluate("window.__GSAP_E2E__?.getDeskSnapshot?.()") : null;
    } catch {}
    fs.writeFileSync(RESULT_PATH, JSON.stringify({
      ok: false,
      error: {
        message: error.message,
        stack: error.stack,
        stage: currentStage,
      },
      diagnostics: {
        e2eHome,
        stateSnapshot,
        deskSnapshot,
        stdoutTail: capturedStdout.slice(-4000),
        stderrTail: capturedStderr.slice(-4000),
      },
    }, null, 2));
    console.error("[e2e-desk-workflow]", error);
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch {}
    killProcessTree(child);
    await mockOpenAI.close().catch(() => {});
    if (process.env.GSAP_E2E_KEEP_HOME === "1") {
      console.log(`[e2e-desk-workflow] preserved ${e2eHome}`);
    } else {
      removeE2EHome(e2eHome);
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

main();
