#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import YAML from "js-yaml";
import WebSocket from "ws";
import {
  createIsolatedE2EHome,
  getAvailablePort,
  removeE2EHome,
  startMockOpenAI,
} from "./e2e-env.mjs";
import { desktopLaunchCommand, desktopLaunchEnv } from "./e2e-desktop-launcher.mjs";

const ROOT = process.cwd();
const RESULT_PATH = path.join(ROOT, "tmp-e2e-media-settings-defaults-result.json");
const STARTUP_TIMEOUT_MS = 90_000;

let capturedStdout = "";
let capturedStderr = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, label, timeoutMs = 30_000) {
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

async function listTargets(remoteDebugPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${remoteDebugPort}/json/list`);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function getPageTarget(remoteDebugPort, urlPart) {
  const targets = await listTargets(remoteDebugPort);
  return targets.find((target) => target.type === "page" && String(target.url || "").includes(urlPart)) || null;
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
    const promise = new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
    });
    ws.send(JSON.stringify({ id: requestId, method, params }));
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
      // Fall through.
    }
  }
  try { child.kill("SIGKILL"); } catch {}
}

function seedActualMediaModels(homeDir, mockBaseUrl) {
  const addedModelsPath = path.join(homeDir, "added-models.yaml");
  const raw = fs.existsSync(addedModelsPath)
    ? YAML.load(fs.readFileSync(addedModelsPath, "utf-8")) || {}
    : {};
  raw.providers ||= {};
  raw.providers.openai = {
    ...(raw.providers.openai || {}),
    display_name: "E2E OpenAI Image",
    base_url: mockBaseUrl,
    api: "openai-completions",
    api_key: "local",
    models: [
      { id: "gpt-image-1", name: "E2E GPT Image 1", type: "image" },
    ],
  };
  raw.providers.volcengine = {
    ...(raw.providers.volcengine || {}),
    display_name: "E2E Volcengine Video",
    base_url: mockBaseUrl,
    api: "openai-completions",
    api_key: "local",
    models: [
      { id: "doubao-seedance-2-0-260128", name: "E2E Seedance 2.0", type: "video" },
    ],
  };
  raw.providers["e2e-media"] = {
    ...(raw.providers["e2e-media"] || {}),
    display_name: "E2E Media Provider",
    base_url: mockBaseUrl,
    api: "openai-completions",
    api_key: "local",
    models: [
      { id: "gptimage2", name: "E2E Image Model", type: "image" },
      { id: "e2e-video-model", name: "E2E Video Model", type: "video" },
    ],
  };
  fs.writeFileSync(
    addedModelsPath,
    YAML.dump(raw, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
    "utf-8",
  );
}

async function readSelectValue(cdp, testId) {
  return await cdp.evaluate(`document.querySelector(${toExpr(`[data-testid="${testId}"]`)})?.value || null`);
}

async function hasSelectOption(cdp, testId, value) {
  return await cdp.evaluate(`(() => {
    const el = document.querySelector(${toExpr(`[data-testid="${testId}"]`)});
    if (!el) return false;
    return Array.from(el.options || []).some((option) => option.value === ${toExpr(value)});
  })()`);
}

async function setSelectValue(cdp, testId, value) {
  return await cdp.evaluate(`(() => {
    const el = document.querySelector(${toExpr(`[data-testid="${testId}"]`)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, ${toExpr(value)});
    else el.value = ${toExpr(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function readMediaSettingsSurfaceStyle(cdp) {
  return await cdp.evaluate(`(() => {
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        display: style.display,
        flexDirection: style.flexDirection,
        borderTopStyle: style.borderTopStyle,
        borderLeftStyle: style.borderLeftStyle,
        backgroundColor: style.backgroundColor,
        width: style.width,
        height: style.height,
      };
    };
    return {
      list: read('.pv-list'),
      item: read('.pv-list-item'),
      moduleButton: read('.media-module-button'),
      defaultSelect: read('[data-testid="media-defaultImageModel"]'),
    };
  })()`);
}

async function readProviderSettingsSurfaceStyle(cdp) {
  return await cdp.evaluate(`(() => {
    const read = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      return {
        display: style.display,
        flexDirection: style.flexDirection,
        borderTopStyle: style.borderTopStyle,
        borderLeftStyle: style.borderLeftStyle,
        backgroundColor: style.backgroundColor,
        width: style.width,
        height: style.height,
      };
    };
    return {
      layout: read('.pv-layout'),
      list: read('.pv-list'),
      item: read('.pv-list-item'),
      detail: read('.pv-detail'),
    };
  })()`);
}

function assertMediaSettingsSurfaceStyle(style) {
  if (style?.list?.display !== "flex" || style.list.flexDirection !== "column") {
    throw new Error("media settings provider list is not using the themed flex layout");
  }
  if (style?.item?.display !== "flex" || style.item.borderLeftStyle === "none") {
    throw new Error("media settings provider item is rendering like an unthemed native button");
  }
  if (!style?.moduleButton || style.moduleButton.borderTopStyle === "none") {
    throw new Error("media module switcher is missing themed button styles");
  }
  if (!style?.defaultSelect || style.defaultSelect.height === "auto") {
    throw new Error("media default model select is missing themed control styles");
  }
}

function assertProviderSettingsSurfaceStyle(style) {
  if (style?.layout?.display !== "flex") {
    throw new Error("provider settings shell is not using the themed layout card");
  }
  if (style?.list?.display !== "flex" || style.list.flexDirection !== "column") {
    throw new Error("provider settings list is not using the themed flex layout");
  }
  if (style?.item?.display !== "flex" || style.item.borderLeftStyle === "none") {
    throw new Error("provider settings item is rendering like an unthemed native button");
  }
  if (!style?.detail || style.detail.display === "none") {
    throw new Error("provider settings detail pane is missing");
  }
}

async function main() {
  const remoteDebugPort = Number(process.env.GSAP_E2E_REMOTE_DEBUG_PORT || await getAvailablePort());
  const mockOpenAI = await startMockOpenAI({
    models: [
      { id: "gptimage2", owned_by: "e2e-media" },
      { id: "e2e-video-model", owned_by: "e2e-media" },
    ],
  });
  const e2eHome = createIsolatedE2EHome({ mockBaseUrl: mockOpenAI.baseUrl });
  seedActualMediaModels(e2eHome, mockOpenAI.baseUrl);

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

  let mainCdp = null;
  let settingsCdp = null;
  let settingsUsesMainTarget = false;
  try {
    const mainTarget = await waitFor(() => getPageTarget(remoteDebugPort, "index.html"), "main page target", STARTUP_TIMEOUT_MS);
    mainCdp = createCdpClient(mainTarget.webSocketDebuggerUrl);
    await mainCdp.ready;
    await mainCdp.send("Runtime.enable");
    await waitFor(
      async () => await mainCdp.evaluate(
        "typeof window.__GSAP_RUNTIME_DIAGNOSTICS__ !== 'undefined' && window.__GSAP_E2E__?.appReady === true",
      ),
      "renderer e2e helper",
      STARTUP_TIMEOUT_MS,
    );

    await mainCdp.evaluate("window.__GSAP_E2E__.openSettings('media')");
    settingsCdp = mainCdp;
    settingsUsesMainTarget = true;

    await waitFor(
      async () => await settingsCdp.evaluate("!!document.querySelector('[data-testid=\"media-defaultImageModel\"]')"),
      "media defaults controls",
      STARTUP_TIMEOUT_MS,
    );

    const imageValue = "e2e-media/gptimage2";
    const videoValue = "e2e-media/e2e-video-model";
    await waitFor(
      async () => await hasSelectOption(settingsCdp, "media-defaultImageModel", imageValue)
        && await hasSelectOption(settingsCdp, "media-defaultVideoModel", videoValue),
      "media default model options",
      STARTUP_TIMEOUT_MS,
    );
    const surfaceStyle = await readMediaSettingsSurfaceStyle(settingsCdp);
    assertMediaSettingsSurfaceStyle(surfaceStyle);
    const imageSet = await setSelectValue(settingsCdp, "media-defaultImageModel", imageValue);
    const videoSet = await setSelectValue(settingsCdp, "media-defaultVideoModel", videoValue);
    if (!imageSet || !videoSet) throw new Error("media default selectors not available");

    await waitFor(async () => {
      const config = await mainCdp.evaluate(`window.__GSAP_E2E__.callApi('/api/plugins/image-gen/providers?agentId=gsap')`);
      return config?.config?.defaultImageModel?.id === "gptimage2"
        && config?.config?.defaultImageModel?.provider === "e2e-media"
        && config?.config?.defaultVideoModel?.id === "e2e-video-model"
        && config?.config?.defaultVideoModel?.provider === "e2e-media"
        ? config
        : null;
    }, "media defaults saved through API", STARTUP_TIMEOUT_MS);

    await mainCdp.evaluate("window.__GSAP_E2E__.openSettings('media')");
    await waitFor(async () => {
      const image = await readSelectValue(settingsCdp, "media-defaultImageModel");
      const video = await readSelectValue(settingsCdp, "media-defaultVideoModel");
      return image === imageValue && video === videoValue ? { image, video } : null;
    }, "media defaults echoed in reopened settings page", STARTUP_TIMEOUT_MS);

    const clearImage = await setSelectValue(settingsCdp, "media-defaultImageModel", "");
    const clearVideo = await setSelectValue(settingsCdp, "media-defaultVideoModel", "");
    if (!clearImage || !clearVideo) throw new Error("media default selectors could not be cleared");
    await waitFor(async () => {
      const config = await mainCdp.evaluate(`window.__GSAP_E2E__.callApi('/api/plugins/image-gen/providers?agentId=gsap')`);
      const image = config?.config?.defaultImageModel;
      const video = config?.config?.defaultVideoModel;
      return image == null && video == null ? config : null;
    }, "media defaults cleared through API", STARTUP_TIMEOUT_MS);

    await mainCdp.evaluate("window.__GSAP_E2E__.openSettings('providers')");
    await waitFor(
      async () => await settingsCdp.evaluate("!!document.querySelector('.pv-list-item') && !!document.querySelector('.pv-detail')"),
      "provider settings themed controls",
      STARTUP_TIMEOUT_MS,
    );
    const providerSurfaceStyle = await readProviderSettingsSurfaceStyle(settingsCdp);
    assertProviderSettingsSurfaceStyle(providerSurfaceStyle);

    const result = {
      ok: true,
      e2eHome,
      saved: { imageValue, videoValue },
      cleared: true,
      surfaceStyle,
      providerSurfaceStyle,
    };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + "\n");
    console.log("Media settings defaults desktop E2E passed");
  } catch (err) {
    let diagnostics = null;
    try {
      diagnostics = {
        providersPayload: mainCdp
          ? await mainCdp.evaluate(`window.__GSAP_E2E__?.callApi('/api/plugins/image-gen/providers?agentId=gsap')`)
          : null,
        selectOptions: settingsCdp
          ? await settingsCdp.evaluate(`(() => {
              const read = (testId) => Array.from(document.querySelector(\`[data-testid="\${testId}"]\`)?.options || [])
                .map((option) => ({ value: option.value, text: option.textContent }));
              return {
                image: read('media-defaultImageModel'),
                audio: read('media-defaultAudioModel'),
                music: read('media-defaultMusicModel'),
                video: read('media-defaultVideoModel'),
              };
            })()`)
          : null,
      };
    } catch (diagnosticErr) {
      diagnostics = { error: diagnosticErr?.message || String(diagnosticErr) };
    }
    const result = {
      ok: false,
      error: err?.message || String(err),
      e2eHome,
      diagnostics,
      stdoutTail: capturedStdout.slice(-4000),
      stderrTail: capturedStderr.slice(-4000),
    };
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2) + "\n");
    throw err;
  } finally {
    if (!settingsUsesMainTarget) settingsCdp?.close();
    mainCdp?.close();
    killProcessTree(child);
    await mockOpenAI.close().catch(() => {});
    if (process.env.GSAP_E2E_KEEP_HOME !== "1") {
      removeE2EHome(e2eHome);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
