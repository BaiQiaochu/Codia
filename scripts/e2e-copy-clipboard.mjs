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
const RESULT_PATH = path.join(ROOT, "tmp-e2e-copy-result.json");
let capturedStdout = "";
let capturedStderr = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(300);
  }
}

async function getPageTarget(remoteDebugPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/list`);
    if (!res.ok) return null;
    const targets = await res.json();
    return targets.find((t) => t.type === "page" && String(t.url || "").includes("index.html")) || null;
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
  const mockOpenAI = await startMockOpenAI({ reply: "E2E copy reply." });
  const e2eHome = createIsolatedE2EHome({ mockBaseUrl: mockOpenAI.baseUrl });
  let child = null;
  let cdp = null;

  try {
    child = spawn(
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
    process.once("exit", () => killProcessTree(child));

    const target = await waitFor(() => getPageTarget(remoteDebugPort), "electron page target");
    cdp = createCdpClient(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");

    const diagnostics = {
      readyState: await cdp.evaluate("document.readyState").catch(() => null),
      hasCodia: await cdp.evaluate("typeof window.codia !== 'undefined'").catch(() => null),
      hasE2EFlag: await cdp.evaluate("typeof window.codia?.isE2EMode !== 'undefined'").catch(() => null),
      hasHelper: await cdp.evaluate("typeof window.__CODIA_E2E__ !== 'undefined'").catch(() => null),
    };

    await waitFor(
      async () => await cdp.evaluate(
        "typeof window.__CODIA_RUNTIME_DIAGNOSTICS__ !== 'undefined' && window.__CODIA_E2E__?.appReady === true",
      ),
      "renderer app ready",
      60000,
    );

  const multiSelectItems = [
    {
      type: "message",
      data: {
        id: "u1",
        role: "user",
        quotedText: "quoted request",
        text: "user body",
        attachments: [{ path: "C:\\tmp\\doc.md", name: "doc.md", isDir: false }],
      },
    },
    {
      type: "message",
      data: {
        id: "a1",
        role: "assistant",
        blocks: [
          { type: "tool_group", collapsed: false, tools: [{ name: "read", done: true, success: true, args: { path: "/tmp/doc.md" } }] },
          { type: "plugin_card", card: { pluginId: "image-gen", route: "/card?batch=1", title: "Preview Card", description: "card desc", type: "text" } },
          { type: "text", html: "<p>assistant answer</p>" },
        ],
      },
    },
  ];

  const assistantCardItems = [
    {
      type: "message",
      data: {
        id: "a2",
        role: "assistant",
        blocks: [
          { type: "file", filePath: "C:\\tmp\\hello.png", label: "hello.png", ext: "png" },
          { type: "artifact", artifactId: "art-1", artifactType: "markdown", title: "Artifact Title", content: "body" },
          { type: "plugin_card", card: { pluginId: "image-gen", route: "/card?batch=2", title: "Image Card", description: "Generated image", type: "text" } },
          { type: "text", html: "<p>final answer</p>" },
        ],
      },
    },
  ];

  const multiSession = await cdp.evaluate(`window.__CODIA_E2E__.seedCopySession({ sessionPath: "/__e2e__/multi", items: ${toExpr(multiSelectItems)} })`);
  await cdp.evaluate(`window.__CODIA_E2E__.selectMessages(${toExpr(multiSession)}, ["u1", "a1"])`);
  await waitFor(
    async () => await cdp.evaluate(`!!document.querySelector('[data-message-id="a1"]')`),
    "multi-select copy target",
  );
  await cdp.evaluate(`window.__CODIA_E2E__.copySelection(${toExpr(multiSession)}, "a1")`);
  const multiClipboard = await waitFor(
    async () => {
      const text = await cdp.evaluate(`window.__CODIA_E2E__.readClipboardText()`);
      return String(text).includes("quoted request") ? text : null;
    },
    "multi-select clipboard",
    5000,
  );
  for (const expected of ["quoted request", "user body", "doc.md", "read", "Preview Card", "assistant answer"]) {
    if (!String(multiClipboard).includes(expected)) {
      throw new Error(`multi-select clipboard missing ${expected}`);
    }
  }

  const singleSession = await cdp.evaluate(`window.__CODIA_E2E__.seedCopySession({ sessionPath: "/__e2e__/assistant", items: ${toExpr(assistantCardItems)} })`);
  await waitFor(
    async () => await cdp.evaluate(`!!document.querySelector('[data-message-id="a2"]')`),
    "assistant copy target",
  );
  await cdp.evaluate(`window.__CODIA_E2E__.copySelection(${toExpr(singleSession)}, "a2")`);
  const assistantClipboard = await waitFor(
    async () => {
      const text = await cdp.evaluate(`window.__CODIA_E2E__.readClipboardText()`);
      return String(text).includes("hello.png") ? text : null;
    },
    "assistant clipboard",
    5000,
  );
  for (const expected of ["hello.png", "Artifact Title", "Image Card", "Generated image", "final answer"]) {
    if (!String(assistantClipboard).includes(expected)) {
      throw new Error(`assistant clipboard missing ${expected}`);
    }
  }

  const result = {
    ok: true,
    remoteDebugPort,
    sessions: {
      multiSession,
      singleSession,
    },
    clipboard: {
      multiSelect: multiClipboard,
      assistantSingle: assistantClipboard,
    },
    logs: {
      stdoutTail: capturedStdout.slice(-4000),
      stderrTail: capturedStderr.slice(-4000),
    },
  };

    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    console.log(`[e2e-copy] wrote ${RESULT_PATH}`);
  } finally {
    if (cdp) cdp.close();
    killProcessTree(child);
    await mockOpenAI.close().catch(() => {});
    removeE2EHome(e2eHome);
  }
}

main().catch((error) => {
  fs.writeFileSync(RESULT_PATH, JSON.stringify({
    ok: false,
    error: { message: error.message, stack: error.stack },
    diagnostics: {
      stdoutTail: capturedStdout.slice(-4000),
      stderrTail: capturedStderr.slice(-4000),
    },
  }, null, 2));
  console.error("[e2e-copy]", error);
  process.exit(1);
});
