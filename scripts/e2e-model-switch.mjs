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
import { desktopLaunchEnv } from "./e2e-desktop-launcher.mjs";

const ROOT = process.cwd();
const RESULT_PATH = path.join(ROOT, "tmp-e2e-model-switch-result.json");
let capturedStdout = "";
let capturedStderr = "";
let lastStateSnapshot = null;

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
    await sleep(300);
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
    for (const ticket of pending.values()) ticket.reject(error);
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
    if (msg.error) ticket.reject(new Error(msg.error.message || "CDP error"));
    else ticket.resolve(msg.result);
  });

  async function send(method, params = {}) {
    await ready;
    if (ws.readyState !== WebSocket.OPEN) throw new Error("CDP websocket is not open");
    const requestId = ++id;
    const payload = { id: requestId, method, params };
    const promise = new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
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

function toExpr(value) {
  return JSON.stringify(value);
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      // Fall through to child.kill below.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

async function main() {
  const remoteDebugPort = Number(process.env.CODIA_E2E_REMOTE_DEBUG_PORT || await getAvailablePort());
  const mockOpenAI = await startMockOpenAI({ reply: "E2E model response." });
  const e2eHome = createIsolatedE2EHome({ mockBaseUrl: mockOpenAI.baseUrl });
  const child = spawn(
    process.execPath,
    ["scripts/launch.js", "electron"],
    {
      cwd: ROOT,
      env: desktopLaunchEnv({
        CODIA_HOME: e2eHome,
        CODIA_E2E: "1",
        CODIA_E2E_REMOTE_DEBUG_PORT: String(remoteDebugPort),
        CODIA_DESKTOP_SERVER_MODE: "dist",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stdout.on("data", (chunk) => { capturedStdout += String(chunk); });
  child.stderr.on("data", (chunk) => { capturedStderr += String(chunk); });

  let cdp = null;
  try {
    const target = await waitFor(() => getPageTarget(remoteDebugPort), "electron page target");
    cdp = createCdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");

    await waitFor(
      async () => await cdp.evaluate(
        "typeof window.__CODIA_RUNTIME_DIAGNOSTICS__ !== 'undefined' && window.__CODIA_E2E__?.appReady === true",
      ),
      "renderer app ready",
      60000,
    );

    const ensured = await cdp.evaluate("window.__CODIA_E2E__.ensureSession()");
    if (!ensured) {
      throw new Error("ensureSession failed");
    }

    await waitFor(
      async () => await cdp.evaluate("!!document.querySelector('button[class*=\"model-pill\"]')"),
      "model selector",
      20000,
    );

    const initialState = await waitFor(
      async () => {
        const snapshot = await cdp.evaluate("window.__CODIA_E2E__.getStateSnapshot()");
        return snapshot.currentSessionPath ? snapshot : null;
      },
      "currentSessionPath after ensureSession",
      30000,
    );
    const sessionPath = initialState.currentSessionPath || null;
    if (!sessionPath) {
      throw new Error("currentSessionPath unavailable after ensureSession");
    }

    const currentSessionModel = initialState.sessionModelsByPath?.[sessionPath] || null;
    const currentModel = currentSessionModel || (initialState.models || []).find((model) => model.isCurrent) || null;
    const availableModels = (initialState.models || []).filter((model) => model.provider);

    if (!currentModel) {
      throw new Error("current model unavailable");
    }

    await cdp.evaluate(`window.__CODIA_E2E__.setStore(${toExpr({ pendingNewSession: true, welcomeVisible: true })})`);
    const healedState = await cdp.evaluate("window.__CODIA_E2E__.refreshModels()");
    const healOk = healedState.currentSessionPath === sessionPath
      && healedState.pendingNewSession === false
      && healedState.welcomeVisible === false;

    const targetModel = availableModels.find((model) => !(model.id === currentModel.id && model.provider === currentModel.provider)) || null;

    let modelSwitchResult;
    if (!targetModel) {
      modelSwitchResult = {
        ok: false,
        skipped: true,
        reason: "need at least 2 configured models for e2e model switch",
        sessionPath,
        from: {
          id: currentModel.id,
          provider: currentModel.provider,
          name: currentModel.name,
        },
      };
    } else {
      await cdp.evaluate(`window.__CODIA_E2E__.setStore(${toExpr({ pendingNewSession: true })})`);

      await cdp.evaluate(`(() => {
        const pill = document.querySelector('button[class*="model-pill"]');
        if (!pill) throw new Error('model pill not found');
        pill.click();
        return true;
      })()`);

      await waitFor(
        async () => await cdp.evaluate(`(() => {
          const buttons = Array.from(document.querySelectorAll('[data-select-widget-popup] button[role="option"]'));
          return buttons.some((button) => (button.textContent || '').includes(${toExpr(targetModel.name)}));
        })()`),
        "target model option",
        10000,
      );

      await cdp.evaluate(`(() => {
        const buttons = Array.from(document.querySelectorAll('[data-select-widget-popup] button[role="option"]'));
        const target = buttons.find((button) => (button.textContent || '').includes(${toExpr(targetModel.name)}));
        if (!target) throw new Error('target model option not found');
        target.click();
        return true;
      })()`);
      await sleep(1000);
      lastStateSnapshot = await cdp.evaluate("window.__CODIA_E2E__.getStateSnapshot()");

      const switchedState = await waitFor(
        async () => {
          const snapshot = await cdp.evaluate("window.__CODIA_E2E__.getStateSnapshot()");
          lastStateSnapshot = snapshot;
          const sessionModel = snapshot.sessionModelsByPath?.[snapshot.currentSessionPath || ""] || null;
          if (!sessionModel) return null;
          if (sessionModel.id !== targetModel.id || sessionModel.provider !== targetModel.provider) return null;
          if (snapshot.pendingNewSession !== false) return null;
          return snapshot;
        },
        "session model switch",
        30000,
      );

      modelSwitchResult = {
        ok: true,
        skipped: false,
        sessionPath,
        from: {
          id: currentModel.id,
          provider: currentModel.provider,
          name: currentModel.name,
        },
        to: {
          id: targetModel.id,
          provider: targetModel.provider,
          name: targetModel.name,
        },
        finalSessionModel: switchedState.sessionModelsByPath?.[sessionPath] || null,
      };
    }

    const result = {
      ok: true,
      remoteDebugPort,
      checks: {
        stalePendingHealed: {
          ok: healOk,
          before: {
            currentSessionPath: initialState.currentSessionPath,
            pendingNewSession: true,
            welcomeVisible: true,
          },
          after: {
            currentSessionPath: healedState.currentSessionPath,
            pendingNewSession: healedState.pendingNewSession,
            welcomeVisible: healedState.welcomeVisible,
          },
        },
        modelSwitchViaUi: modelSwitchResult,
      },
      diagnostics: {
        state: lastStateSnapshot,
        stdoutTail: capturedStdout.slice(-4000),
        stderrTail: capturedStderr.slice(-4000),
      },
    };

    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    console.log(`[e2e-model-switch] wrote ${RESULT_PATH}`);
  } catch (error) {
    fs.writeFileSync(RESULT_PATH, JSON.stringify({
      ok: false,
      error: {
        message: error.message,
        stack: error.stack,
      },
      diagnostics: {
        state: lastStateSnapshot,
        stdoutTail: capturedStdout.slice(-4000),
        stderrTail: capturedStderr.slice(-4000),
      },
    }, null, 2));
    console.error("[e2e-model-switch]", error);
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch {}
    killProcessTree(child);
    await mockOpenAI.close().catch(() => {});
    removeE2EHome(e2eHome);
  }
}

main();
