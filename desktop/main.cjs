
const { app, BrowserWindow, WebContentsView, globalShortcut, ipcMain, dialog, session, shell, nativeTheme, Tray, Menu, nativeImage, systemPreferences, Notification, clipboard, webContents, screen, protocol, powerSaveBlocker } = require("electron");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { PNG } = require("pngjs");
const chokidar = require("chokidar");
const { buildWatermarkPayload, watermarkGeneratedFileSync, writePngWatermark } = require("../shared/dark-watermark.cjs");
const { wrapIpcHandler, wrapIpcBestEffortHandler, wrapIpcOn } = require('./ipc-wrapper.cjs');
const { initAutoUpdater, checkForUpdatesAuto, setMainWindow: setUpdaterMainWindow, setUpdateChannel, getState: getUpdateState } = require("./auto-updater.cjs");
const { getAutoLaunchStatus, setAutoLaunchEnabled } = require("./login-item-settings.cjs");
const {
  DEFAULT_CODIA_HOME,
  applyCodiaHomeEnv,
  configureProcessPiSdkEnv,
  ensureCodiaPiSdkDirs,
  resolveCodiaHome,
  resolveServerInfoPath,
  withCodiaPiSdkEnv,
} = require('./codia-home.cjs');
const { resolveServerBinary, resolveServerLaunchConfig } = require("./server-runtime.cjs");
const { buildWin32ServerEnv } = require("./src/shared/server-process-env.cjs");
const {
  createWindowStateSaver,
  loadWindowState,
  sanitizeWindowState,
} = require("./src/shared/window-state.cjs");
const { createFileWatchRegistry } = require("./file-watch-registry.cjs");
const { createStableFileWatcher } = require("./file-watch-adapter.cjs");
const { createWorkspaceWatchRegistry } = require("./workspace-watch-registry.cjs");
const { readTextFileSnapshot, writeTextFileIfUnchanged } = require("./file-text-io.cjs");
const themeRegistry = require("./src/shared/theme-registry.cjs");
const { resolveTrashItemPath } = require("./src/shared/trash-item-path.cjs");
const {
  applyGpuStartupPolicy,
  buildGpuStartupDiagnostics,
  markGpuStartupFailed,
  markGpuStartupPending,
  markGpuStartupPhase,
  markGpuStartupReady,
  recordGpuChildProcessGone,
  recordGpuInfoUpdate,
  resolveGpuStartupPolicy,
} = require("./src/shared/gpu-startup-policy.cjs");
const {
  configureClientSingleInstance,
  focusExistingWindow,
} = require("./src/shared/single-instance-lock.cjs");
const {
  buildBrowserSearchExtractionScript,
  buildBrowserSearchUrl,
} = require("../lib/browser/browser-search-extractors.cjs");
const {
  waitForBrowserState,
} = require("./src/shared/browser-wait.cjs");
const {
  ensureServerFilesReady,
  isModuleResolutionError,
  parsePortInUseStartupError,
  extractRootServerStartupError,
  SERVER_INFO_FIRST_WAIT_MS,
  shouldKeepWaitingForServerInfo,
} = require("./src/shared/server-readiness.cjs");
const {
  normalizeNetworkProxyConfig,
  electronProxyRulesForConfig,
  electronProxyBypassRulesForConfig,
  proxyConfigToEnvironment,
  systemProxyConfigToEnvironment,
} = require("../shared/network-proxy.cjs");
const {
  completeOnboardingAndOpenMain,
  submitOnboardingCompleteIntent,
} = require("./src/shared/onboarding-completion.cjs");
const {
  resolveWorkspaceOutputDir,
} = require("../shared/workspace-output.cjs");
const { createKeepAwakeManager } = require("./keep-awake.cjs");
const {
  normalizeDesktopNotificationOptions,
  shouldSuppressDesktopNotification,
} = require("./src/shared/desktop-notification-policy.cjs");
const { resolveAgentAvatarPath } = require("./src/shared/agent-avatar-path.cjs");
const {
  normalizeQuickChatPreferences,
} = require("../shared/quick-chat-preferences.cjs");
const {
  createDesktopLaunchDiagnostics,
} = require("./src/shared/desktop-launch-diagnostics.cjs");

const APP_USER_MODEL_ID = "io.github.baiqiaochu.codia";
const RUNTIME_DISPLAY_NAME = "Codia";
let _cachedWindowIcon = undefined;

function runtimeProductName() {
  return RUNTIME_DISPLAY_NAME;
}

function runtimeDisplayName() {
  return RUNTIME_DISPLAY_NAME;
}

function runtimeAppUserModelId() {
  return APP_USER_MODEL_ID;
}

function resolveProductIconFilenames() {
  const name = runtimeProductName();
  return [`${name}.png`, `${name}.ico`, "codia.png", "codia.ico"];
}

function resolveRuntimeBrandImagePath() {
  const candidates = [];
  candidates.push(path.join(__dirname, "src", "assets", "codia.png"));
  return candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || "";
}

function resolveRuntimeDefaultAssistantAvatarPath() {
  const candidates = [
    path.join(__dirname, "src", "assets", "character-cards", "codia-default-avatar.png"),
    path.join(__dirname, "src", "assets", "codia.png"),
  ];
  return candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || "";
}

function isPortableWindowsBuild() {
  if (process.platform !== "win32" || !app.isPackaged) return false;
  try {
    const exeDir = path.dirname(process.execPath);
    return resolveProductIconFilenames().some((name) => fs.existsSync(path.join(exeDir, name)));
  } catch {
    return false;
  }
}

function resolveWindowIconPath() {
  const candidates = [];
  if (app.isPackaged && process.resourcesPath) {
    if (process.platform === "win32") {
      const exeDir = path.dirname(process.execPath);
      for (const name of resolveProductIconFilenames()) {
        candidates.push(path.join(exeDir, name));
      }
    }
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "desktop", "src", "icon.png"));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "desktop", "src", "icon.ico"));
  }
  candidates.push(path.join(__dirname, "src", "icon.png"));
  candidates.push(path.join(__dirname, "src", "icon.ico"));
  return candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || "";
}

function resolveTrayIconPath() {
  const candidates = [];
  if (app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "desktop", "src", "icon.ico"));
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "desktop", "src", "icon.png"));
  }
  candidates.push(path.join(__dirname, "src", "icon.ico"));
  candidates.push(path.join(__dirname, "src", "icon.png"));
  candidates.push(path.join(__dirname, "src", "assets", "tray.ico"));
  candidates.push(path.join(__dirname, "src", "assets", "tray-template.png"));
  return candidates.find(p => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || "";
}

function windowIconOption() {
  if (process.platform === "darwin") return {};
  if (_cachedWindowIcon !== undefined) {
    return _cachedWindowIcon ? { icon: _cachedWindowIcon } : {};
  }

  const iconPath = resolveWindowIconPath();
  if (!iconPath) {
    _cachedWindowIcon = null;
    return {};
  }

  const icon = nativeImage.createFromPath(iconPath);
  _cachedWindowIcon = icon && !icon.isEmpty()
    ? { icon: process.platform === "win32" ? iconPath : icon }
    : null;
  return _cachedWindowIcon || {};
}

// Source startup prepares its sandbox preload outside the checkout. Packaged
// apps always use their bundled preload and ignore development overrides.
const PRELOAD_PATH = !app.isPackaged && process.env.CODIA_DEV_PRELOAD_PATH
  ? path.resolve(process.env.CODIA_DEV_PRELOAD_PATH)
  : path.join(__dirname, "preload.bundle.cjs");
if (!fs.existsSync(PRELOAD_PATH)) {
  const msg = `Missing preload:\n${PRELOAD_PATH}\n\nStart the source checkout with 'npm start'. For packaged builds, run 'npm run build:preload'.`;
  try { dialog.showErrorBox(`${runtimeProductName()} failed to start`, msg); } catch {}
  console.error("[desktop] " + msg);
  process.exit(1);
}


// Resolve a full login-shell PATH without blocking Electron startup.
function resolveLoginShellPath() {
  if (process.platform === "win32") return Promise.resolve();
  return new Promise((resolve) => {
    const loginShell = process.env.SHELL || "/bin/zsh";
    execFile(loginShell, ["-l", "-c", "printenv PATH"], { timeout: 5000, encoding: "utf8" }, (err, stdout) => {
      if (!err && stdout) {
        const resolved = stdout.trim();
        if (resolved) process.env.PATH = resolved;
      }
      resolve();
    });
  });
}

function safeReadJSON(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch (err) {
    console.error(`[safeReadJSON] ${filePath}: ${err.message}`);
    return fallback;
  }
}

function safeReadExistingJSON(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
  } catch {
    return fallback;
  }
  return safeReadJSON(filePath, fallback);
}

const codiaHome = resolveCodiaHome();
applyCodiaHomeEnv(codiaHome);
ensureCodiaPiSdkDirs(codiaHome);
configureProcessPiSdkEnv(codiaHome);
const desktopServerInfoPath = resolveServerInfoPath(codiaHome, { CODIA_SERVER_SCOPE: "desktop" }, "desktop");
const preferencesPath = path.join(codiaHome, "user", "preferences.json");
const keepAwakeManager = createKeepAwakeManager({ powerSaveBlocker });
const desktopStartupId = `${Date.now()}-${process.pid}`;
function redactMainLogText(value) {
  return String(value)
    .replaceAll(os.homedir(), "<home>")
    .replaceAll(codiaHome, "<codia-home>");
}
const desktopLaunchDiagnostics = createDesktopLaunchDiagnostics({
  codiaHome,
  startupId: desktopStartupId,
  appVersion: app?.getVersion?.() || "unknown",
  platform: process.platform,
  arch: process.arch,
  redactText: redactMainLogText,
});
try {
  desktopLaunchDiagnostics.reset({
    pid: process.pid,
    argv: process.argv.slice(0, 20),
    packaged: !!app.isPackaged,
  });
} catch {}

function writeDesktopLaunchDiagnostic(event, details = {}) {
  desktopLaunchDiagnostics.append(event, details);
}
const gpuStartupPolicy = resolveGpuStartupPolicy({
  codiaHome,
  platform: process.platform,
  argv: process.argv,
  env: process.env,
});
applyGpuStartupPolicy(app, gpuStartupPolicy);
if (process.platform === "win32") {
  try {
    markGpuStartupPending({
      codiaHome,
      platform: process.platform,
      phase: "electron-starting",
      startupId: desktopStartupId,
      policy: gpuStartupPolicy,
    });
  } catch (err) {
    console.warn("[desktop] failed to mark GPU startup pending:", err.message);
  }
}
const MAX_GENERIC_BASE64_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const IMAGE_ATTACHMENT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".ico"]);
function isImageAttachmentPath(filePath) {
  return IMAGE_ATTACHMENT_EXTENSIONS.has(path.extname(String(filePath || "")).toLowerCase());
}

function readNetworkProxyPreference() {
  const prefsPath = path.join(codiaHome, "user", "preferences.json");
  const prefs = safeReadExistingJSON(prefsPath, {});
  return normalizeNetworkProxyConfig(prefs?.network_proxy);
}

function readKeepAwakePreference() {
  const prefs = safeReadExistingJSON(preferencesPath, {});
  return prefs?.keep_awake === true;
}

function readQuickChatPreferences() {
  const prefs = safeReadExistingJSON(preferencesPath, {});
  return normalizeQuickChatPreferences(prefs?.quick_chat);
}

async function applyDesktopNetworkProxy(config, { reason = "runtime" } = {}) {
  const normalized = normalizeNetworkProxyConfig(config);
  const ses = session.defaultSession;
  if (!ses) return normalized;

  if (normalized.mode === "direct") {
    await ses.setProxy({ mode: "direct" });
  } else if (normalized.mode === "manual") {
    await ses.setProxy({
      mode: "fixed_servers",
      proxyRules: electronProxyRulesForConfig(normalized),
      proxyBypassRules: electronProxyBypassRulesForConfig(normalized),
    });
  } else {
    await ses.setProxy({ mode: "system" });
  }

  console.log(`[desktop] network proxy applied (${reason}): ${normalized.mode}`);
  return normalized;
}

function parseElectronProxyList(proxyList) {
  const first = String(proxyList || "")
    .split(";")
    .map(item => item.trim())
    .find(item => item && item.toUpperCase() !== "DIRECT");
  if (!first) return "";

  const match = first.match(/^([A-Z0-9]+)\s+(.+)$/i);
  if (!match) return "";
  const type = match[1].toUpperCase();
  const server = match[2].trim();
  if (!server) return "";

  if (type === "SOCKS5") return `socks5://${server}`;
  if (type === "SOCKS") return `socks://${server}`;
  if (type === "HTTPS") return `https://${server}`;
  return `http://${server}`;
}

async function resolveElectronProxyUrl(targetUrl) {
  try {
    return parseElectronProxyList(await session.defaultSession.resolveProxy(targetUrl));
  } catch {
    return "";
  }
}

async function serverEnvironmentForNetworkProxy(baseEnv) {
  const config = readNetworkProxyPreference();
  if (config.mode === "manual" || config.mode === "direct") {
    return proxyConfigToEnvironment(config, baseEnv);
  }

  const [httpProxy, httpsProxy, wsProxy, wssProxy] = await Promise.all([
    resolveElectronProxyUrl("http://example.com"),
    resolveElectronProxyUrl("https://example.com"),
    resolveElectronProxyUrl("ws://example.com"),
    resolveElectronProxyUrl("wss://example.com"),
  ]);
  return systemProxyConfigToEnvironment({
    httpProxy,
    httpsProxy,
    wsProxy,
    wssProxy,
    noProxy: config.noProxy,
  }, baseEnv, config);
}


const defaultHome = DEFAULT_CODIA_HOME;
configureClientSingleInstance(app, {
  codiaHome,
  defaultHome,
  onSecondInstance: () => showPrimaryWindow(),
});

if (process.platform === "win32") {
  app.setAppUserModelId(runtimeAppUserModelId());
}

let splashWindow = null;
let mainWindow = null;
let onboardingWindow = null;
let quickChatWindow = null;
let quickChatMode = "compact";
let registeredQuickChatShortcut = null;
let activeMainWindowSessionPath = null;

let settingsWindow = null;

let browserViewerWindow = null;
let _browserWebView = null;
const _browserViews = new Map();
let _currentBrowserSession = null;
let _currentBrowserTabId = null;
let _browserAcceptCookies = true;
let _browserCookiePolicyInstalled = false;
const _viewerWindows = new Map();


const _isDev = process.argv.includes("--dev") || (!app.isPackaged && Boolean(process.env.VITE_DEV_URL));
const _isE2E = process.env.CODIA_E2E === "1";
const _distRenderer = path.join(__dirname, "dist-renderer");
const _remoteDebugPort = String(process.env.CODIA_E2E_REMOTE_DEBUG_PORT || "").trim();
const QUICK_CHAT_WIDTH = 480;
const QUICK_CHAT_COMPACT_HEIGHT = 142;
const QUICK_CHAT_CHAT_HEIGHT = 520;
const QUICK_CHAT_MIN_WIDTH = 360;
const QUICK_CHAT_MIN_HEIGHT = 118;
const quickChatWindowStatePath = path.join(codiaHome, "user", "quick-chat-window-state.json");

if (_isE2E) {
  const isolatedUserData = path.join(codiaHome, ".electron-user-data");
  fs.mkdirSync(isolatedUserData, { recursive: true });
  app.setPath("userData", isolatedUserData);
}

function normalizeActiveSessionPath(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function focusedWindowSessionPath(win) {
  if (!win || win.isDestroyed?.()) return null;
  if (mainWindow && !mainWindow.isDestroyed() && win.id === mainWindow.id) {
    return activeMainWindowSessionPath;
  }
  return null;
}

if (_remoteDebugPort) {
  app.commandLine.appendSwitch("remote-debugging-port", _remoteDebugPort);
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

function loadWindowURL(win, pageName, opts) {
  if (_isDev && process.env.VITE_DEV_URL) {
    let url = `${process.env.VITE_DEV_URL}/${pageName}.html`;
    if (opts?.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      url += `?${qs}`;
    }
    win.loadURL(url);
  } else {
    const built = path.join(_distRenderer, `${pageName}.html`);
    if (fs.existsSync(built)) {
      win.loadFile(built, opts);
    } else {
      win.loadFile(path.join(__dirname, "src", `${pageName}.html`), opts);
    }
  }
}

function attachRendererLaunchDiagnostics(win, label) {
  if (!win || win.isDestroyed?.()) return;
  const windowId = win.id;
  writeDesktopLaunchDiagnostic("window-created", {
    label,
    windowId: win.id,
    visible: win.isVisible?.() || false,
  });
  for (const eventName of ["show", "hide", "minimize", "restore", "close", "closed"]) {
    win.on(eventName, () => writeDesktopLaunchDiagnostic(`window-${eventName}`, {
      label, windowId,
      ...(!win.isDestroyed() ? {
        visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused(),
      } : {}),
    }));
  }
  const wc = win.webContents;
  if (!wc) return;

  wc.once("dom-ready", () => {
    writeDesktopLaunchDiagnostic("dom-ready", {
      label,
      windowId: win.id,
      url: wc.getURL?.() || "",
    });
  });
  wc.once("did-finish-load", () => {
    writeDesktopLaunchDiagnostic("did-finish-load", {
      label,
      windowId: win.id,
      url: wc.getURL?.() || "",
    });
  });
  wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeDesktopLaunchDiagnostic("did-fail-load", {
      label,
      windowId: win.id,
      errorCode,
      errorDescription,
      validatedURL,
    });
  });
  wc.on("render-process-gone", (_event, details) => {
    writeDesktopLaunchDiagnostic("render-process-gone", {
      label,
      windowId: win.id,
      reason: details?.reason || "unknown",
      exitCode: details?.exitCode,
    });
  });
  wc.on("console-message", (details) => {
    writeDesktopLaunchDiagnostic("console-message", {
      label,
      windowId: win.id,
      level: details?.level,
      message: details?.message,
      line: details?.lineNumber ?? details?.line,
      sourceId: details?.sourceId,
    });
  });
}

function quickChatHeightForMode(mode, requestedHeight = null) {
  const fallback = mode === "chat" ? QUICK_CHAT_CHAT_HEIGHT : QUICK_CHAT_COMPACT_HEIGHT;
  if (!Number.isFinite(requestedHeight)) return fallback;
  return Math.max(QUICK_CHAT_MIN_HEIGHT, Math.min(QUICK_CHAT_CHAT_HEIGHT, Math.round(requestedHeight)));
}

function loadQuickChatWindowState() {
  return safeReadExistingJSON(quickChatWindowStatePath, null);
}

function defaultQuickChatWindowState(mode, requestedHeight = null) {
  const height = quickChatHeightForMode(mode, requestedHeight);
  const workArea = screen.getPrimaryDisplay().workArea;
  return {
    x: workArea.x + workArea.width - QUICK_CHAT_WIDTH - 24,
    y: workArea.y + workArea.height - height - 72,
    width: QUICK_CHAT_WIDTH,
    height,
  };
}

function clampQuickChatWindowBounds(bounds) {
  const fallback = defaultQuickChatWindowState(quickChatMode);
  const width = Math.max(QUICK_CHAT_MIN_WIDTH, Math.min(QUICK_CHAT_WIDTH, Math.round(bounds?.width || fallback.width)));
  const height = Math.max(QUICK_CHAT_MIN_HEIGHT, Math.min(QUICK_CHAT_CHAT_HEIGHT, Math.round(bounds?.height || fallback.height)));
  const x = Number.isFinite(bounds?.x) ? Math.round(bounds.x) : fallback.x;
  const y = Number.isFinite(bounds?.y) ? Math.round(bounds.y) : fallback.y;
  const display = screen.getDisplayMatching({ x, y, width, height }) || screen.getPrimaryDisplay();
  const area = display.workArea || display.bounds;
  return {
    x: Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - width)),
    y: Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - height)),
    width,
    height,
  };
}

function resolveQuickChatWindowBounds(mode, state = loadQuickChatWindowState(), requestedHeight = null) {
  const height = quickChatHeightForMode(mode, requestedHeight);
  const base = state || defaultQuickChatWindowState(mode, requestedHeight);
  return clampQuickChatWindowBounds({
    ...base,
    width: QUICK_CHAT_WIDTH,
    height,
  });
}

let _saveQuickChatWindowStateTimer = null;
let _saveQuickChatWindowStateChain = Promise.resolve();
function saveQuickChatWindowState() {
  if (_saveQuickChatWindowStateTimer) clearTimeout(_saveQuickChatWindowStateTimer);
  _saveQuickChatWindowStateTimer = setTimeout(() => {
    _saveQuickChatWindowStateTimer = null;
    if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
    const bounds = quickChatWindow.getBounds();
    const state = {
      x: bounds.x,
      y: bounds.y,
      width: QUICK_CHAT_WIDTH,
      height: quickChatHeightForMode(quickChatMode),
    };
    _saveQuickChatWindowStateChain = _saveQuickChatWindowStateChain.then(async () => {
      await fs.promises.mkdir(path.dirname(quickChatWindowStatePath), { recursive: true });
      await fs.promises.writeFile(quickChatWindowStatePath, JSON.stringify(state, null, 2) + "\n");
    }).catch((err) => {
      console.error("[desktop] save quick chat window state failed:", err?.message || err);
    });
  }, 300);
}

function normalizeQuickChatResizeRequest(request) {
  if (request && typeof request === "object") {
    return {
      mode: request.mode === "chat" ? "chat" : "compact",
      height: Number.isFinite(request.height) ? request.height : null,
    };
  }
  return {
    mode: request === "chat" ? "chat" : "compact",
    height: null,
  };
}

function applyQuickChatMode(request) {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  const { mode, height } = normalizeQuickChatResizeRequest(request);
  quickChatMode = mode;
  const bounds = resolveQuickChatWindowBounds(quickChatMode, quickChatWindow.getBounds(), height);
  quickChatWindow.setBounds(bounds, true);
  saveQuickChatWindowState();
}

function createQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) return quickChatWindow;

  quickChatMode = "compact";
  const bounds = resolveQuickChatWindowBounds(quickChatMode);
  quickChatWindow = new BrowserWindow({
    ...bounds,
    minWidth: QUICK_CHAT_MIN_WIDTH,
    minHeight: QUICK_CHAT_MIN_HEIGHT,
    maxWidth: QUICK_CHAT_WIDTH,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: process.platform !== "darwin",
    frame: false,
    alwaysOnTop: true,
    title: "Codia Quick Chat",
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    show: false,
    acceptFirstMouse: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      // The window stays hidden behind the splash until React sends
      // `app-ready`. Throttling a hidden renderer would prevent the effects
      // responsible for that handshake from completing.
      backgroundThrottling: false,
    },
  });

  attachRendererLaunchDiagnostics(quickChatWindow, "quick-chat");
  loadWindowURL(quickChatWindow, "quick-chat");
  quickChatWindow.on("move", saveQuickChatWindowState);
  quickChatWindow.on("close", (event) => {
    if (!isQuitting && !_isUpdating && !forceQuitApp) {
      event.preventDefault();
      hideQuickChatWindow();
    }
  });
  quickChatWindow.on("closed", () => {
    quickChatWindow = null;
  });
  return quickChatWindow;
}

function suspendMainWindowFocusForQuickChatHide() {
  if (process.platform !== "darwin") return;
  if (!quickChatWindow || quickChatWindow.isDestroyed() || !quickChatWindow.isFocused()) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
  try {
    mainWindow.setFocusable(false);
    setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setFocusable(true);
      } catch {}
    }, 300);
  } catch (err) {
    console.warn("[desktop] quick chat focus guard failed:", err?.message || err);
  }
}

function hideQuickChatWindow() {
  if (!quickChatWindow || quickChatWindow.isDestroyed()) return;
  saveQuickChatWindowState();
  suspendMainWindowFocusForQuickChatHide();
  quickChatWindow.hide();
}

function showQuickChatWindow() {
  const win = createQuickChatWindow();
  if (win.isMinimized()) win.restore();
  try {
    win.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") {
      app.dock.show();
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
  } catch (err) {
    console.warn("[desktop] quick chat topmost failed:", err?.message || err);
  }
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  win.show();
  win.focus();
  win.webContents.send("quick-chat-shown");
}

function toggleQuickChatWindow() {
  if (quickChatWindow && !quickChatWindow.isDestroyed() && quickChatWindow.isVisible() && quickChatWindow.isFocused()) {
    hideQuickChatWindow();
    return;
  }
  showQuickChatWindow();
}

function registerQuickChatShortcut(shortcut = readQuickChatPreferences().shortcut) {
  if (registeredQuickChatShortcut && registeredQuickChatShortcut !== shortcut) {
    globalShortcut.unregister(registeredQuickChatShortcut);
    registeredQuickChatShortcut = null;
  }
  if (!shortcut || typeof shortcut !== "string") {
    return { ok: false, shortcut: shortcut || "", error: "invalid shortcut" };
  }
  if (registeredQuickChatShortcut === shortcut && globalShortcut.isRegistered(shortcut)) {
    return { ok: true, shortcut };
  }
  if (registeredQuickChatShortcut) {
    globalShortcut.unregister(registeredQuickChatShortcut);
    registeredQuickChatShortcut = null;
  }
  const ok = globalShortcut.register(shortcut, toggleQuickChatWindow);
  if (!ok) return { ok: false, shortcut, error: "shortcut is unavailable" };
  registeredQuickChatShortcut = shortcut;
  return { ok: true, shortcut };
}

function reloadQuickChatShortcut() {
  return registerQuickChatShortcut(readQuickChatPreferences().shortcut);
}

function registerQuickChatShortcutBestEffort() {
  const result = reloadQuickChatShortcut();
  if (!result.ok) {
    console.error("[desktop] quick chat shortcut registration failed:", result.error || result.shortcut || "unknown");
  }
  return result;
}


function isAllowedBrowserUrl(url) {
  try {
    const p = new URL(url);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch { return false; }
}

function normalizeManualBrowserUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  return isAllowedBrowserUrl(candidate) ? candidate : null;
}
let _browserViewerTheme = themeRegistry.DEFAULT_THEME;
const TITLEBAR_HEIGHT = 44;
let serverProcess = null;
let serverPort = null;
let serverToken = null;
let isQuitting = false;
let tray = null;
let reusedServerPid = null;
let reusedServerOwned = false;
let isExitingServer = false;
let _isUpdating = false;
let _autoUpdaterInitialized = false;
let forceQuitApp = false;
const SERVER_SHUTDOWN_GRACE_MS = 17000;
const SERVER_FORCE_KILL_WAIT_MS = 5000;
const SERVER_SHUTDOWN_POLL_MS = 200;
let browserCommandSocket = null;
let browserCommandReconnectTimer = null;
let browserCommandGeneration = 0;


let _mainI18nData = null;

function _resolveLocaleKey(locale) {
  if (!locale) return "zh";
  locale = String(locale).trim();
  if (!locale || locale === "system") return "zh";
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

function _getMainI18n() {
  if (_mainI18nData) return _mainI18nData;
  try {
    let locale = null;
    for (const prefPath of [
      path.join(codiaHome, "user", "preferences.json"),
      path.join(codiaHome, "preferences.json"),
    ]) {
      try {
        const prefs = JSON.parse(fs.readFileSync(prefPath, "utf-8"));
        locale = prefs.locale === "system" ? app.getLocale() : (prefs.locale || null);
        break;
      } catch { /* try next path */ }
    }
    if (!locale) locale = app.getLocale();
    const key = _resolveLocaleKey(locale);
    const file = path.join(__dirname, "src", "locales", `${key}.json`);
    const all = JSON.parse(fs.readFileSync(file, "utf-8"));
    _mainI18nData = all.main || {};
  } catch {
    _mainI18nData = {};
  }
  return _mainI18nData;
}


function mt(dotPath, vars, fallback) {
  const data = _getMainI18n();
  const val = dotPath.split(".").reduce((obj, k) => obj?.[k], data);
  let text = (typeof val === "string") ? val : (fallback || dotPath);
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    }
  }
  return text;
}


function resetMainI18n() { _mainI18nData = null; }


function killPid(pid, force = false) {
  if (process.platform === "win32") {
    try {
      require("child_process").execFileSync("taskkill",
        force ? ["/F", "/T", "/PID", String(pid)] : ["/PID", String(pid)],
        { stdio: "ignore", windowsHide: true });
    } catch {}
  } else {
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
  }
}


function titleBarOpts(trafficLight = { x: 16, y: 16 }) {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
  }

  return { frame: false, ...windowIconOption() };
}


function settingsTitleBarOpts(trafficLight = { x: 16, y: 16 }) {
  if (process.platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
  }
  return { frame: true, ...windowIconOption() };
}


function getCurrentAgentId() {
  const prefsPath = path.join(codiaHome, "user", "preferences.json");
  const agentsDir = path.join(codiaHome, "agents");


  try {
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    if (prefs.primaryAgent) {

      const agentDir = path.join(agentsDir, prefs.primaryAgent);
      if (fs.existsSync(path.join(agentDir, "config.yaml"))) {
        return prefs.primaryAgent;
      }
    }
  } catch {}


  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))) {
        return entry.name;
      }
    }
  } catch {}


  return null;
}


function isSetupComplete() {
  const prefsPath = path.join(codiaHome, "user", "preferences.json");
  try {
    return JSON.parse(fs.readFileSync(prefsPath, "utf-8")).setupComplete === true;
  } catch {}
  return false;
}


function hasExistingConfig() {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return false;
    const configPath = path.join(codiaHome, "agents", agentId, "config.yaml");
    const configText = fs.readFileSync(configPath, "utf-8");
    return /api_key:\s*["']?[^"'\s]+/.test(configText);
  } catch {}
  return false;
}

function readCurrentAgentConfig() {
  const agentId = getCurrentAgentId();
  if (!agentId) return {};

  try {
    const configPath = path.join(codiaHome, "agents", agentId, "config.yaml");
    const configText = fs.readFileSync(configPath, "utf-8");
    const yaml = require("js-yaml");
    const parsed = yaml.load(configText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    console.warn("[desktop] failed to read current agent config for splash info:", err?.message || err);
    return {};
  }
}

function resolveSplashLocale(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw && raw !== "system") return raw;
  return app.getLocale?.() || "zh-CN";
}

function resolveSplashInfo() {
  const prefs = safeReadExistingJSON(preferencesPath, {});
  const legacyPrefs = safeReadExistingJSON(path.join(codiaHome, "preferences.json"), {});
  const config = readCurrentAgentConfig();
  const agentConfig = config.agent && typeof config.agent === "object" ? config.agent : {};
  const userConfig = config.user && typeof config.user === "object" ? config.user : {};
  const agentName =
    (typeof agentConfig.name === "string" && agentConfig.name.trim())
    || (typeof config.agentName === "string" && config.agentName.trim())
    || (typeof prefs.agentName === "string" && prefs.agentName.trim())
    || null;
  const locale = resolveSplashLocale(config.locale || prefs.locale || legacyPrefs.locale);
  const yuan =
    (typeof agentConfig.yuan === "string" && agentConfig.yuan.trim())
    || (typeof config.yuan === "string" && config.yuan.trim())
    || (typeof prefs.yuan === "string" && prefs.yuan.trim())
    || "codia";

  return {
    agentName,
    userName: (typeof userConfig.name === "string" && userConfig.name.trim()) || null,
    locale,
    yuan,
  };
}


async function migrateSetupCompleteViaServerIfNeeded() {
  if (isSetupComplete()) return false;

  try {
    const modelsPath = path.join(codiaHome, "added-models.yaml");
    if (!fs.existsSync(modelsPath)) return false;
    const content = fs.readFileSync(modelsPath, "utf-8");
    if (!/api_key:\s*["']?[^"'\s]+/.test(content)) return false;
  } catch {
    return false;
  }
  await submitOnboardingCompleteIntent({ serverPort, serverToken });
  console.log("[desktop] existing provider config detected, marked setupComplete through server");
  return true;
}


let _serverLogs = [];
let _lastServerLaunchInfo = null;
let _lastServerProgressAtMs = null;

function isDesktopOwnedServerInfo(info) {
  return info?.ownerKind === "desktop" && Number.isInteger(Number(info?.ownerPid));
}

async function verifyReusableServerInfo(existingInfo) {
  if (!existingInfo?.port || !existingInfo?.token || !existingInfo?.pid) return null;
  const headers = { Authorization: `Bearer ${existingInfo.token}` };
  const baseUrl = `http://127.0.0.1:${existingInfo.port}`;
  const [healthResponse, identityResponse] = await Promise.all([
    fetch(`${baseUrl}/api/health`, { headers, signal: AbortSignal.timeout(2000) }),
    fetch(`${baseUrl}/api/server/identity`, { headers, signal: AbortSignal.timeout(2000) }),
  ]);
  if (!healthResponse.ok || !identityResponse.ok) return null;
  const [health, identity] = await Promise.all([healthResponse.json(), identityResponse.json()]);
  if (health?.status !== "ok" && health?.status !== "ready") return null;
  if (!identity?.studioId || (existingInfo.studioId && identity.studioId !== existingInfo.studioId)) return null;
  if (existingInfo.serverId && identity.serverId !== existingInfo.serverId) return null;
  return { health, identity };
}

function isPidAliveForDiagnostics(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function hasChildExitObserved(proc) {
  if (!proc) return false;
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function waitForProcessExit(proc, pid, timeoutMs) {
  if (!proc && !pid) return true;
  if (hasChildExitObserved(proc)) return true;

  let exitObserved = false;
  let onExit = null;
  if (proc && typeof proc.once === "function") {
    onExit = () => { exitObserved = true; };
    proc.once("exit", onExit);
  }

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exitObserved || hasChildExitObserved(proc)) return true;
      if (pid && !isPidAliveForDiagnostics(pid)) return true;
      const waitMs = Math.min(SERVER_SHUTDOWN_POLL_MS, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0) break;
      await new Promise(r => setTimeout(r, waitMs));
    }
    if (exitObserved || hasChildExitObserved(proc)) return true;
    return !!pid && !isPidAliveForDiagnostics(pid);
  } finally {
    if (proc && onExit && typeof proc.removeListener === "function") {
      proc.removeListener("exit", onExit);
    }
  }
}


function pollServerInfo(infoPath, {
  timeout = SERVER_INFO_FIRST_WAIT_MS,
  interval = 200,
  process: proc,
  getLastProgressAtMs = () => null,
} = {}) {
  return new Promise((resolve, reject) => {
    const startedAtMs = Date.now();
    const deadline = startedAtMs + timeout;
    let exited = false;

    if (proc) {
      proc.on("error", (err) => {
        exited = true;
        reject(err);
      });
      proc.on("exit", (code, signal) => {
        exited = true;
        const err = new Error(
          signal
            ? mt("dialog.serverKilledBySignal", { signal })
            : mt("dialog.serverExitedWithCode", { code })
        );
        err.exitCode = code;
        err.exitSignal = signal;
        reject(err);
      });
    }

    const check = async () => {
      if (exited) return;
      const nowMs = Date.now();
      const childAlive = proc
        ? !hasChildExitObserved(proc) && isPidAliveForDiagnostics(proc.pid)
        : false;
      if (!shouldKeepWaitingForServerInfo({
        nowMs,
        startedAtMs,
        firstDeadlineMs: deadline,
        lastProgressAtMs: getLastProgressAtMs(),
        childAlive,
      })) {
        reject(new Error(mt("dialog.serverStartTimeout", null, "Server start timed out")));
        return;
      }
      try {
        const raw = await fs.promises.readFile(infoPath, "utf-8");
        const info = JSON.parse(raw);

        try { process.kill(info.pid, 0); } catch { setTimeout(check, interval); return; }
        resolve(info);
      } catch {
        setTimeout(check, interval);
      }
    };
    check();
  });
}

async function startServer() {
  const serverInfoPath = desktopServerInfoPath;


  let existingInfo = null;
  try {
    existingInfo = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
  } catch {  }

  if (existingInfo) {
    const pidAlive = (() => {
      try { process.kill(existingInfo.pid, 0); return true; } catch { return false; }
    })();

    if (pidAlive) {

      // If this is a stale server after an update, stop it and launch a matching one.
      const currentVersion = app.getVersion();
      const serverVersion = existingInfo.version;
      if (serverVersion && serverVersion !== currentVersion) {
        console.log(`[desktop] stale server version mismatch (server: ${serverVersion}, app: ${currentVersion}); stopping stale server`);
      } else {

        let reused = false;
        try {
          const verified = await verifyReusableServerInfo(existingInfo);
          if (verified) {
            console.log(`[desktop] reusing existing server on port ${existingInfo.port}, version: ${serverVersion || "unknown"}`);
            serverPort = existingInfo.port;
            serverToken = existingInfo.token;
            reusedServerPid = existingInfo.pid;
            reusedServerOwned = isDesktopOwnedServerInfo(existingInfo);
            reused = true;
          }
        } catch {  }

        if (reused) return;
      }


      if (isDesktopOwnedServerInfo(existingInfo)) {
        console.log(`[desktop] stale desktop-owned server (PID ${existingInfo.pid}) is not responding; stopping...`);
        killPid(existingInfo.pid);
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          try { process.kill(existingInfo.pid, 0); } catch { break; }
          await new Promise(r => setTimeout(r, 100));
        }
        killPid(existingInfo.pid, true);
      } else {
        console.log(`[desktop] refusing to stop an unverified external server (PID ${existingInfo.pid})`);
      }
    }


    try { fs.unlinkSync(serverInfoPath); } catch {}
  }


  _serverLogs = [];

  let serverEnv = withCodiaPiSdkEnv({
    ...process.env,
    CODIA_HOME: codiaHome,
    CODIA_SERVER_SCOPE: "desktop",
    CODIA_SERVER_INFO: serverInfoPath,
    CODIA_DESKTOP_EXEC_PATH: process.execPath,
    CODIA_DESKTOP_APP_PATH: app.getAppPath(),
    CODIA_DESKTOP_IS_PACKAGED: app.isPackaged ? "1" : "0",
    CODIA_DESKTOP_EXEC_PATH: process.execPath,
    CODIA_DESKTOP_APP_PATH: app.getAppPath(),
    CODIA_DESKTOP_IS_PACKAGED: app.isPackaged ? "1" : "0",
    CODIA_CREATE_STARTUP_SESSION: "0",
    CODIA_SERVER_OWNER: "desktop",
    CODIA_SERVER_OWNER_PID: String(process.pid),
    CODIA_SERVER_OWNER: "desktop",
    CODIA_SERVER_OWNER_PID: String(process.pid),
  }, codiaHome);
  serverEnv = await serverEnvironmentForNetworkProxy(serverEnv);


  if (process.platform === "win32") {

    const gitRoot = path.join(process.resourcesPath || "", "git");
    const gitPaths = [
      path.join(gitRoot, "mingw64", "bin"),
      path.join(gitRoot, "cmd"),
    ].filter(p => fs.existsSync(p));
    serverEnv = await buildWin32ServerEnv(serverEnv, {
      prependPathEntries: gitPaths,
    });
  }


  let serverBin, serverArgs;
  const packagedServerRoot = path.join(process.resourcesPath || "", "server");
  const bundledServerBinary = resolveServerBinary(packagedServerRoot, process.platform);
  if (bundledServerBinary) {
    const bin = bundledServerBinary;
    serverBin = bin;
    serverArgs = process.platform === "win32"
      ? [path.join(path.dirname(bin), "bootstrap.js")]
      : [];
    serverEnv.CODIA_ROOT = path.join(process.resourcesPath, "server");
    serverEnv.CODIA_SERVER_ENTRY = path.join(serverEnv.CODIA_ROOT, "bundle", "index.js");
  } else {


    serverBin = process.execPath;
    serverArgs = [path.join(__dirname, "..", "server", "index.js")];
    serverEnv.ELECTRON_RUN_AS_NODE = "1";
  }


  const launchConfig = resolveServerLaunchConfig({
    env: serverEnv,
    projectRoot: path.resolve(__dirname, ".."),
    resourcesPath: process.resourcesPath || "",
    platform: process.platform,
    arch: process.arch,
    electronExecPath: process.execPath,
  });
  serverBin = launchConfig.serverBin;
  serverArgs = launchConfig.serverArgs;
  delete serverEnv.ELECTRON_RUN_AS_NODE;
  Object.assign(serverEnv, launchConfig.serverEnv);
  console.log(
    `[desktop] starting server via ${launchConfig.kind}: ${serverBin}` +
    (serverArgs.length ? ` ${serverArgs.join(" ")}` : "")
  );

  const isBundledMode = launchConfig.kind === "bundled";
  if (isBundledMode) {
    const ready = await ensureServerFilesReady(launchConfig.serverRoot);
    if (!ready.ok) {
      throw new Error(mt(
        "dialog.serverFilesNotReady",
        {
          missing: ready.missing.join(", "),
          waited: Math.round(ready.waitedMs / 1000),
        },
        `Server files are not ready. Missing: ${ready.missing.join(", ")}`
      ));
    }
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    _serverLogs = [];
    _lastServerProgressAtMs = null;
    try { fs.unlinkSync(serverInfoPath); } catch {}

    serverProcess = spawn(serverBin, serverArgs, {
      detached: true,
      windowsHide: true,
      env: serverEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    _lastServerLaunchInfo = {
      pid: serverProcess.pid || null,
      command: serverBin,
      args: [...serverArgs],
    };

    // Capture stdout/stderr for packaged crash diagnostics.
    serverProcess.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      _lastServerProgressAtMs = Date.now();
      try { process.stdout.write(text); } catch {}
      _serverLogs.push(text);
      if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
    });
    serverProcess.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      _lastServerProgressAtMs = Date.now();
      try { process.stderr.write(text); } catch {}
      _serverLogs.push("[stderr] " + text);
      if (_serverLogs.length > 500) _serverLogs.splice(0, _serverLogs.length - 500);
    });

    try {
      const info = await pollServerInfo(serverInfoPath, {
        process: serverProcess,
        getLastProgressAtMs: () => _lastServerProgressAtMs,
      });
      serverPort = info.port;
      serverToken = info.token;
      serverProcess.unref();
      return;
    } catch (err) {
      lastErr = err;
      const portConflict = parsePortInUseStartupError(_serverLogs);
      if (portConflict) {
        const friendly = new Error(formatPortInUseStartupError(portConflict));
        friendly.code = "PORT_IN_USE";
        friendly.startupError = portConflict;
        friendly.cause = err;
        throw friendly;
      }
      const missingModule = isModuleResolutionError(_serverLogs);
      const canRetry = missingModule && attempt === 0;

      if (serverProcess && !hasChildExitObserved(serverProcess) && serverProcess.pid) {
        killPid(serverProcess.pid, true);
      }
      serverProcess = null;

      if (!canRetry) {
        if (missingModule) {
          const friendly = new Error(mt(
            "dialog.serverModuleMissing",
            { module: missingModule },
            `Server startup failed: cannot find module ${missingModule}. Please restart Codia.`
          ));
          friendly.cause = err;
          throw friendly;
        }
        throw err;
      }

      console.warn(`[desktop] Server module resolution failed (${missingModule}); retrying once after 2s`);
      if (isBundledMode) {
        await ensureServerFilesReady(launchConfig.serverRoot).catch(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw lastErr || new Error("startServer: unknown failure");
}


let _serverRestartAttempts = 0;
let _manualServerRestartInFlight = null;
let _manualServerRestarting = false;
function monitorServer() {
  if (!serverProcess) return;
  serverProcess.on("exit", async (code, signal) => {
    if (isQuitting || _isUpdating || isExitingServer) return;
    if (_manualServerRestarting) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.error(`[desktop] Server unexpected exit (${reason})`);

    if (_serverRestartAttempts < 1) {
      _serverRestartAttempts++;
      console.log("[desktop] trying to restart Server...");
      try {
        await startServer();
        console.log("[desktop] Server restarted");
        monitorServer();
        setupBrowserCommands();
        const payload = { port: serverPort, token: serverToken };
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("server-restarted", payload);
        }
        if (settingsWindow && !settingsWindow.isDestroyed()) {
          settingsWindow.webContents.send("server-restarted", payload);
        }
      } catch (err) {
        console.error("[desktop] Server restart failed:", err.message);
        writeCrashLog(`Server restart failed: ${err.message}`);
        dialog.showErrorBox(`${runtimeProductName()} Server`, mt("dialog.serverRestartFailed", {
          version: app?.getVersion?.() || "unknown",
          error: err.message,
        }));
      }
    } else {
      writeCrashLog(`Server crashed repeatedly (${reason}); restart abandoned`);
      dialog.showErrorBox(`${runtimeProductName()} Server`, mt("dialog.serverMultipleCrash", {
        version: app?.getVersion?.() || "unknown",
        reason,
      }));
    }
  });
}

async function restartServerFromRenderer() {
  if (_manualServerRestartInFlight) return _manualServerRestartInFlight;

  _manualServerRestartInFlight = (async () => {
    console.log("[desktop] manual server restart requested");
    _serverRestartAttempts = 0;
    _manualServerRestarting = true;
    await shutdownServer();
    serverPort = null;
    serverToken = null;
    _manualServerRestarting = false;
    await startServer();
    monitorServer();
    setupBrowserCommands();

    const payload = { port: serverPort, token: serverToken };
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("server-restarted", payload);
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send("server-restarted", payload);
    }
    return { ok: true, ...payload };
  })().finally(() => {
    _manualServerRestarting = false;
    _manualServerRestartInFlight = null;
  });

  return _manualServerRestartInFlight;
}


function showPrimaryWindow() {
  if (process.platform === "darwin") app.dock.show();
  const win = mainWindow || onboardingWindow || splashWindow;
  focusExistingWindow(win);
}


function createTray() {
  if (_isE2E) return;
  const isDev = !app.isPackaged;
  let icon;
  if (process.platform === "win32") {
    icon = nativeImage.createFromPath(resolveTrayIconPath());
  } else {
    const iconName = isDev ? "tray-dev-template.png" : "tray-template.png";
    const iconPath = path.join(__dirname, "src", "assets", iconName);
    icon = nativeImage.createFromPath(iconPath);
    if (process.platform === "darwin") icon.setTemplateImage(true);
  }
  tray = new Tray(icon);
  tray.setToolTip(isDev ? `${runtimeDisplayName()} (dev)` : runtimeDisplayName());

  const buildMenu = () => Menu.buildFromTemplate([
    { label: mt("tray.show", null, `Show ${runtimeDisplayName()}`), click: () => showPrimaryWindow() },
    { label: mt("tray.settings", null, "Settings"), click: () => createSettingsWindow() },
    { type: "separator" },
    { label: mt("tray.quit", null, "Quit"), click: () => { isExitingServer = true; isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(buildMenu());
  tray.on("right-click", () => tray.setContextMenu(buildMenu()));
  tray.on("double-click", () => showPrimaryWindow());
}


function buildServerCrashDiagnostics() {
  const isPackaged = process.resourcesPath &&
    fs.existsSync(path.join(process.resourcesPath, "server"));
  const serverDir = isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.join(__dirname, "..", "server");
  const sqlitePath = path.join(serverDir, "node_modules", "better-sqlite3",
    "build", "Release", "better_sqlite3.node");
  const bundlePath = path.join(serverDir, "bundle", "index.js");

  const items = [
      ``,
      `--- Diagnostics ---`,
      `CODIA_HOME: ${codiaHome}`,
      `Server dir: ${serverDir}`,
      `Packaged: ${!!isPackaged}`,
      `Server PID: ${_lastServerLaunchInfo?.pid || "unknown"}`,
      `Server command: ${_lastServerLaunchInfo?.command || "unknown"}`,
      `Server args: ${(_lastServerLaunchInfo?.args || []).join(" ") || "(none)"}`,
      `Server child alive: ${(() => {
        try {
          const pid = _lastServerLaunchInfo?.pid;
          if (!pid) return false;
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })()}`,
      `bundle/index.js exists: ${fs.existsSync(bundlePath)}`,
      `better_sqlite3.node exists: ${fs.existsSync(sqlitePath)}`,
      `ELECTRON_RUN_AS_NODE: ${process.env.ELECTRON_RUN_AS_NODE || "unset"}`,
      `Node ABI: ${process.versions.modules || "unknown"}`,
  ];

  if (process.platform === "win32" && isPackaged) {
    const exePath = path.join(serverDir, "codia-server.exe");
    const legacyExePath = path.join(serverDir, "codia-server.exe");
    const cmdPath = path.join(serverDir, "codia-server.cmd");
    const gitRoot = path.join(process.resourcesPath, "git");
    items.push(`codia-server.exe exists: ${fs.existsSync(exePath)}`);
    items.push(`codia-server.exe exists (legacy fallback): ${fs.existsSync(legacyExePath)}`);
    items.push(`codia-server.cmd exists (manual debug): ${fs.existsSync(cmdPath)}`);
    items.push(`MinGit dir exists: ${fs.existsSync(gitRoot)}`);
    items.push(``);
    items.push(`Manual debug: open cmd.exe, cd to "${serverDir}", run codia-server.cmd`);
  }

  try {
    items.push(buildGpuStartupDiagnostics({ codiaHome, policy: gpuStartupPolicy, app }));
  } catch (err) {
    items.push(`GPU startup diagnostics failed: ${err.message}`);
  }

  return items.join("\n");
}

function writeCrashLog(errorMessage) {
  const logs = _serverLogs.join("");
  const timestamp = new Date().toISOString();
  const diagnostics = buildServerCrashDiagnostics();

  const content = [
    `=== Codia Crash Log ===`,
    `Codia: v${app?.getVersion?.() || "unknown"}`,
    `Time: ${timestamp}`,
    `Error: ${errorMessage}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Electron: ${process.versions.electron || "unknown"}`,
    `Node: ${process.versions.node || "unknown"}`,
    ``,
    `--- Server Output ---`,
    logs || "(no output captured)",
    diagnostics,
    ``,
  ].join("\n");

  // Write crash log best-effort.
  try {
    const crashLogPath = path.join(codiaHome, "crash.log");
    fs.mkdirSync(codiaHome, { recursive: true });
    fs.writeFileSync(crashLogPath, content, "utf-8");
  } catch (e) {
    console.error("[desktop] failed to write crash.log:", e.message);
  }

  return content;
}

function formatPortInUseStartupError(conflict) {
  const host = conflict?.host || "unknown";
  const port = conflict?.port ?? "unknown";
  const networkMode = conflict?.networkMode || "unknown";
  const suggestions = Array.isArray(conflict?.suggestions) && conflict.suggestions.length
    ? `\n\n${conflict.suggestions.map(item => `- ${item}`).join("\n")}`
    : "";
  return `PORT_IN_USE: ${host}:${port} is already in use (network mode: ${networkMode}).${suggestions}`;
}

function buildLaunchFailureDialogDetail(err, crashInfo) {
  const structuredPortConflict = err?.startupError?.code === "PORT_IN_USE"
    ? formatPortInUseStartupError(err.startupError)
    : null;
  const rootServerError = structuredPortConflict || extractRootServerStartupError(_serverLogs);
  const tail = crashInfo.length > 800 ? "...\n" + crashInfo.slice(-800) : crashInfo;
  if (!rootServerError) return tail;
  if (tail.includes(rootServerError)) return tail;
  return `${rootServerError}\n\n${tail}`;
}


function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 280,
    resizable: false,
    frame: false,
    title: runtimeProductName(),
    ...titleBarOpts({ x: 12, y: 12 }),
    transparent: true,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachRendererLaunchDiagnostics(splashWindow, "splash");
  loadWindowURL(splashWindow, "splash");

  splashWindow.once("ready-to-show", () => {
    splashWindow.show();
  });

  splashWindow.on("closed", () => {
    splashWindow = null;
  });
}

let installingWindow = null;
function createInstallingWindow(version) {
  if (installingWindow && !installingWindow.isDestroyed()) return;
  installingWindow = new BrowserWindow({
    width: 380,
    height: 280,
    resizable: false,
    frame: false,
    title: runtimeProductName(),
    ...titleBarOpts({ x: 12, y: 12 }),
    transparent: true,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  attachRendererLaunchDiagnostics(installingWindow, "installing");
  loadWindowURL(installingWindow, "splash", {
    query: { mode: "installing", version: String(version || "") },
  });
  installingWindow.once("ready-to-show", () => {
    if (installingWindow && !installingWindow.isDestroyed()) installingWindow.show();
  });
  installingWindow.on("closed", () => { installingWindow = null; });
}

function failInstallingWindow(msg) {
  if (installingWindow && !installingWindow.isDestroyed()) {
    try { installingWindow.close(); } catch {}
  }
  try {
    dialog.showErrorBox(
      mt("dialog.installFailedTitle", null, `${runtimeProductName()} Update`),
      mt("dialog.installFailedBody", { error: msg || "unknown" })
    );
  } catch {}
}


const windowStatePath = path.join(codiaHome, "user", "window-state.json");
const mainWindowStateSaver = createWindowStateSaver({
  filePath: windowStatePath,
  getWindow: () => mainWindow,
  onError: (e) => {
    console.error("[desktop] failed to save window state", e.message);
  },
});

function saveWindowState() {
  mainWindowStateSaver.schedule();
}


function createMainWindow() {
  const saved = sanitizeWindowState(loadWindowState(windowStatePath), screen.getAllDisplays(), {
    defaultWidth: 960,
    defaultHeight: 820,
  });

  const opts = {
    width: saved?.width || 960,
    height: saved?.height || 820,
    minWidth: 420,
    minHeight: 500,
    title: runtimeProductName(),
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: "#F8F4FF",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  // Restore position only when saved coordinates are valid.
  if (saved?.x != null && saved?.y != null) {
    opts.x = saved.x;
    opts.y = saved.y;
  }

  mainWindow = new BrowserWindow(opts);
  attachRendererLaunchDiagnostics(mainWindow, "main");

  mainWindow.setAutoHideMenuBar(true);
  mainWindow.setMenuBarVisibility(false);
  if (typeof mainWindow.removeMenu === "function") {
    mainWindow.removeMenu();
  }
  Menu.setApplicationMenu(null);

  if (!_autoUpdaterInitialized) {
    initAutoUpdater(mainWindow, {
      shutdownServer,
      setIsUpdating: (v) => { _isUpdating = v; },
      codiaHome,
      showInstalling: createInstallingWindow,
      failInstalling: failInstallingWindow,
    });
    _autoUpdaterInitialized = true;
  } else {
    setUpdaterMainWindow(mainWindow);
  }

  if (saved?.isMaximized) {
    mainWindow.maximize();
  }

  loadWindowURL(mainWindow, "index");

  // Show the main window after a startup timeout to avoid a blank hidden window.
  const initTimeout = setTimeout(() => {
    console.warn("[desktop] main window init timed out (30s); forcing window show");
    writeDesktopLaunchDiagnostic("app-ready-timeout", { label: "main", timeoutMs: 30000 });
    if (mainWindow && !mainWindow.isDestroyed() && (!mainWindow.isVisible() || mainWindow.isMinimized())) {
      focusExistingWindow(mainWindow);
    }
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
  }, 30000);
  mainWindow.webContents.once("did-finish-load", () => {
    // did-finish-load only means HTML loaded; renderer initialization may still be running.
    console.log("[desktop] Main window HTML loaded; waiting for renderer init...");
  });
  mainWindow.once("show", () => {
    // Windows can emit "show" while SW_HIDE still prevents native visibility.
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) clearTimeout(initTimeout);
    writeDesktopLaunchDiagnostic("app-ready", {
      label: "main", visible: mainWindow.isVisible(), minimized: mainWindow.isMinimized(),
    });
  });

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }


  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] renderer process gone: ${details.reason} (code: ${details.exitCode})`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      setTimeout(() => {
        try { mainWindow.reload(); } catch {}
      }, 1000);
    }
  });

  mainWindow.on("unresponsive", () => {
    console.warn("[desktop] main window is unresponsive");
  });

  mainWindow.on("responsive", () => {
    console.log("[desktop] main window is responsive again");
  });


  mainWindow.on("resize", saveWindowState);
  mainWindow.on("move", saveWindowState);


  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {}
  });


  mainWindow.on("maximize", () => mainWindow.webContents.send("window-maximized"));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("window-unmaximized"));


  mainWindow.on("close", (e) => {
    mainWindowStateSaver.flush().catch(() => {});
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();

      // Hide child windows together with the main window.
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.hide();
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.hide();
      if (quickChatWindow && !quickChatWindow.isDestroyed()) quickChatWindow.hide();
      for (const [, viewerWindow] of _viewerWindows) {
        if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.hide();
      }
    }
  });

  mainWindow.on("closed", () => {
    setUpdaterMainWindow(null);
    mainWindow = null;
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
      settingsWindow = null;
    }
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.destroy();
      browserViewerWindow = null;
    }
    if (quickChatWindow && !quickChatWindow.isDestroyed()) {
      quickChatWindow.destroy();
      quickChatWindow = null;
    }
    for (const [, viewerWindow] of _viewerWindows) {
      if (viewerWindow && !viewerWindow.isDestroyed()) viewerWindow.destroy();
    }
    _viewerWindows.clear();
    if (_screenshotWin && !_screenshotWin.isDestroyed()) {
      _screenshotWin.destroy();
      _screenshotWin = null;
    }
  });

}

function resolveConcreteTheme(name) {
  return themeRegistry.resolveSavedTheme(name, nativeTheme.shouldUseDarkColors).concrete;
}

function themeBackground(name) {
  const concrete = resolveConcreteTheme(name || _browserViewerTheme);
  return (themeRegistry.THEMES[concrete] || themeRegistry.THEMES[themeRegistry.DEFAULT_THEME]).backgroundColor;
}


function createSettingsWindow(tab, theme) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {

    if (settingsWindow.webContents.isCrashed()) {
      console.warn("[desktop] settings renderer 宸插穿婧冿紝閲嶅缓绐楀彛");
      settingsWindow.destroy();
      settingsWindow = null;
    } else {
      if (tab) settingsWindow.webContents.send("settings-switch-tab", tab);
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
  }

  settingsWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 720,
    minHeight: 500,
    resizable: true,
    thickFrame: true,
    title: mt("tray.settings", null, "Settings"),
    ...settingsTitleBarOpts({ x: 16, y: 14 }),
    backgroundColor: themeBackground(theme || _browserViewerTheme),
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setResizable(true);
  attachRendererLaunchDiagnostics(settingsWindow, "settings");
  settingsWindow.setMinimumSize(720, 500);
  settingsWindow.setAutoHideMenuBar(true);
  settingsWindow.setMenuBarVisibility(false);
  if (typeof settingsWindow.removeMenu === "function") {
    settingsWindow.removeMenu();
  } else {
    settingsWindow.setMenu(null);
  }

  const showSettingsWindow = (reason) => {
    if (!settingsWindow || settingsWindow.isDestroyed()) return;
    if (!settingsWindow.isVisible()) {
      console.log(`[desktop] showing settings window (${reason})`);
      settingsWindow.show();
    }
    settingsWindow.focus();
  };

  settingsWindow.once("ready-to-show", () => showSettingsWindow("ready-to-show"));

  const settingsShowFallback = setTimeout(() => {
    showSettingsWindow("fallback-timeout");
  }, 2500);
  settingsShowFallback.unref?.();

  loadWindowURL(settingsWindow, "settings");

  settingsWindow.webContents.once("did-finish-load", () => {
    clearTimeout(settingsShowFallback);
    showSettingsWindow("did-finish-load");
  });

  settingsWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[desktop] settings load failed (${errorCode}) ${errorDescription}: ${validatedURL}`);
    showSettingsWindow("did-fail-load");
  });

  settingsWindow.webContents.on("console-message", (details) => {
    const level = details?.level;
    const message = details?.message;
    const line = details?.lineNumber ?? details?.line;
    const sourceId = details?.sourceId;
    if (Number(level) >= 2 || process.env.CODIA_DEBUG_SETTINGS === "1") {
      console.log(`[settings:${level}] ${message} (${sourceId}:${line})`);
    }
  });


  if (tab) {
    settingsWindow.webContents.once("did-finish-load", () => {
      settingsWindow.webContents.send("settings-switch-tab", tab);
    });
  }


  settingsWindow.webContents.on("will-navigate", (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {}
  });

  // Recover from renderer crash by rebuilding the settings window next time.
  settingsWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[desktop] settings renderer process gone: ${details.reason} (code: ${details.exitCode})`);
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.destroy();
    }
    settingsWindow = null;
  });

  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}


function _showSkillViewer(skillInfo, targetWindow) {
  const viewerWindow = targetWindow && !targetWindow.isDestroyed()
    ? targetWindow
    : (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);
  if (!viewerWindow) return;

  viewerWindow.webContents.send("show-skill-viewer", skillInfo);
  viewerWindow.show();
  viewerWindow.focus();
}


function scanSkillDir(dir, rootDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .sort((a, b) => {
      // Put directories first and keep SKILL.md at the top.
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map(e => {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      return { name: e.name, path: fullPath, isDir: true, children: scanSkillDir(fullPath, rootDir) };
    }
    return { name: e.name, path: fullPath, isDir: false };
  });
}


function createBrowserViewerWindow(opts = {}) {
  const shouldShow = opts.show !== false;
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    if (shouldShow) {
      browserViewerWindow.show();
      browserViewerWindow.focus();

      _updateBrowserViewBounds();
      // Reused viewer windows still need focus forwarded to the WebContentsView.
      if (_browserWebView) {
        setTimeout(() => {
          if (_browserWebView) _browserWebView.webContents.focus();
        }, 50);
      }
    }
    return;
  }

  browserViewerWindow = new BrowserWindow({
    width: 1200,
    height: 1080,
    minWidth: 480,
    minHeight: 360,
    title: "Browser",
    frame: false,
    ...windowIconOption(),
    backgroundColor: themeBackground(_browserViewerTheme),
    hasShadow: true,
    show: shouldShow,
    acceptFirstMouse: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachRendererLaunchDiagnostics(browserViewerWindow, "browser-viewer");
  loadWindowURL(browserViewerWindow, "browser-viewer");


  browserViewerWindow.webContents.on("did-finish-load", () => {
    if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {

      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
      browserViewerWindow.contentView.addChildView(_browserWebView);
      _updateBrowserViewBounds();
      const url = _browserWebView.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      console.log("[browser-viewer] did-finish-load: view mounted, bounds:", _browserWebView.getBounds());

      setTimeout(() => {
        if (_browserWebView) {
          _browserWebView.webContents.focus();
          console.log("[browser-viewer] delayed focus applied, isFocused:", _browserWebView.webContents.isFocused());
        }
      }, 200);
    }
  });

  browserViewerWindow.on("resize", () => _updateBrowserViewBounds());

  browserViewerWindow.on("show", () => _updateBrowserViewBounds());

  // Forward focus to the embedded WebContentsView when the browser window gains focus.
  browserViewerWindow.on("focus", () => {
    if (_browserWebView) {
      _browserWebView.webContents.focus();
      console.log("[browser-viewer] window focus -> view.focus(), isFocused:", _browserWebView.webContents.isFocused());
    }
  });


  browserViewerWindow.on("close", (e) => {
    if (!isQuitting && _browserWebView) {
      e.preventDefault();
      browserViewerWindow.hide();
    }
  });

  browserViewerWindow.on("closed", () => {
    browserViewerWindow = null;
  });
}

const SNAPSHOT_SCRIPT = `(function() {
  var ref = 0;
  var MAX_TREE = 30000;
  document.querySelectorAll('[data-codia-ref]').forEach(function(el) {
    el.removeAttribute('data-codia-ref');
  });

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  }

  function isInteractive(el) {
    var t = el.tagName;
    if (['A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY'].indexOf(t) !== -1) return true;
    var r = el.getAttribute('role');
    if (r && ['button','link','menuitem','tab','checkbox','radio','textbox','combobox','listbox','option','switch','slider','treeitem'].indexOf(r) !== -1) return true;
    if (el.onclick || el.hasAttribute('onclick')) return true;
    if (el.contentEditable === 'true') return true;
    if (el.tabIndex > 0) return true;
    try { if (window.getComputedStyle(el).cursor === 'pointer' && !el.closest('a,button')) return true; } catch(e) {}
    return false;
  }

  function directText(el) {
    var t = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) t += el.childNodes[i].textContent;
    }
    return t.trim().replace(/\\s+/g, ' ').slice(0, 80);
  }

  // Structural signature from direct child tag sequence.
  function sig(el) {
    if (el.nodeType !== 1 || !isVisible(el)) return null;
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return null;
    var s = tag;
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (c.nodeType === 1 && isVisible(c) && ['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(c.tagName) === -1) {
        s += ',' + c.tagName;
      }
    }
    return s;
  }


  function compact(el, depth) {
    var links = [], ctrls = [], texts = [];
    function collect(node) {
      if (node.nodeType !== 1 || !isVisible(node)) return;
      var tag = node.tagName;
      if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return;
      if (isInteractive(node)) {
        ref++;
        node.setAttribute('data-codia-ref', String(ref));
        var name = node.getAttribute('aria-label') || node.title || node.placeholder
          || (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) || node.value || '';
        if (tag === 'A' || node.getAttribute('role') === 'link') {
          links.push('[' + ref + '] "' + name + '"');
        } else {
          ctrls.push('[' + ref + '] ' + name);
        }
        return;
      }
      var txt = directText(node);
      if (txt && txt.length > 2) texts.push(txt);
      for (var i = 0; i < node.children.length; i++) collect(node.children[i]);
    }
    collect(el);
    if (!links.length && !ctrls.length && !texts.length) return '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';
    var parts = links.concat(ctrls);
    var line = parts.join(' | ');
    if (texts.length) line += (line ? ' | ' : '') + texts.join(' \\u00b7 ');
    return pad + line + '\\n';
  }


  function walkChildren(el, depth) {
    var out = '';
    var children = [], sigs = [];
    for (var i = 0; i < el.children.length; i++) {
      children.push(el.children[i]);
      sigs.push(sig(el.children[i]));
    }
    var g = 0;
    while (g < children.length) {
      if (!sigs[g]) { out += walk(children[g], depth); g++; continue; }
      var end = g + 1;
      while (end < children.length && sigs[end] === sigs[g]) end++;
      if (end - g >= 3) {
        for (var k = g; k < end; k++) out += compact(children[k], depth);
      } else {
        for (var k = g; k < end; k++) out += walk(children[k], depth);
      }
      g = end;
    }
    return out;
  }

  function walk(el, depth) {
    if (el.nodeType !== 1) return '';
    if (!isVisible(el)) return '';
    var tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG'].indexOf(tag) !== -1) return '';

    var out = '';
    var pad = '';
    for (var i = 0; i < depth; i++) pad += '  ';

    var interactive = isInteractive(el);
    if (interactive) {
      ref++;
      el.setAttribute('data-codia-ref', String(ref));
      var role = el.getAttribute('role') || tag.toLowerCase();
      var name = el.getAttribute('aria-label') || el.title || el.placeholder || directText(el) || el.value || '';
      var label = name.slice(0, 60);

      var flags = [];
      if (el.type && el.type !== 'submit' && tag === 'INPUT') flags.push(el.type);
      if (tag === 'INPUT' && el.value) flags.push('value="' + el.value.slice(0,30) + '"');
      if (el.checked) flags.push('checked');
      if (el.disabled) flags.push('disabled');
      if (el.getAttribute('aria-selected') === 'true') flags.push('selected');
      if (el.getAttribute('aria-expanded')) flags.push('expanded=' + el.getAttribute('aria-expanded'));
      if (tag === 'A' && el.href) flags.push('href="' + el.href.slice(0,80) + '"');

      var extra = flags.length ? ' (' + flags.join(', ') + ')' : '';
      out += pad + '[' + ref + '] ' + role + ' "' + label + '"' + extra + '\\n';
    } else if (/^H[1-6]/.test(tag)) {
      var hText = directText(el);
      if (hText) out += pad + tag.toLowerCase() + ': ' + hText + '\\n';
    } else if (tag === 'IMG') {
      out += pad + 'img "' + (el.alt || '').slice(0,40) + '"\\n';
    } else if (['P','SPAN','DIV','LI','TD','TH','LABEL'].indexOf(tag) !== -1) {
      var txt = directText(el);
      if (txt && txt.length > 2 && !el.querySelector('a,button,input,textarea,select,[role]')) {
        out += pad + 'text: ' + txt + '\\n';
      }
    }

    out += walkChildren(el, interactive ? depth + 1 : depth);
    return out;
  }

  var tree = walk(document.body, 0);

  // Hard cap: keep the first 80% and last 20%, cutting on line boundaries.
  if (tree.length > MAX_TREE) {
    var h = tree.lastIndexOf('\\n', Math.floor(MAX_TREE * 0.8));
    if (h < MAX_TREE * 0.4) h = Math.floor(MAX_TREE * 0.8);
    var tl = tree.indexOf('\\n', tree.length - Math.floor(MAX_TREE * 0.2));
    if (tl < 0) tl = tree.length - Math.floor(MAX_TREE * 0.2);
    tree = tree.slice(0, h) + '\\n\\n[... ' + (tl - h) + ' chars omitted ...]\\n\\n' + tree.slice(tl);
  }

  return {
    title: document.title,
    currentUrl: location.href,
    text: 'Page: ' + document.title + '\\nURL: ' + location.href + '\\n\\n' + tree
  };
})()`;

function _browserSession() {
  return session.fromPartition("persist:codia-browser");
}

function _installBrowserCookiePolicy() {
  if (_browserCookiePolicyInstalled) return;
  _browserCookiePolicyInstalled = true;
  const ses = _browserSession();
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (_browserAcceptCookies) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders = { ...(details.requestHeaders || {}) };
    for (const key of Object.keys(requestHeaders)) {
      if (key.toLowerCase() === "cookie") delete requestHeaders[key];
    }
    callback({ requestHeaders });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (_browserAcceptCookies) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const responseHeaders = { ...(details.responseHeaders || {}) };
    for (const key of Object.keys(responseHeaders)) {
      if (key.toLowerCase() === "set-cookie") delete responseHeaders[key];
    }
    callback({ responseHeaders });
  });
}

function _setBrowserAcceptCookies(enabled) {
  _browserAcceptCookies = enabled !== false;
  _installBrowserCookiePolicy();
}

async function _clearBrowserCookiesAndSiteData() {
  const ses = _browserSession();
  await ses.clearStorageData({
    storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
  });
}

const DEFAULT_BROWSER_WORKSPACE_KEY = "__codia_default_browser__";

function _browserWorkspaceKey(sessionPath) {
  return sessionPath || DEFAULT_BROWSER_WORKSPACE_KEY;
}

function _newBrowserTabId() {
  return `tab-${crypto.randomUUID()}`;
}

function _createBrowserWorkspace(sessionPath) {
  return {
    sessionPath: sessionPath || null,
    activeTabId: null,
    tabs: new Map(),
  };
}

function _getBrowserWorkspace(sessionPath) {
  return _browserViews.get(_browserWorkspaceKey(sessionPath)) || null;
}

function _ensureBrowserWorkspace(sessionPath) {
  const key = _browserWorkspaceKey(sessionPath);
  let workspace = _browserViews.get(key);
  if (!workspace) {
    workspace = _createBrowserWorkspace(sessionPath);
    _browserViews.set(key, workspace);
  }
  return workspace;
}

function _tabTitleFromWebContents(view) {
  const title = view?.webContents?.getTitle?.();
  return typeof title === "string" && title.trim() ? title.trim() : "New tab";
}

function _tabUrlFromWebContents(view) {
  const url = view?.webContents?.getURL?.();
  return typeof url === "string" && url.length > 0 ? url : null;
}

function _serializeBrowserTab(tab) {
  const view = tab.view;
  return {
    tabId: tab.tabId,
    title: _tabTitleFromWebContents(view) || tab.title || "New tab",
    url: _tabUrlFromWebContents(view) || tab.url || null,
    canGoBack: !!view?.webContents?.canGoBack?.(),
    canGoForward: !!view?.webContents?.canGoForward?.(),
    createdAt: tab.createdAt,
    updatedAt: Date.now(),
  };
}

function _serializeBrowserWorkspace(workspace) {
  const tabs = Array.from(workspace?.tabs?.values?.() || []).map(_serializeBrowserTab);
  const activeTabId = workspace?.activeTabId && tabs.some(tab => tab.tabId === workspace.activeTabId)
    ? workspace.activeTabId
    : tabs[0]?.tabId || null;
  return {
    sessionPath: workspace?.sessionPath || null,
    activeTabId,
    tabs,
  };
}

function _activeBrowserTabRecord(workspace) {
  if (!workspace || !workspace.tabs || workspace.tabs.size === 0) return null;
  return workspace.tabs.get(workspace.activeTabId) || workspace.tabs.values().next().value || null;
}

function _getViewForSession(sessionPath, tabId = null) {
  const workspace = _getBrowserWorkspace(sessionPath);
  if (workspace) {
    const tab = tabId ? workspace.tabs.get(tabId) : _activeBrowserTabRecord(workspace);
    if (!tab) return null;
    if (_isBrowserViewDestroyed(tab.view)) {
      _forgetBrowserView(tab.view, "destroyed");
      return null;
    }
    return tab.view;
  }
  if (_browserWebView && _isBrowserViewDestroyed(_browserWebView)) {
    _forgetBrowserView(_browserWebView, "destroyed");
    return null;
  }
  return _browserWebView;
}

function _ensureBrowserForSession(sessionPath, tabId = null) {
  const view = _getViewForSession(sessionPath, tabId);
  if (!view) throw new Error("No browser instance" + (sessionPath ? ` for session ${sessionPath}` : ""));
  return view;
}

function _ensureBrowserTabForSession(sessionPath, tabId = null) {
  const workspace = _ensureBrowserWorkspace(sessionPath);
  let tab = tabId ? workspace.tabs.get(tabId) : _activeBrowserTabRecord(workspace);
  if (!tab) {
    tab = _createBrowserTabRecord(sessionPath, { tabId });
    workspace.tabs.set(tab.tabId, tab);
    workspace.activeTabId = tab.tabId;
  }
  return tab;
}

function _ensureBrowser() {
  return _ensureBrowserForSession(null);
}

const FATAL_BROWSER_HOST_ERROR_PATTERNS = [
  /object has been destroyed/i,
  /no browser instance/i,
  /render process gone/i,
  /webcontents?.*destroy/i,
  /web contents?.*destroy/i,
  /target closed/i,
];

function _isFatalBrowserHostError(err) {
  const msg = err instanceof Error ? err.message : String(err || "");
  return FATAL_BROWSER_HOST_ERROR_PATTERNS.some((pattern) => pattern.test(msg));
}

function _isBrowserViewDestroyed(view) {
  try {
    return !view || !view.webContents || view.webContents.isDestroyed();
  } catch {
    return true;
  }
}

function _detachActiveBrowserView({ view = _browserWebView, destroy = false, hideIfVisible = false, reason = null } = {}) {
  if (!view || view !== _browserWebView) return false;
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    try { browserViewerWindow.contentView.removeChildView(view); } catch {}
  }
  _browserWebView = null;
  _currentBrowserSession = null;
  _currentBrowserTabId = null;
  if (destroy) {
    try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
    _removeBrowserTabRecord(view);
  }
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
    browserViewerWindow.webContents.send("browser-update", { running: false, reason });
    if (hideIfVisible) browserViewerWindow.hide();
  }
  return true;
}

function _forgetBrowserView(view, reason) {
  if (!view) return;
  const wasActive = view === _browserWebView;
  if (wasActive) _detachActiveBrowserView({ view, hideIfVisible: true, reason });
  _removeBrowserTabRecord(view);
  try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch {}
}

function _bindBrowserViewLifecycle(view, sessionPath) {
  const forget = (reason) => _forgetBrowserView(view, reason);
  try {
    view.webContents.once("destroyed", () => forget("destroyed"));
    view.webContents.on("render-process-gone", (_event, details) => {
      forget(`render-process-gone: ${details?.reason || "unknown"}`);
    });
  } catch {}
  if (sessionPath && _isBrowserViewDestroyed(view)) forget("destroyed");
}

function _removeBrowserTabRecord(view) {
  if (!view) return null;
  for (const [key, workspace] of _browserViews) {
    for (const [tabId, tab] of workspace.tabs) {
      if (tab.view !== view) continue;
      workspace.tabs.delete(tabId);
      if (workspace.activeTabId === tabId) {
        workspace.activeTabId = workspace.tabs.keys().next().value || null;
      }
      if (workspace.tabs.size === 0) _browserViews.delete(key);
      return { workspace, tabId };
    }
  }
  return null;
}

function _createBrowserWebContentsView(sessionPath) {
  _installBrowserCookiePolicy();
  const view = new WebContentsView({
    webPreferences: {
      session: _browserSession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  view.webContents.setAudioMuted(true);
  view.webContents.on("did-navigate", (_e, url) => {
    if (view === _browserWebView) _notifyViewerUrl(url);
  });
  view.webContents.on("did-navigate-in-page", (_e, url) => {
    if (view === _browserWebView) _notifyViewerUrl(url);
  });
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedBrowserUrl(url)) {
      _openUrlInNewBrowserTab(sessionPath, url, { show: view === _browserWebView });
    }
    return { action: "deny" };
  });
  view.webContents.on("page-title-updated", () => {
    if (view === _browserWebView) _notifyViewerUrl(view.webContents.getURL());
  });
  view.setBorderRadius(10);
  _bindBrowserViewLifecycle(view, sessionPath);
  return view;
}

function _createBrowserTabRecord(sessionPath, seed = {}) {
  const tabId = seed.tabId || _newBrowserTabId();
  const view = _createBrowserWebContentsView(sessionPath);
  const now = Date.now();
  return {
    tabId,
    view,
    title: seed.title || "New tab",
    url: seed.url || null,
    createdAt: seed.createdAt || now,
    updatedAt: seed.updatedAt || now,
  };
}

function _switchActiveBrowserTab(sessionPath, tabId) {
  const workspace = _getBrowserWorkspace(sessionPath);
  if (!workspace || !workspace.tabs.has(tabId)) return null;
  const tab = workspace.tabs.get(tabId);
  workspace.activeTabId = tabId;
  if (_browserWebView !== tab.view) {
    if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
    }
    _browserWebView = tab.view;
    _currentBrowserSession = workspace.sessionPath;
    _currentBrowserTabId = tabId;
    if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
      browserViewerWindow.contentView.addChildView(tab.view);
      _updateBrowserViewBounds();
    }
  }
  _notifyViewerUrl(_tabUrlFromWebContents(tab.view) || tab.url || "");
  return tab;
}

async function _openUrlInNewBrowserTab(sessionPath, url, options = {}) {
  const show = options.show !== false;
  const workspace = _ensureBrowserWorkspace(sessionPath);
  const tab = _createBrowserTabRecord(sessionPath, { url });
  workspace.tabs.set(tab.tabId, tab);
  workspace.activeTabId = tab.tabId;
  if (show) _switchActiveBrowserTab(sessionPath, tab.tabId);
  if (url && isAllowedBrowserUrl(url)) await tab.view.webContents.loadURL(url);
  if (tab.view === _browserWebView) _notifyViewerUrl(tab.view.webContents.getURL());
  return _serializeBrowserWorkspace(workspace);
}

function _ensureLiveWebContents(view, sessionPath) {
  if (_isBrowserViewDestroyed(view)) {
    _forgetBrowserView(view, "destroyed");
    throw new Error("Object has been destroyed" + (sessionPath ? ` for session ${sessionPath}` : ""));
  }
  return view.webContents;
}

async function _withLiveWebContents(sessionPath, fn, tabId = null) {
  const view = _ensureBrowserForSession(sessionPath, tabId);
  const wc = _ensureLiveWebContents(view, sessionPath);
  try {
    return await fn(wc, view);
  } catch (err) {
    if (_isFatalBrowserHostError(err)) {
      _forgetBrowserView(view, err.message);
    }
    throw err;
  }
}

function _delay(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function _updateBrowserViewBounds() {
  if (!_browserWebView || !browserViewerWindow || browserViewerWindow.isDestroyed()) return;
  const [width, height] = browserViewerWindow.getContentSize();

  const mx = 8, mt = 4, mb = 8;
  const bounds = {
    x: mx,
    y: TITLEBAR_HEIGHT + mt,
    width: Math.max(0, width - mx * 2),
    height: Math.max(0, height - TITLEBAR_HEIGHT - mt - mb),
  };
  if (bounds.width === 0 || bounds.height === 0) {
    console.warn("[browser] bounds resolved to zero:", { contentSize: [width, height], bounds, visible: browserViewerWindow.isVisible() });
  }
  _browserWebView.setBounds(bounds);
}

function _notifyViewerUrl(url) {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed() && _browserWebView) {
    const workspace = _getBrowserWorkspace(_currentBrowserSession);
    const serialized = _serializeBrowserWorkspace(workspace);
    browserViewerWindow.webContents.send("browser-update", {
      url,
      title: _browserWebView.webContents.getTitle(),
      canGoBack: _browserWebView.webContents.canGoBack(),
      canGoForward: _browserWebView.webContents.canGoForward(),
      sessionPath: _currentBrowserSession,
      activeTabId: _currentBrowserTabId || serialized.activeTabId,
      tabs: serialized.tabs,
    });
  }
}

async function handleBrowserCommand(cmd, params) {
  switch (cmd) {
    case "desktopPetControl":
      return {
        ok: false,
        error: "feature_disabled_in_professional_edition",
        feature: "desktopPet",
      };


    // One-shot hidden search view used by browser-backed web_search providers.
    // It is never registered in _browserViews and cannot steal the visible browser.
    case "browserSearch": {
      const provider = String(params.provider || "");
      const query = String(params.query || "").trim();
      const maxResults = Math.max(1, Math.min(10, Number(params.maxResults) || 5));
      if (!query) throw new Error("browserSearch requires query");

      const started = Date.now();
      const searchUrl = buildBrowserSearchUrl(provider, query, maxResults);
      const ses = session.fromPartition("codia-search");
      const view = new WebContentsView({
        webPreferences: {
          session: ses,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      view.webContents.setAudioMuted(true);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      try {
        const NAV_TIMEOUT = 30000;
        await Promise.race([
          view.webContents.loadURL(searchUrl),
          new Promise((_, reject) => setTimeout(() => {
            try { view.webContents.stop(); } catch {}
            reject(new Error(`Search navigation timed out after ${NAV_TIMEOUT / 1000}s: ${searchUrl}`));
          }, NAV_TIMEOUT)),
        ]);
        const wait = await waitForBrowserState(view.webContents, {
          state: params.state || "stable",
          timeoutMs: Math.min(Number(params.timeout) || 5000, 10000),
        });
        const extracted = await view.webContents.executeJavaScript(
          buildBrowserSearchExtractionScript(provider, maxResults),
        );
        return {
          query,
          provider,
          source_type: "browser",
          results: extracted.results || [],
          diagnostics: {
            search_url: searchUrl,
            final_url: extracted.final_url || view.webContents.getURL(),
            page_title: extracted.title || view.webContents.getTitle(),
            status: extracted.status || "",
            blocked: !!extracted.blocked,
            captcha: !!extracted.captcha,
            reason: extracted.reason || "",
            elapsed_ms: Date.now() - started,
            wait,
          },
        };
      } finally {
        try { view.webContents.close(); } catch {}
      }
    }


    case "launch": {
      const sp = params.sessionPath || null;
      _setBrowserAcceptCookies(params.acceptCookies !== false);
      const workspace = _ensureBrowserWorkspace(sp);
      if (workspace.tabs.size > 0) {
        return _serializeBrowserWorkspace(workspace);
      }
      const restoreTabs = Array.isArray(params.tabs) && params.tabs.length > 0
        ? params.tabs
        : [{ tabId: params.tabId || undefined, url: null, title: "New tab" }];
      for (const seed of restoreTabs) {
        const tab = _createBrowserTabRecord(sp, seed || {});
        workspace.tabs.set(tab.tabId, tab);
        if (seed?.url && isAllowedBrowserUrl(seed.url)) {
          tab.view.webContents.loadURL(seed.url).catch(() => {});
        }
      }
      workspace.activeTabId = params.activeTabId && workspace.tabs.has(params.activeTabId)
        ? params.activeTabId
        : workspace.tabs.keys().next().value || null;
      if (!_browserWebView) {
        const activeTab = _activeBrowserTabRecord(workspace);
        _browserWebView = activeTab?.view || null;
        _currentBrowserSession = sp;
        _currentBrowserTabId = activeTab?.tabId || null;

        createBrowserViewerWindow({ show: false });

        if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
          browserViewerWindow.contentView.addChildView(_browserWebView);
          _updateBrowserViewBounds();
          console.log("[browser] launch: view mounted (silent), bounds:", _browserWebView.getBounds());
          setTimeout(() => {
            if (_browserWebView) {
              _browserWebView.webContents.focus();
            }
          }, 300);
        }
      }
      // Otherwise the new view stays in the map for background control.
      return _serializeBrowserWorkspace(workspace);
    }

    // Close and destroy the browser instance for the requested session.
    case "close": {
      const sp = params.sessionPath;
      const workspace = _getBrowserWorkspace(sp);
      if (workspace) {
        const active = _activeBrowserTabRecord(workspace);
        if (active?.view === _browserWebView) {
          _detachActiveBrowserView({ view: active.view, destroy: false, hideIfVisible: true });
        }
        for (const tab of workspace.tabs.values()) {
          try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
        }
        _browserViews.delete(_browserWorkspaceKey(sp));
      }
      return {};
    }


    case "suspend": {
      const sp = params.sessionPath;
      const view = sp ? _getViewForSession(sp) : _browserWebView;
      if (view && view === _browserWebView) {
        _detachActiveBrowserView({ view, hideIfVisible: true });
      }
      return {};
    }


    case "resume": {
      const sp = params.sessionPath;
      const workspace = _getBrowserWorkspace(sp);
      if (!sp || !workspace || workspace.tabs.size === 0) {
        return { found: false };
      }
      const tabId = params.tabId || workspace.activeTabId;
      const view = _getViewForSession(sp, tabId);
      if (!view) return { found: false };
      if (_browserWebView && _browserWebView !== view && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
      }
      _browserWebView = view;
      _currentBrowserSession = sp;
      _currentBrowserTabId = tabId;

      // Attach the view to a hidden viewer window; the user can open it manually.
      createBrowserViewerWindow({ show: false });
      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.contentView.addChildView(view);
        _updateBrowserViewBounds();
        // Restore input focus for scrolling and keyboard interaction.
        view.webContents.focus();
      }
      // Notify the title bar of the current URL.
      const url = view.webContents.getURL();
      if (url) _notifyViewerUrl(url);
      return { found: true, url, ..._serializeBrowserWorkspace(workspace) };
    }

    case "newTab": {
      const sp = params.sessionPath || null;
      const workspace = _ensureBrowserWorkspace(sp);
      const tab = _createBrowserTabRecord(sp, { url: params.url || null });
      workspace.tabs.set(tab.tabId, tab);
      workspace.activeTabId = tab.tabId;
      const shouldShow = _currentBrowserSession === sp || !_browserWebView;
      if (shouldShow) {
        _switchActiveBrowserTab(sp, tab.tabId);
      }
      if (params.url && isAllowedBrowserUrl(params.url)) {
        await tab.view.webContents.loadURL(params.url);
      }
      if (tab.view === _browserWebView) _notifyViewerUrl(tab.view.webContents.getURL());
      return _serializeBrowserWorkspace(workspace);
    }

    case "switchTab": {
      const sp = params.sessionPath || null;
      const workspace = _getBrowserWorkspace(sp);
      if (!workspace || !workspace.tabs.has(params.tabId)) {
        throw new Error(`No browser tab ${params.tabId}`);
      }
      _switchActiveBrowserTab(sp, params.tabId);
      return _serializeBrowserWorkspace(workspace);
    }

    case "closeTab": {
      const sp = params.sessionPath || null;
      const workspace = _getBrowserWorkspace(sp);
      if (!workspace || !workspace.tabs.has(params.tabId)) {
        throw new Error(`No browser tab ${params.tabId}`);
      }
      const tab = workspace.tabs.get(params.tabId);
      const tabIds = Array.from(workspace.tabs.keys());
      const closedIndex = tabIds.indexOf(params.tabId);
      const nextTabId = tabIds[closedIndex + 1] || tabIds[closedIndex - 1] || null;
      if (tab.view === _browserWebView) {
        _detachActiveBrowserView({ view: tab.view, destroy: false, hideIfVisible: false });
      }
      workspace.tabs.delete(params.tabId);
      try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
      if (workspace.tabs.size === 0) {
        _browserViews.delete(_browserWorkspaceKey(sp));
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.webContents.send("browser-update", {
            running: false,
            sessionPath: sp,
            activeTabId: null,
            tabs: [],
          });
        }
        return { activeTabId: null, tabs: [] };
      }
      workspace.activeTabId = nextTabId && workspace.tabs.has(nextTabId)
        ? nextTabId
        : workspace.tabs.keys().next().value;
      _switchActiveBrowserTab(sp, workspace.activeTabId);
      return _serializeBrowserWorkspace(workspace);
    }


    case "navigate": {
      if (!isAllowedBrowserUrl(params.url)) {
        throw new Error("Only http/https URLs are allowed");
      }
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const NAV_TIMEOUT = 30000;
        await Promise.race([
          wc.loadURL(params.url),
          new Promise((_, reject) => setTimeout(() => {
            try { wc.stop(); } catch {}
            reject(new Error(`Navigation timed out after ${NAV_TIMEOUT / 1000}s: ${params.url}`));
          }, NAV_TIMEOUT)),
        ]);
        const wait = await waitForBrowserState(wc, {
          state: params.state || "stable",
          timeoutMs: Math.min(Number(params.timeout) || 5000, 10000),
        });
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return {
          url: snap.currentUrl,
          title: snap.title,
          snapshot: snap.text,
          tabId: params.tabId || _currentBrowserTabId,
          canGoBack: wc.canGoBack(),
          canGoForward: wc.canGoForward(),
          diagnostics: { wait },
        };
      }, params.tabId || null);
    }


    case "snapshot": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return {
          currentUrl: snap.currentUrl,
          title: snap.title,
          tabId: params.tabId || _currentBrowserTabId,
          text: snap.text,
        };
      }, params.tabId || null);
    }


    case "screenshot": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const img = await wc.capturePage();
        const jpeg = img.toJPEG(75);
        return { base64: jpeg.toString("base64"), tabId: params.tabId || _currentBrowserTabId };
      }, params.tabId || null);
    }


    case "thumbnail": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const img = await wc.capturePage();
        const resized = img.resize({ width: 400 });
        const jpeg = resized.toJPEG(60);
        return { base64: jpeg.toString("base64") };
      }, params.tabId || null);
    }


    case "click": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const clickRef = Number(params.ref);
        await wc.executeJavaScript(
          "(function(){ var el = document.querySelector('[data-codia-ref=\"" + clickRef + "\"]');" +
          " if (!el) throw new Error('Element [" + clickRef + "] not found');" +
          " el.scrollIntoView({block:'center'}); el.click(); })()"
        );
        await _delay(800);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }


    case "type": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        if (params.ref != null) {
          const typeRef = Number(params.ref);
          await wc.executeJavaScript(
            "(function(){ var el = document.querySelector('[data-codia-ref=\"" + typeRef + "\"]');" +
            " if (!el) throw new Error('Element [" + typeRef + "] not found');" +
            " el.scrollIntoView({block:'center'}); el.focus();" +
            " if (el.select) el.select(); })()"
          );
          await _delay(100);
        }
        await wc.insertText(params.text);
        if (params.pressEnter) {
          await _delay(100);
          wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
          await _delay(800);
        }
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }


    case "scroll": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const delta = (params.direction === "up" ? -1 : 1) * (params.amount || 3) * 300;
        await wc.executeJavaScript("window.scrollBy({top:" + delta + ",behavior:'smooth'})");
        await _delay(500);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }


    case "select": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const selRef = Number(params.ref);
        const safeValue = JSON.stringify(params.value);
        await wc.executeJavaScript(
          "(function(){ var el = document.querySelector('[data-codia-ref=\"" + selRef + "\"]');" +
          " if (!el) throw new Error('Element [" + selRef + "] not found');" +
          " el.value = " + safeValue + ";" +
          " el.dispatchEvent(new Event('change',{bubbles:true})); })()"
        );
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }


    case "pressKey": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const parts = params.key.split("+");
        const keyCode = parts[parts.length - 1];
        const modifiers = parts.slice(0, -1).map(function(m) { return m.toLowerCase(); });
        const keyMap = { Enter: "Return", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Space: "Space" };
        const mappedKey = keyMap[keyCode] || keyCode;
        wc.sendInputEvent({ type: "keyDown", keyCode: mappedKey, modifiers });
        wc.sendInputEvent({ type: "keyUp", keyCode: mappedKey, modifiers });
        await _delay(300);
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text };
      }, params.tabId || null);
    }


    case "wait": {
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const timeout = Math.min(Number(params.timeout) || 5000, 10000);
        const wait = await waitForBrowserState(wc, {
          state: params.state || "stable",
          timeoutMs: timeout,
        });
        const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT);
        return { currentUrl: snap.currentUrl, title: snap.title, tabId: params.tabId || _currentBrowserTabId, text: snap.text, diagnostics: { wait } };
      }, params.tabId || null);
    }


    case "evaluate": {
      if (!params.expression || params.expression.length > 10000) {
        throw new Error("Expression too long (max 10000 chars)");
      }
      console.log(`[browser:evaluate] ${params.expression.slice(0, 200)}${params.expression.length > 200 ? "..." : ""}`);
      return await _withLiveWebContents(params.sessionPath, async (wc) => {
        const result = await wc.executeJavaScript(params.expression);
        const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { value: serialized || "undefined", tabId: params.tabId || _currentBrowserTabId };
      }, params.tabId || null);
    }


    case "show": {
      const sp = params.sessionPath;
      const tabId = params.tabId || null;
      const view = sp ? _getViewForSession(sp, tabId) : _browserWebView;
      if (!view) return {};
      const workspace = _getBrowserWorkspace(sp);
      const activeRecord = workspace
        ? (tabId ? workspace.tabs.get(tabId) : _activeBrowserTabRecord(workspace))
        : null;
      if (workspace && activeRecord) workspace.activeTabId = activeRecord.tabId;


      if (view !== _browserWebView) {

        if (_browserWebView && browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          try { browserViewerWindow.contentView.removeChildView(_browserWebView); } catch {}
        }
        _browserWebView = view;
        _currentBrowserSession = sp;
        _currentBrowserTabId = activeRecord?.tabId || tabId || null;
        if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
          browserViewerWindow.contentView.addChildView(view);
          _updateBrowserViewBounds();
        }
      }

      if (browserViewerWindow && !browserViewerWindow.isDestroyed()) {
        browserViewerWindow.show();
        browserViewerWindow.focus();

        view.webContents.focus();
        setTimeout(() => {
          if (view === _browserWebView) view.webContents.focus();
        }, 100);
      } else {
        _browserWebView = view;
        _currentBrowserSession = sp;
        _currentBrowserTabId = activeRecord?.tabId || tabId || _currentBrowserTabId;
        createBrowserViewerWindow();
      }
      _notifyViewerUrl(view.webContents.getURL());
      return workspace ? _serializeBrowserWorkspace(workspace) : {};
    }

    // Destroy the suspended view for the requested session.
    case "destroyView": {
      const sp = params.sessionPath;
      const workspace = _getBrowserWorkspace(sp);
      if (workspace) {
        for (const tab of workspace.tabs.values()) {
          if (tab.view === _browserWebView) {
            _detachActiveBrowserView({ view: tab.view, destroy: false, hideIfVisible: true });
          }
          try { if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close(); } catch {}
        }
        _browserViews.delete(_browserWorkspaceKey(sp));
      }
      return {};
    }

    case "setAcceptCookies": {
      _setBrowserAcceptCookies(params.enabled !== false);
      return { ok: true, acceptCookies: _browserAcceptCookies };
    }

    case "clearBrowserCookiesAndSiteData": {
      await _clearBrowserCookiesAndSiteData();
      return { ok: true };
    }

    default:
      throw new Error("Unknown browser command: " + cmd);
  }
}


function teardownBrowserCommands() {
  browserCommandGeneration++;
  if (browserCommandReconnectTimer) {
    clearTimeout(browserCommandReconnectTimer);
    browserCommandReconnectTimer = null;
  }
  const ws = browserCommandSocket;
  browserCommandSocket = null;
  if (ws) {
    try { ws.removeAllListeners(); } catch {}
    try { ws.terminate?.(); } catch {
      try { ws.close?.(); } catch {}
    }
  }
}

function setupBrowserCommands() {
  if (!serverPort || !serverToken) return;

  teardownBrowserCommands();
  const generation = browserCommandGeneration;
  const WebSocket = require("ws");
  const url = `ws://127.0.0.1:${serverPort}/internal/browser?token=${serverToken}`;

  function connect() {
    if (generation !== browserCommandGeneration || isQuitting) return;
    browserCommandReconnectTimer = null;
    const ws = new WebSocket(url);
    browserCommandSocket = ws;
    ws.on("open", () => {
      console.log("[desktop] Browser control WS connected");
    });
    ws.on("message", async (data) => {
      if (generation !== browserCommandGeneration) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg?.type !== "browser-cmd") return;
      const { id, cmd, params } = msg;
      const _bLog = (line) => { try { require("fs").appendFileSync(require("path").join(codiaHome, "browser-cmd.log"), `${new Date().toISOString()} ${line}\n`); } catch {} };
      _bLog(`-> received cmd=${cmd} id=${id}`);
      try {
        const result = await handleBrowserCommand(cmd, params || {});
        _bLog(`ok cmd=${cmd} result=${JSON.stringify(result).slice(0, 200)} wsReady=${ws.readyState}`);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "browser-result", id, result }));
          _bLog("ok sent result");
        } else {
          _bLog(`warn ws not ready (${ws.readyState}), result dropped`);
        }
      } catch (err) {
        _bLog(`error cmd=${cmd} error=${err.message}`);
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "browser-result", id, error: err.message }));
        }
      }
    });
    ws.on("close", () => {
      if (browserCommandSocket === ws) browserCommandSocket = null;
      if (!isQuitting && generation === browserCommandGeneration) {
        browserCommandReconnectTimer = setTimeout(connect, 2000);
      }
    });
    ws.on("error", () => {}); // close event handles reconnect
  }

  connect();
}


function createOnboardingWindow(query = {}) {
  onboardingWindow = new BrowserWindow({
    width: 560,
    height: 780,
    resizable: false,
    frame: false,
    title: runtimeProductName(),
    ...titleBarOpts({ x: 16, y: 16 }),
    backgroundColor: "#F8F4FF",
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  attachRendererLaunchDiagnostics(onboardingWindow, "onboarding");
  loadWindowURL(onboardingWindow, "onboarding", { query });

  onboardingWindow.once("ready-to-show", () => {

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    onboardingWindow.show();
  });

  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
  });
}


async function checkForUpdates() {
  await checkForUpdatesAuto();
}


const SCREENSHOT_THEMES = {
  "solarized-light":         { width: 460, backgroundColor: "#F8F5ED" },
  "solarized-dark":          { width: 460, backgroundColor: "#002b36" },
  "solarized-light-desktop": { width: 880, backgroundColor: "#F8F5ED" },
  "solarized-dark-desktop":  { width: 880, backgroundColor: "#002b36" },
  "codia-brand":              { width: 460, backgroundColor: "#F4F6FA" },
  "codia-brand-desktop":      { width: 880, backgroundColor: "#F4F6FA" },
  "sakura-light":            { width: 460, backgroundColor: "#8ABDCE" },
  "sakura-light-desktop":    { width: 880, backgroundColor: "#8ABDCE" },
};

const SCREENSHOT_CAPTURE_SCALE = 2;
const SCREENSHOT_MAX_SEGMENT = 4000;
const SCREENSHOT_SEGMENT_SCREEN_MARGIN = 96;

function resolveScreenshotMaxSegmentHeight(screenApi) {
  let workAreaHeight = null;
  try {
    const display = screenApi?.getPrimaryDisplay?.();
    const height = display?.workArea?.height || display?.bounds?.height;
    if (Number.isFinite(height) && height > 0) {
      workAreaHeight = Math.floor(height);
    }
  } catch { /* keep default cap */ }

  if (!workAreaHeight) return SCREENSHOT_MAX_SEGMENT;

  const stableHeight = workAreaHeight - SCREENSHOT_SEGMENT_SCREEN_MARGIN;
  const cappedHeight = stableHeight > 0 ? stableHeight : workAreaHeight;
  return Math.max(1, Math.min(SCREENSHOT_MAX_SEGMENT, cappedHeight));
}

function stitchScreenshotSegments(segments, scale) {
  const parts = segments.map((seg) => PNG.sync.read(seg.toPNG({ scaleFactor: scale })));
  if (parts.length === 0) {
    throw new Error("No screenshot segments captured");
  }

  const width = parts[0].width;
  let height = 0;
  for (const part of parts) {
    if (part.width !== width) {
      throw new Error(`Screenshot segment width changed during capture: expected ${width}px, got ${part.width}px`);
    }
    height += part.height;
  }

  const full = new PNG({ width, height });
  let yOffset = 0;
  for (const part of parts) {
    part.data.copy(full.data, yOffset * width * 4);
    yOffset += part.height;
  }

  return PNG.sync.write(full);
}

let _screenshotWin = null;

function getScreenshotWindow() {
  if (_screenshotWin && !_screenshotWin.isDestroyed()) return _screenshotWin;
  _screenshotWin = new BrowserWindow({
    width: 460, height: 100,
    show: false, skipTaskbar: true,
    webPreferences: { offscreen: { deviceScaleFactor: 2 } },
  });
  return _screenshotWin;
}

let _screenshotLock = Promise.resolve();

function withScreenshotLock(fn) {
  const prev = _screenshotLock;
  let resolve;
  _screenshotLock = new Promise(r => { resolve = r; });
  return prev.then(() => fn().finally(resolve));
}

function getScreenshotResourcePath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "screenshot-themes", ...segments);
  }
  return path.join(__dirname, "src", "screenshot-themes", ...segments);
}

// Lazy singletons: initialize MarkdownIt and KaTeX CSS once.
let _screenshotMd = null;
let _screenshotKatexCSS = null;

function _getScreenshotMd() {
  if (_screenshotMd) return _screenshotMd;
  const MarkdownIt = require("markdown-it");
  _screenshotMd = new MarkdownIt({ html: true, breaks: true, linkify: true, typographer: true });
  try {
    const mk = require("@traptitech/markdown-it-katex");
    _screenshotMd.use(mk);
  } catch { /* katex not available */ }
  return _screenshotMd;
}

function _getKatexCSS() {
  if (_screenshotKatexCSS !== null) return _screenshotKatexCSS;
  _screenshotKatexCSS = "";
  try {
    const candidates = [
      require.resolve("katex/dist/katex.min.css"),
      path.join(__dirname, "node_modules", "katex", "dist", "katex.min.css"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) { _screenshotKatexCSS = fs.readFileSync(p, "utf-8"); break; }
    }
  } catch { /* no katex */ }
  return _screenshotKatexCSS;
}

function buildScreenshotHTML(payload) {
  const md = _getScreenshotMd();

  const themeName = payload.theme;
  const themeConf = SCREENSHOT_THEMES[themeName];
  if (!themeConf) throw new Error(`Unknown screenshot theme: ${themeName}`);

  const themeCssPath = getScreenshotResourcePath(`${themeName}.css`);
  const themeCSS = fs.readFileSync(themeCssPath, "utf-8");

  const katexCSS = _getKatexCSS();

  let extraCSS = `:root { --screenshot-page-bg: ${themeConf.backgroundColor}; }`;
  if (themeName.startsWith("sakura-")) {
    const isDesktop = themeName.endsWith("-desktop");
    const branchFile = isDesktop ? "sakura-branch-desktop.png" : "sakura-branch-mobile.png";
    const flowerFile = isDesktop ? "sakura-flower-desktop.png" : "sakura-flower-mobile.png";
    const branchUrl = pathToFileURL(getScreenshotResourcePath("sakura", branchFile)).href;
    const flowerUrl = pathToFileURL(getScreenshotResourcePath("sakura", flowerFile)).href;
    extraCSS += `\n:root { --sakura-branch-url: url('${branchUrl}'); --sakura-flower-url: url('${flowerUrl}'); }`;
  }

  // Inline the logo as a data URL so isolated preview windows can load it from asar.
  let logoUrl = "";
  try {
    const logoPath = resolveRuntimeBrandImagePath();
    const logoBuf = fs.readFileSync(logoPath);
    logoUrl = `data:image/png;base64,${logoBuf.toString("base64")}`;
  } catch {  }

  function renderBlock(b) {
    if (b.type === "html") return b.content;
    if (b.type === "markdown") return md.render(b.content);
    if (b.type === "image") return `<img src="${b.content}" class="chat-image" />`;
    return "";
  }

  let bodyHTML = "";
  if (payload.mode === "article" && payload.markdown) {
    bodyHTML = `<article>${md.render(payload.markdown)}</article>`;
  } else if (payload.messages) {
    const parts = [];
    for (const msg of payload.messages) {
      const blockHTMLs = msg.blocks.map(renderBlock).join("");

      if (payload.mode === "conversation") {
        const avatarImg = msg.avatarDataUrl
          ? `<img class="chat-avatar" src="${msg.avatarDataUrl}" />`
          : `<div class="chat-avatar chat-avatar-fallback"></div>`;
        parts.push(`
          <div class="chat-message">
            <div class="chat-header">
              ${avatarImg}
              <span class="chat-name">${msg.name.replace(/</g, "&lt;")}</span>
            </div>
            <div class="chat-body">${blockHTMLs}</div>
          </div>
        `);
      } else {
        parts.push(blockHTMLs);
      }
    }
    bodyHTML = `<article>${parts.join("")}</article>`;
  }

  const layoutCSS = `
    .chat-message { margin-bottom: 1.8em; }
    .chat-header { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em; }
    .chat-avatar { width: 32px; height: 32px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
    .chat-avatar-fallback { background: #ddd; }
    .chat-name { font-size: 0.9em; font-weight: 600; opacity: 0.7; }
    .chat-body { padding-left: 0; }
    .chat-body p:last-child { margin-bottom: 0; }
    .chat-image { width: ${themeName.endsWith("-desktop") ? "66.666%" : "100%"}; max-width: 100%; height: auto; border-radius: 6px; margin: 0.8em 0; display: block; }
    .watermark {
      display: flex; align-items: center; justify-content: center;
      gap: 0.5em; padding: 1.5em 0 1em; opacity: 0.5;
    }
    .watermark-logo { width: ${themeName.endsWith("-desktop") ? "28px" : "20px"}; height: ${themeName.endsWith("-desktop") ? "28px" : "20px"}; border-radius: 50%; object-fit: cover; }
    .watermark-text { font-size: ${themeName.endsWith("-desktop") ? "0.85em" : "0.75em"}; color: #999; letter-spacing: 0.05em; }
    html, body { background: var(--screenshot-page-bg); scrollbar-width: none; -ms-overflow-style: none; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
  `;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>${katexCSS}</style>
  <style>${themeCSS}</style>
  <style>${extraCSS}</style>
  <style>${layoutCSS}</style>
</head>
<body>
  ${bodyHTML}
  <footer class="watermark">
    <img class="watermark-logo" src="${logoUrl}" />
    <span class="watermark-text">${runtimeProductName()}</span>
  </footer>
</body>
</html>`;
}

async function screenshotCapture(htmlContent, width) {
  const offscreen = getScreenshotWindow();
  const scale = SCREENSHOT_CAPTURE_SCALE;

  offscreen.setSize(width, 100);

  const tmpDir = app.getPath("temp");
  const tmpHtml = path.join(tmpDir, `codia-ss-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, htmlContent, "utf-8");

  try {
    await offscreen.loadURL(pathToFileURL(tmpHtml).href);

    await offscreen.webContents.executeJavaScript(
      `document.fonts.ready.then(() => true)`
    );
    await new Promise(r => setTimeout(r, 300));

    const totalHeight = await offscreen.webContents.executeJavaScript(`
      Math.max(
        document.body.scrollHeight,
        document.body.offsetHeight,
        document.documentElement.scrollHeight,
        document.documentElement.offsetHeight
      )
    `);

    let pngBuffer;
    const maxSegmentHeight = resolveScreenshotMaxSegmentHeight(screen);

    if (totalHeight <= maxSegmentHeight) {
      offscreen.setSize(width, totalHeight);
      await new Promise(r => setTimeout(r, 200));
      const image = await offscreen.webContents.capturePage({ x: 0, y: 0, width, height: totalHeight }, { stayHidden: true });
      pngBuffer = image.toPNG({ scaleFactor: scale });
    } else {
      const segments = [];
      let captured = 0;
      while (captured < totalHeight) {
        const segH = Math.min(maxSegmentHeight, totalHeight - captured);
        offscreen.setSize(width, segH);
        await offscreen.webContents.executeJavaScript(`window.scrollTo(0, ${captured})`);
        await new Promise(r => setTimeout(r, 300));
        const segImage = await offscreen.webContents.capturePage({ x: 0, y: 0, width, height: segH }, { stayHidden: true });
        segments.push(segImage);
        captured += segH;
      }

      pngBuffer = stitchScreenshotSegments(segments, scale);
    }

    return pngBuffer;
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

function resolveConsoleCwd(rawCwd) {
  const isDirectory = (candidate) => {
    try {
      return !!candidate && fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  };

  if (typeof rawCwd === "string") {
    const trimmed = rawCwd.trim();
    if (trimmed && path.isAbsolute(trimmed) && isDirectory(trimmed)) {
      return trimmed;
    }
  }

  const projectRoot = path.resolve(__dirname, "..");
  const candidates = app.isPackaged
    ? [path.dirname(process.execPath), process.resourcesPath, process.cwd(), os.homedir()]
    : [projectRoot, process.cwd(), os.homedir()];

  return candidates.find(isDirectory) || os.homedir();
}

function splitConsoleArgs(text) {
  return String(text || "").match(/"[^"]*"|'[^']*'|\S+/g)
    ?.map((part) => part.replace(/^(["'])(.*)\1$/, "$2")) || [];
}

function resolveWindowsPowerShellPath() {
  if (process.platform !== "win32") return "powershell";
  const roots = Array.from(new Set([
    process.env.SystemRoot,
    process.env.WINDIR,
    "C:\\Windows",
  ].filter(Boolean)));
  const candidates = roots.flatMap((root) => [
    path.join(root, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  ]);
  return candidates.find((candidate) => fs.existsSync(candidate))
    || path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function buildConsoleCommand(kind, command) {
  const text = String(command || "").trim();
  if (!text) throw new Error("command is required");
  if (kind === "codiactl") {
    const scriptPath = path.resolve(__dirname, "..", "scripts", "codiactl.mjs");
    return {
      executable: process.execPath,
      args: [scriptPath, ...splitConsoleArgs(text)],
      env: {
        ...process.env,
        CODIA_HOME: codiaHome,
        CODIA_API_BASE: serverPort ? `http://127.0.0.1:${serverPort}` : process.env.CODIA_API_BASE,
        CODIA_TOKEN: serverToken || process.env.CODIA_TOKEN,
        ELECTRON_RUN_AS_NODE: "1",
        NO_COLOR: "1",
      },
    };
  }
  if (process.platform === "win32") {
    return {
      executable: resolveWindowsPowerShellPath(),
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", text],
      env: process.env,
    };
  }
  return {
    executable: process.env.SHELL || "/bin/sh",
    args: ["-lc", text],
    env: process.env,
  };
}

function runConsoleCommand(kind, command, cwd) {
  return new Promise((resolve) => {
    let spec;
    let resolvedCwd;
    try {
      spec = buildConsoleCommand(kind, command);
      resolvedCwd = resolveConsoleCwd(cwd);
    } catch (err) {
      resolve({ ok: false, code: 1, output: err.message || String(err) });
      return;
    }
    const child = spawn(spec.executable, spec.args, {
      cwd: resolvedCwd,
      env: spec.env,
      windowsHide: true,
    });
    let output = "";
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 120_000) output = output.slice(-120_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      const detail = [
        err.message || String(err),
        `executable: ${spec.executable}`,
        `cwd: ${resolvedCwd}`,
      ].join("\n");
      resolve({ ok: false, code: 1, output: detail });
    });
    child.on("close", (code) => resolve({ ok: code === 0, code: code ?? 0, output }));
  });
}

wrapIpcHandler("get-server-port", () => serverPort);
wrapIpcHandler("get-server-token", () => serverToken);
wrapIpcHandler("get-splash-info", () => resolveSplashInfo());
wrapIpcHandler("get-avatar-path", (_event, role) => {
  if (role && role !== "agent") return null;
  const agentId = getCurrentAgentId();
  return resolveAgentAvatarPath(codiaHome, agentId) || resolveRuntimeDefaultAssistantAvatarPath() || null;
});
wrapIpcHandler("console-run-command", (_event, payload = {}) => {
  const kind = payload.kind === "codiactl" ? "codiactl" : "powershell";
  return runConsoleCommand(kind, payload.command, payload.cwd);
});
wrapIpcHandler("run-edit-command", (event, command) => {
  const allowed = new Set(["cut", "copy", "paste", "selectAll"]);
  if (!allowed.has(command)) {
    throw new Error(`Unknown edit command: ${command}`);
  }
  event.sender[command]();
  return true;
});
wrapIpcHandler("restart-server", () => restartServerFromRenderer());
wrapIpcHandler("is-e2e-mode", () => _isE2E);
wrapIpcHandler("read-clipboard-text", () => (_isE2E ? clipboard.readText() : ""));
wrapIpcHandler("write-clipboard-text", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
wrapIpcHandler("get-runtime-diagnostics-state", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  try {
    return await mainWindow.webContents.executeJavaScript(
      "window.__CODIA_RUNTIME_DIAGNOSTICS__?.getStateSnapshot?.() ?? null",
      true,
    );
  } catch (err) {
    console.warn("[desktop] get-runtime-diagnostics-state failed:", err?.message || err);
    return null;
  }
});
wrapIpcHandler("get-app-version", () => app.getVersion());
wrapIpcHandler("get-gpu-runtime-state", () => ({
  gpuSafeMode: gpuStartupPolicy.shouldDisableHardwareAcceleration === true,
  hardwareAccelerationEnabled: app.isHardwareAccelerationEnabled(),
}));
wrapIpcHandler("get-auto-launch-status", () => getAutoLaunchStatus({ app }));
wrapIpcHandler("set-auto-launch-enabled", (_event, enabled) => setAutoLaunchEnabled({ app, enabled: enabled === true }));
wrapIpcHandler("get-keep-awake-status", () => keepAwakeManager.getStatus());
wrapIpcHandler("set-keep-awake-enabled", (_event, enabled) => keepAwakeManager.setEnabled(enabled === true));
wrapIpcHandler("quick-chat-reload-shortcut", () => reloadQuickChatShortcut());
wrapIpcHandler("quick-chat-shortcut-status", () => ({
  shortcut: registeredQuickChatShortcut || readQuickChatPreferences().shortcut,
  registered: !!registeredQuickChatShortcut && globalShortcut.isRegistered(registeredQuickChatShortcut),
}));
wrapIpcHandler("quick-chat-show", () => {
  showQuickChatWindow();
  return true;
});
wrapIpcHandler("quick-chat-hide", () => {
  hideQuickChatWindow();
  return true;
});
wrapIpcHandler("quick-chat-resize", (_event, request) => {
  applyQuickChatMode(request);
  return true;
});
wrapIpcHandler("quick-chat-open-session", (_event, sessionPath) => {
  if (!sessionPath || typeof sessionPath !== "string") return false;
  showPrimaryWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("quick-chat-open-session", { sessionPath });
  }
  hideQuickChatWindow();
  return true;
});
// Legacy compatibility: check-update returns available version metadata.
wrapIpcHandler("check-update", () => {
  const s = getUpdateState();
  if (s.status === "available" || s.status === "downloaded") {
    return { version: s.version, downloadUrl: s.downloadUrl || s.releaseUrl };
  }
  return null;
});

wrapIpcHandler("open-settings", (_event, tab, theme) => createSettingsWindow(tab, theme));
wrapIpcHandler("select-folder", async (event) => {
  // Resolve the window that initiated the request.
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: mt("dialog.selectFolder", null, "Select Working Folder"),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// Select attachments: multiple files.
wrapIpcBestEffortHandler("select-files", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return [];
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    title: mt("dialog.selectFiles", null, "Select Files"),
  });
  if (result.canceled || !result.filePaths.length) return [];
  return result.filePaths;
});
wrapIpcHandler("select-skill", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    title: mt("dialog.selectSkill", null, "Select Skill"),
    filters: [
      { name: "Skill", extensions: ["zip", "skill"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

wrapIpcHandler("select-plugin", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    title: mt("dialog.selectPlugin", null, "Select Plugin"),
    filters: [
      { name: "Plugin", extensions: ["zip"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});


wrapIpcHandler("open-skill-viewer", (event, data) => {
  if (!data) return;
  const sourceWindow = BrowserWindow.fromWebContents(event.sender)
    || (settingsWindow && !settingsWindow.isDestroyed() && event.sender === settingsWindow.webContents
      ? settingsWindow
      : null)
    || mainWindow;


  if (data.skillPath && path.isAbsolute(data.skillPath)) {
    const fileExt = path.extname(data.skillPath).toLowerCase();
    if (fileExt === ".skill" || fileExt === ".zip") {
      const baseName = path.basename(data.skillPath, fileExt);


      const installedDir = path.join(codiaHome, "skills", baseName);
      if (fs.existsSync(path.join(installedDir, "SKILL.md"))) {
        _showSkillViewer({ name: baseName, baseDir: installedDir, installed: false }, sourceWindow);
        return;
      }


      if (!fs.existsSync(data.skillPath)) {
        console.warn("[skill-viewer] .skill file not found:", data.skillPath);
        return;
      }
      try {
        const { execFileSync } = require("child_process");
        const tmpDir = path.join(app.getPath("temp"), "codia-skill-preview-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        if (process.platform === "win32") {
          execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -Path '${data.skillPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
          ], { stdio: "ignore", windowsHide: true });
        } else {
          execFileSync("unzip", ["-o", "-q", data.skillPath, "-d", tmpDir]);
        }

        let skillDir = null;
        if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
          skillDir = tmpDir;
        } else {
          const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith("."));
          const found = sub.find(e => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
          if (found) skillDir = path.join(tmpDir, found.name);
        }
        if (!skillDir) return;

        const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : baseName;

        _showSkillViewer({ name, baseDir: skillDir, installed: false }, sourceWindow);
      } catch (err) {
        console.error("[skill-viewer] Failed to extract .skill file:", err.message);
      }
      return;
    }
  }

  if (!data.baseDir || !path.isAbsolute(data.baseDir)) return;
  _showSkillViewer(data, sourceWindow);
});

wrapIpcHandler("skill-viewer-list-files", (_event, baseDir) => {
  if (!baseDir || !path.isAbsolute(baseDir)) return [];
  try {
    if (!fs.statSync(baseDir).isDirectory()) return [];
    return scanSkillDir(baseDir, baseDir);
  } catch {
    return [];
  }
});

wrapIpcHandler("skill-viewer-read-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
});


wrapIpcHandler("close-skill-viewer", () => {});


function fileActionFailure(code, message, extra = {}) {
  return { success: false, code, message, ...extra };
}

function validateNativePathInput(targetPath) {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return fileActionFailure("invalid_path", "文件路径为空");
  }
  if (!path.isAbsolute(targetPath)) {
    return fileActionFailure("invalid_path", "只能打开本机绝对路径");
  }
  return null;
}

wrapIpcHandler("open-folder", async (_event, folderPath) => {
  const invalid = validateNativePathInput(folderPath);
  if (invalid) return invalid;
  try {
    if (!fs.statSync(folderPath).isDirectory()) {
      return fileActionFailure("not_directory", "目标不是文件夹");
    }
  } catch {
    return fileActionFailure("not_found", "文件夹不存在");
  }
  const error = await shell.openPath(folderPath);
  return error
    ? fileActionFailure("system_open_failed", error)
    : { success: true, path: folderPath };
});

// Native drag: drag desk files to Finder or chat area.
wrapIpcOn("start-drag", async (event, filePaths) => {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  let icon;
  try {
    icon = await app.getFileIcon(paths[0], { size: "small" });
  } catch {

    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg=="
    );
  }
  if (paths.length === 1) {
    event.sender.startDrag({ file: paths[0], icon });
  } else {
    event.sender.startDrag({ files: paths, icon });
  }
});

wrapIpcHandler("show-in-finder", (_event, filePath) => {
  const invalid = validateNativePathInput(filePath);
  if (invalid) return invalid;
  try {
    fs.statSync(filePath);
  } catch {
    const parentPath = path.dirname(filePath);
    const parentExists = parentPath !== filePath && fs.existsSync(parentPath);
    return fileActionFailure(
      "not_found",
      parentExists ? "文件已不存在，可以打开它原来的文件夹" : "文件及其所在文件夹均不存在",
      parentExists ? { parentPath } : {},
    );
  }
  try {
    shell.showItemInFolder(filePath);
    return { success: true, path: filePath };
  } catch (err) {
    return fileActionFailure("system_reveal_failed", err?.message || String(err));
  }
});

wrapIpcHandler("trash-item", async (_event, filePath) => {
  const targetPath = resolveTrashItemPath(filePath);
  if (!targetPath) return false;
  try {
    fs.lstatSync(targetPath);
    await shell.trashItem(targetPath);
    return true;
  } catch (err) {
    console.warn("[trash-item] failed:", err?.message || err);
    return false;
  }
});

wrapIpcHandler("open-file", async (_event, filePath) => {
  const invalid = validateNativePathInput(filePath);
  if (invalid) return invalid;
  try {
    if (!fs.statSync(filePath).isFile()) {
      return fileActionFailure("not_file", "目标不是文件");
    }
  } catch {
    const parentPath = path.dirname(filePath);
    const parentExists = parentPath !== filePath && fs.existsSync(parentPath);
    return fileActionFailure("not_found", "文件不存在", parentExists ? { parentPath } : {});
  }
  const error = await shell.openPath(filePath);
  return error
    ? fileActionFailure("system_open_failed", error)
    : { success: true, path: filePath };
});

wrapIpcHandler("open-external", (_event, url) => {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      shell.openExternal(url);
    }
  } catch {}
});

// Read text file content for artifact preview.
wrapIpcHandler("read-file", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    return readTextFileSnapshot(filePath)?.content ?? null;
  } catch { return null; }
});

wrapIpcHandler("read-file-snapshot", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    return readTextFileSnapshot(filePath);
  } catch { return null; }
});


wrapIpcHandler("write-file", (_event, filePath, content) => {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return true;
  } catch { return false; }
});

wrapIpcHandler("write-file-if-unchanged", (_event, filePath, content, expectedVersion) => {
  if (!filePath || !path.isAbsolute(filePath)) return { ok: false };
  try {
    return writeTextFileIfUnchanged(filePath, content, expectedVersion || null);
  } catch {
    return { ok: false };
  }
});

// Write binary files, including screenshots; supports ~ paths.
wrapIpcHandler("write-file-binary", (_event, filePath, base64Data) => {
  if (!filePath) return false;
  const resolved = filePath.startsWith("~")
    ? path.join(os.homedir(), filePath.slice(1))
    : filePath;
  if (!path.isAbsolute(resolved)) return false;
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, Buffer.from(base64Data, "base64"));
    return true;
  } catch { return false; }
});

wrapIpcHandler("copy-file", (_event, sourcePath, destinationPath) => {
  if (!sourcePath || !destinationPath) return false;
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) return false;
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    return true;
  } catch {
    return false;
  }
});

wrapIpcHandler("save-file-as", async (event, filePath, defaultName) => {
  try {
    if (!filePath || !path.isAbsolute(filePath)) return { success: false, error: "Invalid file path" };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { success: false, error: "Not a file" };

    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
    const safeName = path.basename(defaultName || filePath);
    const ext = path.extname(safeName || filePath).replace(/^\./, "");
    const filters = ext
      ? [{ name: `${ext.toUpperCase()} File`, extensions: [ext] }, { name: "All Files", extensions: ["*"] }]
      : [{ name: "All Files", extensions: ["*"] }];
    const result = await dialog.showSaveDialog(owner, {
      title: "Save file",
      defaultPath: path.join(os.homedir(), "Desktop", safeName),
      filters,
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };

    const src = path.resolve(filePath);
    const dest = path.resolve(result.filePath);
    if (src !== dest) fs.copyFileSync(src, dest);
    return { success: true, path: dest };
  } catch (err) {
    console.error("[save-file-as]", err);
    return { success: false, error: err.message || String(err) };
  }
});

wrapIpcHandler("screenshot-render", (_event, payload) => {
  return withScreenshotLock(async () => {
    try {
      const themeConf = SCREENSHOT_THEMES[payload.theme];
      if (!themeConf) return { success: false, error: `Unknown theme: ${payload.theme}` };

      const htmlContent = buildScreenshotHTML(payload);
      const pngBuffer = await screenshotCapture(htmlContent, themeConf.width);


      if (payload.preview) {
        return { success: true, base64: pngBuffer.toString("base64") };
      }

      const owner = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const segmentTotal = Number(payload.segmentTotal);
      const segmentIndex = Number(payload.segmentIndex);
      const segmentSuffix = Number.isInteger(segmentTotal) && segmentTotal > 1 && Number.isInteger(segmentIndex) && segmentIndex > 0
        ? `-${String(segmentIndex).padStart(2, "0")}-of-${String(segmentTotal).padStart(2, "0")}`
        : "";
      let filePath = payload.savePath || "";
      let dir = null;

      if (payload.savePath || payload.askPath) {
        if (!filePath) {
          const defaultDir = payload.saveDir || path.join(os.homedir(), "Desktop");
          const result = await dialog.showSaveDialog(owner, {
            defaultPath: path.join(defaultDir, `${runtimeProductName()}-${timestamp}${segmentSuffix}.png`),
            filters: [{ name: "PNG Image", extensions: ["png"] }],
          });
          if (result.canceled || !result.filePath) return { success: false, canceled: true };
          filePath = result.filePath;
        }
      } else {
        const base = payload.saveDir || path.join(os.homedir(), "Desktop");
        dir = resolveWorkspaceOutputDir(base, "screenshots", payload.locale || "zh");
        filePath = path.join(dir, `${runtimeProductName()}-${timestamp}${segmentSuffix}.png`);
        fs.mkdirSync(dir, { recursive: true });
      }

      const watermarkedPngBuffer = writePngWatermark(pngBuffer, buildWatermarkPayload({
        source: "desktop_screenshot",
        origin: "desktop_screenshot",
        storageKind: "desktop_output",
        filePath,
      })) || pngBuffer;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, watermarkedPngBuffer);

      return { success: true, filePath, dir: dir || path.dirname(filePath) };
    } catch (err) {
      console.error("[screenshot-render]", err);
      return { success: false, error: err.message || String(err) };
    }
  });
});

wrapIpcHandler("save-screenshot-preview", async (event, payload = {}) => {
  try {
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow || undefined;
    const theme = String(payload.theme || "light-mobile");
    const result = await dialog.showSaveDialog(owner, {
      title: "保存截图样式预览",
      defaultPath: path.join(os.homedir(), "Desktop", `${runtimeProductName()}-${theme}-preview.png`),
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return { success: false, canceled: true };

    const previewPath = path.join(__dirname, "src", "assets", "screenshot-previews", `${theme}.png`);
    if (!fs.existsSync(previewPath)) {
      return { success: false, error: `Preview not found: ${theme}` };
    }
    fs.copyFileSync(previewPath, result.filePath);
    watermarkGeneratedFileSync({
      filePath: result.filePath,
      source: "screenshot_preview",
      origin: "screenshot_preview",
      storageKind: "desktop_output",
    });
    return { success: true, path: result.filePath };
  } catch (err) {
    console.error("[save-screenshot-preview]", err);
    return { success: false, error: err.message };
  }
});

// File watching for artifact editing and viewer live refresh.
const _watchedRendererIds = new Set();
const _fileWatchRegistry = createFileWatchRegistry({
  watch: (filePath, options, onChange) => createStableFileWatcher(filePath, options, onChange),
  notifySubscriber: (subscriberId, filePath) => {
    const wc = webContents.fromId(subscriberId);
    if (!wc || wc.isDestroyed()) {
      _watchedRendererIds.delete(subscriberId);
      _fileWatchRegistry.unwatchAllForSubscriber(subscriberId);
      return;
    }
    wc.send("file-changed", filePath);
  },
});

wrapIpcHandler("watch-file", (event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return false;
  const subscriberId = event.sender.id;
  if (!_watchedRendererIds.has(subscriberId)) {
    _watchedRendererIds.add(subscriberId);
    event.sender.once("destroyed", () => {
      _watchedRendererIds.delete(subscriberId);
      _fileWatchRegistry.unwatchAllForSubscriber(subscriberId);
    });
  }
  return _fileWatchRegistry.watchFile(filePath, subscriberId);
});

wrapIpcHandler("unwatch-file", (event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return true;
  return _fileWatchRegistry.unwatchFile(filePath, event.sender.id);
});

// Recursive workspace watching for right-side file tree refreshes.
const _workspaceWatchedRendererIds = new Set();
const _workspaceWatchRegistry = createWorkspaceWatchRegistry({
  watch: (rootPath, options) => chokidar.watch(rootPath, options),
  notifySubscriber: (subscriberId, payload) => {
    const wc = webContents.fromId(subscriberId);
    if (!wc || wc.isDestroyed()) {
      _workspaceWatchedRendererIds.delete(subscriberId);
      _workspaceWatchRegistry.unwatchAllForSubscriber(subscriberId);
      return;
    }
    wc.send("workspace-changed", payload);
  },
  onError: (err, rootPath) => {
    console.warn("[workspace-watch] watcher error:", rootPath, err?.message || err);
  },
});

wrapIpcHandler("watch-workspace", (event, rootPath) => {
  if (!rootPath || !path.isAbsolute(rootPath)) return false;
  const subscriberId = event.sender.id;
  if (!_workspaceWatchedRendererIds.has(subscriberId)) {
    _workspaceWatchedRendererIds.add(subscriberId);
    event.sender.once("destroyed", () => {
      _workspaceWatchedRendererIds.delete(subscriberId);
      _workspaceWatchRegistry.unwatchAllForSubscriber(subscriberId);
    });
  }
  return _workspaceWatchRegistry.watchWorkspace(rootPath, subscriberId);
});

wrapIpcHandler("unwatch-workspace", (event, rootPath) => {
  if (!rootPath || !path.isAbsolute(rootPath)) return true;
  return _workspaceWatchRegistry.unwatchWorkspace(rootPath, event.sender.id);
});


wrapIpcHandler("read-file-base64", (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const maxBytes = isImageAttachmentPath(filePath) ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_GENERIC_BASE64_FILE_BYTES;
    if (stat.size > maxBytes) return null;
    return fs.readFileSync(filePath).toString("base64");
  } catch { return null; }
});

// Read docx and convert to HTML via mammoth.
wrapIpcHandler("read-docx-html", async (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const mammoth = require("mammoth");
    const result = await mammoth.convertToHtml({ path: filePath });
    return result.value; // HTML string
  } catch { return null; }
});


wrapIpcHandler("read-xlsx-html", async (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const { xlsxToHtml } = await import("../shared/xlsx-utils.ts");
    return await xlsxToHtml(filePath);
  } catch { return null; }
});

wrapIpcHandler("read-design-document-preview", async (_event, filePath) => {
  if (!filePath || !path.isAbsolute(filePath)) return null;
  try {
    const { parseDesignDocumentPreview } = await import("../shared/design-document-preview.ts");
    return await parseDesignDocumentPreview(filePath);
  } catch {
    return null;
  }
});


wrapIpcHandler("reload-main-window", () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
});

// System notification, triggered by the agent notify tool.
wrapIpcHandler("show-notification", (_event, title, body, agentId, rawOptions) => {
  const notificationOptions = normalizeDesktopNotificationOptions(rawOptions);
  if (shouldSuppressDesktopNotification(notificationOptions, {
    getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
    getWindowSessionPath: focusedWindowSessionPath,
  })) {
    return { shown: false, reason: "codia_focused" };
  }
  if (!Notification.isSupported()) return { shown: false, reason: "unsupported" };
  const options = {
    title: title || runtimeProductName(),
    body: body || "",
    silent: false,
  };
  const avatarPath = resolveAgentAvatarPath(codiaHome, agentId);
  if (avatarPath) {
    const icon = nativeImage.createFromPath(avatarPath);
    if (icon && !icon.isEmpty()) options.icon = icon;
  }
  const notif = new Notification(options);
  notif.on("click", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notif.show();
  return { shown: true };
});


wrapIpcHandler("debug-open-onboarding", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow();
});

// Debug: open onboarding preview without API calls or config writes.
wrapIpcHandler("debug-open-onboarding-preview", () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.focus();
    return;
  }
  createOnboardingWindow({ preview: "1" });
});

// After onboarding completes, let the server persist setup state before opening main UI.
wrapIpcHandler("onboarding-complete", async () => {
  await completeOnboardingAndOpenMain({
    serverPort,
    serverToken,
    createMainWindow,
  });
});


wrapIpcHandler("get-platform", () => process.platform);
wrapIpcHandler("window-minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
wrapIpcHandler("window-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win?.isMaximized()) win.restore(); else win?.maximize();
});
wrapIpcHandler("window-close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});
wrapIpcHandler("window-is-maximized", (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
});

wrapIpcHandler("open-browser-viewer", async (_event, theme, rawUrl) => {
  _browserViewerTheme = resolveConcreteTheme(theme || _browserViewerTheme);
  const workspace = _ensureBrowserWorkspace(_currentBrowserSession);
  if (workspace.tabs.size === 0) {
    const tab = _createBrowserTabRecord(workspace.sessionPath);
    workspace.tabs.set(tab.tabId, tab);
    workspace.activeTabId = tab.tabId;
    _switchActiveBrowserTab(workspace.sessionPath, tab.tabId);
  } else if (!_browserWebView) {
    _switchActiveBrowserTab(workspace.sessionPath, workspace.activeTabId || workspace.tabs.keys().next().value);
  }

  const url = normalizeManualBrowserUrl(rawUrl);
  if (rawUrl && !url) throw new Error("Only http/https URLs are allowed");
  if (url) {
    await handleBrowserCommand("navigate", {
      sessionPath: workspace.sessionPath,
      tabId: workspace.activeTabId,
      url,
    });
  }
  createBrowserViewerWindow({ show: true });
  return _serializeBrowserWorkspace(workspace);
});
wrapIpcHandler("close-browser-viewer", () => {
  if (browserViewerWindow && !browserViewerWindow.isDestroyed()) browserViewerWindow.hide();
  return true;
});
wrapIpcHandler("browser-go-back", () => {
  if (!_browserWebView) return false;
  const wc = _ensureLiveWebContents(_browserWebView, _currentBrowserSession);
  if (!wc.canGoBack()) return false;
  wc.goBack();
  return true;
});
wrapIpcHandler("browser-go-forward", () => {
  if (!_browserWebView) return false;
  const wc = _ensureLiveWebContents(_browserWebView, _currentBrowserSession);
  if (!wc.canGoForward()) return false;
  wc.goForward();
  return true;
});
wrapIpcHandler("browser-reload", () => {
  if (!_browserWebView) return false;
  _ensureLiveWebContents(_browserWebView, _currentBrowserSession).reload();
  return true;
});
wrapIpcHandler("browser-navigate-url", async (_event, rawUrl) => {
  const url = normalizeManualBrowserUrl(rawUrl);
  if (!url) throw new Error("Only http/https URLs are allowed");
  return handleBrowserCommand("navigate", {
    sessionPath: _currentBrowserSession,
    tabId: _currentBrowserTabId,
    url,
  });
});
wrapIpcHandler("browser-new-tab", () => handleBrowserCommand("newTab", {
  sessionPath: _currentBrowserSession,
}));
wrapIpcHandler("browser-switch-tab", (_event, tabId) => handleBrowserCommand("switchTab", {
  sessionPath: _currentBrowserSession,
  tabId,
}));
wrapIpcHandler("browser-close-tab", (_event, tabId) => handleBrowserCommand("closeTab", {
  sessionPath: _currentBrowserSession,
  tabId,
}));
wrapIpcHandler("browser-emergency-stop", () => {
  if (!_browserWebView) return false;
  const view = _browserWebView;
  try { view.webContents.stop(); } catch {}
  _detachActiveBrowserView({ view, hideIfVisible: true, reason: "emergency-stop" });
  return true;
});


wrapIpcHandler("app-ready", () => {
  try {
    markGpuStartupReady({
      codiaHome,
      platform: process.platform,
      startupId: desktopStartupId,
      phase: "app-ready",
    });
  } catch {}
  focusExistingWindow(mainWindow);

  // Request notification permission on first launch for macOS.
  if (process.platform === "darwin" && Notification.isSupported()) {
    const settings = systemPreferences.getNotificationSettings?.();
    const status = settings?.authorizationStatus;
    if (settings && status === "not-determined") {
      const notif = new Notification({ title: runtimeProductName(), body: mt("notification.ready", null, "Notifications enabled"), silent: true });
      notif.show();
    }
  }


  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }
    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close();
    }
  }, 200);
});


app.whenReady().then(async () => {
  await resolveLoginShellPath();
  await applyDesktopNetworkProxy(readNetworkProxyPreference(), { reason: "startup" });
  createTray();
  keepAwakeManager.setEnabled(readKeepAwakePreference());
  registerQuickChatShortcutBestEffort();
  createSplashWindow();
  try {
    markGpuStartupPhase({
      codiaHome,
      platform: process.platform,
      startupId: desktopStartupId,
      phase: "splash-ready",
    });
  } catch {}

  try {
    console.log("[desktop] starting Codia Server...");
    try {
      markGpuStartupPhase({
        codiaHome,
        platform: process.platform,
        startupId: desktopStartupId,
        phase: "server-starting",
      });
    } catch {}
    await startServer();
    console.log(`[desktop] Server ready on port ${serverPort}`);
    monitorServer();
    setupBrowserCommands();

    const migratedSetupComplete = await migrateSetupCompleteViaServerIfNeeded();
    if (isSetupComplete() || migratedSetupComplete) {
      if (process.platform === "win32") {
        try {
          markGpuStartupPhase({
            codiaHome,
            platform: process.platform,
            startupId: desktopStartupId,
            phase: "main-window-starting",
          });
        } catch {}
      }
      createMainWindow();
    } else if (hasExistingConfig()) {
      console.log("[desktop] existing agent config detected, skipping provider form");
      if (process.platform === "win32") {
        try {
          markGpuStartupPhase({
            codiaHome,
            platform: process.platform,
            startupId: desktopStartupId,
            phase: "onboarding-window-starting",
          });
        } catch {}
      }
      createOnboardingWindow({ skipToTutorial: "1" });
    } else {
      console.log("[desktop] no completed setup marker found, showing onboarding");
      if (process.platform === "win32") {
        try {
          markGpuStartupPhase({
            codiaHome,
            platform: process.platform,
            startupId: desktopStartupId,
            phase: "onboarding-window-starting",
          });
        } catch {}
      }
      createOnboardingWindow();
    }

    try {
      markGpuStartupPhase({
        codiaHome,
        platform: process.platform,
        startupId: desktopStartupId,
        phase: "server-ready",
      });
    } catch {}
    try {
      const prefsPath = path.join(codiaHome, "user", "preferences.json");
      if (fs.existsSync(prefsPath)) {
        const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
        if (prefs.update_channel) setUpdateChannel(prefs.update_channel);
      }
    } catch {}
    checkForUpdates().catch(() => {});
  } catch (err) {
    try {
      markGpuStartupFailed({
        codiaHome,
        platform: process.platform,
        startupId: desktopStartupId,
        reason: "launch-failed",
      });
    } catch {}
    console.error("[desktop] launch failed:", err.message);
    const crashInfo = writeCrashLog(err.message);
    const detail = buildLaunchFailureDialogDetail(err, crashInfo);
    dialog.showErrorBox(
      mt("dialog.launchFailedTitle", null, `${runtimeProductName()} Launch Failed`),
      mt("dialog.launchFailedBody", {
        version: app?.getVersion?.() || "unknown",
        detail,
        logPath: path.join(codiaHome, "crash.log"),
      })
    );
    forceQuitApp = true;
    app.quit();
  }
});

app.on("window-all-closed", () => {


  if (_isE2E) {
    console.warn(`[desktop:e2e] window-all-closed tray=${!!tray && !tray.isDestroyed()} forceQuit=${forceQuitApp} isQuitting=${isQuitting}`);
  }
  if (!tray || tray.isDestroyed()) {
    forceQuitApp = true;
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverPort) {
    createMainWindow();

  } else if (mainWindow) {
    showPrimaryWindow();
  }
});

app.on("child-process-gone", (_event, details) => {
  try {
    recordGpuChildProcessGone({
      codiaHome,
      platform: process.platform,
      details,
    });
  } catch (err) {
    console.warn("[desktop] failed to record GPU process status:", err.message);
  }
});

app.on("gpu-info-update", () => {
  try {
    const featureStatus = typeof app.getGPUFeatureStatus === "function"
      ? app.getGPUFeatureStatus()
      : null;
    recordGpuInfoUpdate({
      codiaHome,
      platform: process.platform,
      featureStatus,
    });
  } catch (err) {
    console.warn("[desktop] failed to record GPU feature status:", err.message);
  }
});


app.on("will-quit", () => {
  keepAwakeManager.dispose();
  globalShortcut.unregisterAll();

  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
});

async function shutdownServer() {
  teardownBrowserCommands();
  let removeServerInfo = true;

  if (serverProcess && !hasChildExitObserved(serverProcess)) {
    console.log("[desktop] shutdownServer: stopping owned server...");
    const proc = serverProcess;
    const pid = proc.pid;
    if (process.platform === "win32") {
      try {
        await fetch(`http://127.0.0.1:${serverPort}/api/shutdown`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serverToken}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch {}
    } else {
      try { proc.kill("SIGTERM"); } catch {}
    }

    let exited = await waitForProcessExit(proc, pid, SERVER_SHUTDOWN_GRACE_MS);
    if (!exited && pid) {
      console.warn(`[desktop] shutdownServer: server PID ${pid} did not exit within ${SERVER_SHUTDOWN_GRACE_MS}ms; force killing`);
      killPid(pid, true);
      exited = await waitForProcessExit(proc, pid, SERVER_FORCE_KILL_WAIT_MS);
    }
    if (!exited && pid) {
      console.warn(`[desktop] shutdownServer: server PID ${pid} is still visible after force kill`);
      removeServerInfo = false;
    }
    serverProcess = null;
  } else if (reusedServerPid) {
    if (!reusedServerOwned) {
      console.log("[desktop] shutdownServer: detached from external server");
      reusedServerPid = null;
      removeServerInfo = false;
    } else {
    console.log("[desktop] shutdownServer: stopping reused server...");
    const pid = reusedServerPid;
    try {
      await fetch(`http://127.0.0.1:${serverPort}/api/shutdown`, {
        method: "POST",
        headers: { Authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      killPid(pid);
    }

    let exited = await waitForProcessExit(null, pid, SERVER_SHUTDOWN_GRACE_MS);
    if (!exited) {
      killPid(pid, true);
      exited = await waitForProcessExit(null, pid, SERVER_FORCE_KILL_WAIT_MS);
    }
    if (!exited) {
      console.warn(`[desktop] shutdownServer: reused server PID ${pid} is still visible after force kill`);
      removeServerInfo = false;
    }
    if (reusedServerPid === pid) reusedServerPid = null;
    reusedServerOwned = false;
    }
  }

  if (removeServerInfo) {
    try { fs.unlinkSync(desktopServerInfoPath); } catch {}
  }
}

app.on("before-quit", async (event) => {
  writeDesktopLaunchDiagnostic("before-quit", {
    forceQuitApp, isQuitting, updating: _isUpdating,
    stack: new Error("Desktop quit requested").stack,
  });
  if (_isE2E) {
    const windows = BrowserWindow.getAllWindows().map((win) => ({
      title: win.getTitle?.() || "",
      destroyed: win.isDestroyed?.() === true,
      visible: win.isVisible?.() === true,
    }));
    console.warn(`[desktop:e2e] before-quit forceQuit=${forceQuitApp} isQuitting=${isQuitting} windows=${JSON.stringify(windows)}`);
  }
  isQuitting = true;

  // Let quitAndInstall proceed without waiting for server cleanup here.
  if (_isUpdating) return;

  isExitingServer = true;


  // Hide all windows immediately.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.hide();
  }


  // Close embedded browser views.
  for (const workspace of _browserViews.values()) {
    for (const tab of workspace.tabs?.values?.() || []) {
      try { tab.view.webContents.close(); } catch {}
    }
  }
  _browserViews.clear();
  _browserWebView = null;
  _currentBrowserSession = null;
  _currentBrowserTabId = null;


  if ((serverProcess && !hasChildExitObserved(serverProcess)) || (reusedServerPid && reusedServerOwned)) {
    event.preventDefault();
    await shutdownServer();
    app.quit();
  }
});


process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_IPC_CHANNEL_CLOSED') return;
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[ErrorBus][${err.code || 'UNKNOWN'}][${traceId}] uncaughtException: ${err.message}`);
  console.error(`[ErrorBus][${traceId}] ${err.stack || err.message}`);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const traceId = Math.random().toString(16).slice(2, 10);
  console.error(`[ErrorBus][${err.code || 'UNKNOWN'}][${traceId}] unhandledRejection: ${err.message}`);
  console.error(`[ErrorBus][${traceId}] ${err.stack || err.message}`);
});
