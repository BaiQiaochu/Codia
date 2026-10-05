#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
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
const RESULT_PATH = path.join(ROOT, "tmp-e2e-image-input-result.json");
let capturedStdout = "";
let capturedStderr = "";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnXl1wAAAAASUVORK5CYII=";
const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
  <rect width="48" height="48" fill="#ff4d4f"/>
  <circle cx="24" cy="24" r="10" fill="#ffffff"/>
</svg>`;

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
  const events = [];
  let closeInfo = null;

  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  function rejectPending(error) {
    for (const ticket of pending.values()) ticket.reject(error);
    pending.clear();
  }

  ws.on("error", rejectPending);
  ws.on("close", (code, reason) => {
    closeInfo = { code, reason: String(reason || "") };
    rejectPending(new Error(`CDP websocket closed (${code}${reason ? `: ${String(reason)}` : ""})`));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (!msg.id) {
      events.push({
        method: msg.method || null,
        params: msg.params || null,
      });
      if (events.length > 80) events.shift();
      return;
    }
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
    evaluate,
    send,
    getEvents() {
      return events.slice();
    },
    getCloseInfo() {
      return closeInfo;
    },
    isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    close() {
      ws.close();
    },
  };
}

function toExpr(value) {
  return JSON.stringify(value);
}

function summarizeMockOpenAIRequests(requests) {
  return (requests || []).map((request) => ({
    model: request?.model || null,
    stream: request?.stream === true,
    messageCount: Array.isArray(request?.messages) ? request.messages.length : 0,
    hasImage:
      JSON.stringify(request?.messages || []).includes("\"image\"")
      || JSON.stringify(request?.messages || []).includes("image_url")
      || JSON.stringify(request?.messages || []).includes("input_image"),
    lastUserText: extractLastUserText(request?.messages).slice(0, 200),
  }));
}

function extractLastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block?.type === "text") return block.text || "";
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function killProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      return;
    } catch {
      // Fall through to normal child.kill.
    }
  }
  try { child.kill("SIGKILL"); } catch {}
}

async function waitForAssistantReply(cdp, sessionPath, baselineAssistantCount, timeoutMs = 90000) {
  return await waitFor(async () => {
    const items = await cdp.evaluate(`window.__GSAP_E2E__.getSessionMessages(${toExpr(sessionPath)})`);
    const assistants = (items || [])
      .filter((item) => item?.type === "message" && item.data?.role === "assistant")
      .map((item) => item.data);
    if (assistants.length <= baselineAssistantCount) return null;
    const last = assistants[assistants.length - 1];
    const hasTextBlock = Array.isArray(last?.blocks) && last.blocks.some((block) => block.type === "text" && block.html);
    if (!hasTextBlock) return null;
    return last;
  }, "assistant reply", timeoutMs);
}

async function main() {
  const remoteDebugPort = Number(process.env.GSAP_E2E_REMOTE_DEBUG_PORT || await getAvailablePort());
  const mockOpenAI = await startMockOpenAI({ reply: "E2E vision reply received." });
  const e2eHome = createIsolatedE2EHome({ mockBaseUrl: mockOpenAI.baseUrl });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-e2e-image-"));
  const pngPath = path.join(tempDir, "drag-sample.png");
  const svgPath = path.join(tempDir, "drag-vector.svg");

  fs.writeFileSync(pngPath, Buffer.from(PNG_BASE64, "base64"));
  fs.writeFileSync(svgPath, SVG_TEXT, "utf8");

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
  const childExit = { code: null, signal: null, at: null };
  child.on("exit", (code, signal) => {
    childExit.code = code;
    childExit.signal = signal;
    childExit.at = new Date().toISOString();
  });

  let cdp = null;
  try {
    const target = await waitFor(() => getPageTarget(remoteDebugPort), "electron page target");
    cdp = createCdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable").catch(() => null);
    await cdp.send("Log.enable").catch(() => null);

    await waitFor(
      async () => await cdp.evaluate(
        "typeof window.__GSAP_RUNTIME_DIAGNOSTICS__ !== 'undefined' && window.__GSAP_E2E__?.appReady === true",
      ),
      "renderer e2e helper",
      60000,
    );
    await cdp.evaluate("window.__GSAP_E2E__.ensureSession()").catch(() => false);
    const inputHelperReady = await waitFor(
      async () => await cdp.evaluate("typeof window.__GSAP_E2E__.setInputText === 'function'"),
      "input helper",
      15000,
    ).then(() => true).catch(() => false);

    await cdp.evaluate("window.__GSAP_E2E__.clearAttachedFiles()");

    const dragPng = await cdp.evaluate(`window.__GSAP_E2E__.attachFilesFromPaths([${toExpr(pngPath)}])`);
    await cdp.evaluate("window.__GSAP_E2E__.clearAttachedFiles()");
    const dragSvg = await cdp.evaluate(`window.__GSAP_E2E__.attachFilesFromPaths([${toExpr(svgPath)}])`);
    await cdp.evaluate("window.__GSAP_E2E__.clearAttachedFiles()");

    const pasted = await cdp.evaluate(`window.__GSAP_E2E__.addImageAttachment(${toExpr({
      name: "pasted-shot.png",
      base64Data: PNG_BASE64,
      mimeType: "image/png",
    })})`);

    const stateBefore = await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot()");
    const sessionPath = stateBefore.currentSessionPath || null;
    const localizedNoVision = await cdp.evaluate("window.t('input.textModelImageBlocked') || window.t('error.modelNoVision')");

    const originalModels = stateBefore.models || [];
    const originalSessionModels = stateBefore.sessionModelsByPath || {};
    const noVisionModel = [{ id: "e2e-no-vision", name: "E2E No Vision", provider: "e2e", isCurrent: true, vision: false }];
    const noVisionSessionModels = sessionPath
      ? { ...originalSessionModels, [sessionPath]: { id: "e2e-no-vision", name: "E2E No Vision", provider: "e2e", vision: false } }
      : originalSessionModels;

    let noVisionNotice = "";
    let blockedAttachments = [];
    let noVisionStatus = { ok: false, skipped: false, reason: "" };

    if (!inputHelperReady) {
      noVisionStatus = { ok: false, skipped: true, reason: "chat input area not mounted in E2E window" };
    } else {
      await cdp.evaluate("window.__GSAP_E2E__.clearAttachedFiles()");
      await cdp.evaluate(`window.__GSAP_E2E__.setStore(${toExpr({
        models: noVisionModel,
        sessionModelsByPath: noVisionSessionModels,
      })})`);
      await cdp.evaluate(`window.__GSAP_E2E__.addImageAttachment(${toExpr({
        name: "blocked.png",
        base64Data: PNG_BASE64,
        mimeType: "image/png",
      })})`);
      await cdp.evaluate("window.__GSAP_E2E__.clickSendButton()");
      noVisionNotice = await waitFor(
        async () => {
          const text = await cdp.evaluate("window.__GSAP_E2E__.getInlineNoticeText()");
          return text && text.includes(localizedNoVision) ? text : null;
        },
        "no-vision notice",
        10000,
      );
      blockedAttachments = await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot().attachedFiles");
      noVisionStatus = {
        ok: !!noVisionNotice && Array.isArray(blockedAttachments) && blockedAttachments.length === 1,
        skipped: false,
        reason: "",
      };
    }

    await cdp.evaluate(`window.__GSAP_E2E__.setStore(${toExpr({
      models: originalModels,
      sessionModelsByPath: originalSessionModels,
    })})`);
    await cdp.evaluate("window.__GSAP_E2E__.clearAttachedFiles()");

    let visionReply = null;
    let visionStatus = { ok: false, skipped: false, reason: "" };

    const refreshedState = await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot()");
    const targetSessionPath = refreshedState.currentSessionPath || null;
    const availableVisionModels = (refreshedState.models || []).filter((model) => model.vision === true);

    if (!inputHelperReady) {
      visionStatus = { ok: false, skipped: true, reason: "chat input area not mounted in E2E window" };
    } else if (!targetSessionPath) {
      const created = await cdp.evaluate("window.__GSAP_E2E__.ensureSession()");
      if (!created) {
        visionStatus = { ok: false, skipped: true, reason: "no current session and ensureSession failed" };
      }
    }

    const stateForVision = await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot()");
    const finalSessionPath = stateForVision.currentSessionPath || null;

    if (!visionStatus.skipped) {
      if (!availableVisionModels.length) {
        visionStatus = { ok: false, skipped: true, reason: "no vision-capable model in current model list" };
      } else if (!finalSessionPath) {
        visionStatus = { ok: false, skipped: true, reason: "session path unavailable" };
      } else {
        const chosenModel = availableVisionModels.find((model) => model.isCurrent) || availableVisionModels[0];
        try {
          await cdp.evaluate(`window.__GSAP_E2E__.switchModel(${toExpr(chosenModel.id)}, ${toExpr(chosenModel.provider)}, ${toExpr(finalSessionPath)})`);
          await waitFor(
            async () => await cdp.evaluate(`(() => {
              const state = window.__GSAP_E2E__.getStateSnapshot();
              const sessionModel = state.sessionModelsByPath?.[${toExpr(finalSessionPath)}];
              const current = (state.models || []).find((model) => model.isCurrent);
              return sessionModel?.id === ${toExpr(chosenModel.id)}
                && sessionModel?.provider === ${toExpr(chosenModel.provider)}
                && current?.id === ${toExpr(chosenModel.id)}
                && current?.provider === ${toExpr(chosenModel.provider)};
            })()`),
            "vision model selection",
            15000,
          );
        } catch (error) {
          visionStatus = { ok: false, skipped: false, reason: `vision model switch failed: ${error.message}` };
        }
      }
    }

    if (!visionStatus.skipped && finalSessionPath) {
      const baselineItems = await cdp.evaluate(`window.__GSAP_E2E__.getSessionMessages(${toExpr(finalSessionPath)})`);
      const baselineAssistantCount = (baselineItems || []).filter((item) => item?.type === "message" && item.data?.role === "assistant").length;

      await cdp.evaluate("window.__GSAP_E2E__.clearAttachedFiles()");
      await cdp.evaluate(`window.__GSAP_E2E__.addImageAttachment(${toExpr({
        name: "vision-check.png",
        base64Data: PNG_BASE64,
        mimeType: "image/png",
      })})`);
      await cdp.evaluate(`window.__GSAP_E2E__.setInputText(${toExpr("请简短描述这张图片。")})`);
      await cdp.evaluate("window.__GSAP_E2E__.clickSendButton()");

      try {
        visionReply = await waitForAssistantReply(cdp, finalSessionPath, baselineAssistantCount, 90000);
        visionStatus = { ok: true, skipped: false, reason: "" };
      } catch (error) {
        visionStatus = { ok: false, skipped: false, reason: error.message };
      }
    }

    let finalState = null;
    let finalStateError = null;
    let runtimeDiagnostics = null;
    let runtimeDiagnosticsError = null;
    try {
      finalState = await cdp.evaluate("window.__GSAP_E2E__.getStateSnapshot()");
    } catch (error) {
      finalStateError = error?.message || String(error);
    }
    try {
      runtimeDiagnostics = await cdp.evaluate("window.__GSAP_E2E__.callApi('/api/diagnostics/runtime')");
    } catch (error) {
      runtimeDiagnosticsError = error?.message || String(error);
    }

    const checks = {
      dragPng: {
        ok: Array.isArray(dragPng) && dragPng[0]?.mimeType === "image/png" && !!dragPng[0]?.base64Data,
        attachment: Array.isArray(dragPng) ? dragPng[0] : null,
      },
      dragSvg: {
        ok: Array.isArray(dragSvg) && dragSvg[0]?.mimeType === "image/png" && !!dragSvg[0]?.base64Data,
        attachment: Array.isArray(dragSvg) ? dragSvg[0] : null,
      },
      pasteImage: {
        ok: pasted?.mimeType === "image/png" && !!pasted?.base64Data,
        attachment: pasted,
      },
      noVisionPrompt: {
        ...noVisionStatus,
        notice: noVisionNotice,
        attachmentsAfterClick: blockedAttachments,
      },
      visionReply: {
        ...visionStatus,
        reply: visionReply,
      },
    };
    const ok = checks.dragPng.ok
      && checks.dragSvg.ok
      && checks.pasteImage.ok
      && (checks.noVisionPrompt.ok || checks.noVisionPrompt.skipped)
      && (checks.visionReply.ok || checks.visionReply.skipped);

    const result = {
      ok,
      remoteDebugPort,
      checks,
      diagnostics: {
        state: finalState,
        stateError: finalStateError,
        runtimeDiagnostics,
        runtimeDiagnosticsError,
        mockOpenAIRequests: summarizeMockOpenAIRequests(mockOpenAI.requests),
        inputHelperReady,
        childExit,
        cdpCloseInfo: cdp?.getCloseInfo?.() || null,
        cdpOpen: cdp?.isOpen?.() ?? false,
        cdpEvents: cdp?.getEvents?.() || [],
        stdoutTail: capturedStdout.slice(-4000),
        stderrTail: capturedStderr.slice(-4000),
      },
    };

    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    console.log(`[e2e-image-input] wrote ${RESULT_PATH}`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    fs.writeFileSync(RESULT_PATH, JSON.stringify({
      ok: false,
      error: { message: error.message, stack: error.stack },
      diagnostics: {
        childExit,
        cdpCloseInfo: cdp?.getCloseInfo?.() || null,
        cdpOpen: cdp?.isOpen?.() ?? false,
        cdpEvents: cdp?.getEvents?.() || [],
        stdoutTail: capturedStdout.slice(-4000),
        stderrTail: capturedStderr.slice(-4000),
      },
    }, null, 2));
    console.error("[e2e-image-input]", error);
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch {}
    killProcessTree(child);
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    await mockOpenAI.close().catch(() => {});
    if (process.env.GSAP_E2E_KEEP_HOME === "1") {
      console.log(`[e2e-image-input] preserved ${e2eHome}`);
    } else {
      removeE2EHome(e2eHome);
    }
  }
}

main();
