const { contextBridge, ipcRenderer, webUtils } = require("electron");
const { pathToFileUrl } = require("./src/shared/path-to-file-url.cjs");
const themeRegistry = require("./src/shared/theme-registry.cjs");

function resolveTheme() {
  try {
    const saved = localStorage.getItem(themeRegistry.STORAGE_KEY);
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return themeRegistry.resolveSavedTheme(saved, isDark).concrete;
  } catch {
    return themeRegistry.DEFAULT_THEME;
  }
}

function on(channel, callback) {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

function normalizeLocalServerPort(port) {
  const value = String(port ?? "").trim();
  return /^\d+$/.test(value) ? value : "";
}

async function resolveOcrAssetRoot() {
  const port = normalizeLocalServerPort(await ipcRenderer.invoke("get-server-port"));
  if (!port) throw new Error("OCR assets require the local server to be ready.");
  return `http://127.0.0.1:${port}/ocr-runtime/`;
}

const api = {
  getServerPort: () => ipcRenderer.invoke("get-server-port"),
  getServerToken: () => ipcRenderer.invoke("get-server-token"),
  runConsoleCommand: (payload) => ipcRenderer.invoke("console-run-command", payload),
  runEditCommand: (command) => ipcRenderer.invoke("run-edit-command", command),
  restartServer: () => ipcRenderer.invoke("restart-server"),
  isE2EMode: () => ipcRenderer.invoke("is-e2e-mode"),
  readClipboardText: () => ipcRenderer.invoke("read-clipboard-text"),
  writeClipboardText: (text) => ipcRenderer.invoke("write-clipboard-text", text),
  getRuntimeDiagnosticsState: () => ipcRenderer.invoke("get-runtime-diagnostics-state"),

  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getGpuRuntimeState: () => ipcRenderer.invoke("get-gpu-runtime-state"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  getAutoLaunchStatus: () => ipcRenderer.invoke("get-auto-launch-status"),
  setAutoLaunchEnabled: (enabled) => ipcRenderer.invoke("set-auto-launch-enabled", enabled),
  getKeepAwakeStatus: () => ipcRenderer.invoke("get-keep-awake-status"),
  setKeepAwakeEnabled: (enabled) => ipcRenderer.invoke("set-keep-awake-enabled", enabled),
  quickChatReloadShortcut: () => ipcRenderer.invoke("quick-chat-reload-shortcut"),
  quickChatShortcutStatus: () => ipcRenderer.invoke("quick-chat-shortcut-status"),
  quickChatShow: () => ipcRenderer.invoke("quick-chat-show"),
  quickChatHide: () => ipcRenderer.invoke("quick-chat-hide"),
  quickChatResize: (request) => ipcRenderer.invoke("quick-chat-resize", request),
  quickChatOpenSession: (sessionPath) => ipcRenderer.invoke("quick-chat-open-session", sessionPath),
  onQuickChatOpenSession: (callback) => on("quick-chat-open-session", callback),
  onQuickChatShown: (callback) => on("quick-chat-shown", callback),
  autoUpdateCheck: () => ipcRenderer.invoke("auto-update-check"),
  autoUpdateDownload: () => ipcRenderer.invoke("auto-update-download"),
  autoUpdateInstall: () => ipcRenderer.invoke("auto-update-install"),
  autoUpdateState: () => ipcRenderer.invoke("auto-update-state"),
  autoUpdateSetChannel: (channel) => ipcRenderer.invoke("auto-update-set-channel", channel),
  onAutoUpdateState: (callback) => on("auto-update-state", callback),

  appReady: () => ipcRenderer.invoke("app-ready"),
  syncWindowTheme: (theme) => ipcRenderer.send("window-theme-changed", theme),

  openSettings: (tab) => ipcRenderer.invoke("open-settings", tab, resolveTheme()),
  settingsChanged: (type, data) => ipcRenderer.send("settings-changed", type, data),
  notifyMainWindow: (type, data) => ipcRenderer.send("settings-changed", type, data),
  onSettingsChanged: (callback) => on("settings-changed", callback),
  onOpenSettingsModal: (callback) => on("open-settings-modal", callback),
  onSwitchTab: (callback) => on("settings-switch-tab", callback),
  onServerRestarted: (callback) => on("server-restarted", callback),

  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectFiles: () => ipcRenderer.invoke("select-files"),
  selectSkill: () => ipcRenderer.invoke("select-skill"),
  selectPlugin: () => ipcRenderer.invoke("select-plugin"),
  openFolder: (filePath) => ipcRenderer.invoke("open-folder", filePath),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  showInFinder: (filePath) => ipcRenderer.invoke("show-in-finder", filePath),
  trashItem: (filePath) => ipcRenderer.invoke("trash-item", filePath),
  startDrag: (filePaths) => ipcRenderer.send("start-drag", filePaths),

  readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),
  readFileSnapshot: (filePath) => ipcRenderer.invoke("read-file-snapshot", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("write-file", filePath, content),
  writeFileIfUnchanged: (filePath, content, expectedVersion) =>
    ipcRenderer.invoke("write-file-if-unchanged", filePath, content, expectedVersion),
  writeFileBinary: (filePath, base64Data) => ipcRenderer.invoke("write-file-binary", filePath, base64Data),
  copyFile: (sourcePath, destinationPath) => ipcRenderer.invoke("copy-file", sourcePath, destinationPath),
  saveFileAs: (filePath, defaultName) => ipcRenderer.invoke("save-file-as", filePath, defaultName),
  screenshotRender: (payload) => ipcRenderer.invoke("screenshot-render", payload),
  saveScreenshotPreview: (payload) => ipcRenderer.invoke("save-screenshot-preview", payload),
  watchFile: (filePath) => ipcRenderer.invoke("watch-file", filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke("unwatch-file", filePath),
  onFileChanged: (callback) => on("file-changed", callback),
  watchWorkspace: (rootPath) => ipcRenderer.invoke("watch-workspace", rootPath),
  unwatchWorkspace: (rootPath) => ipcRenderer.invoke("unwatch-workspace", rootPath),
  onWorkspaceChanged: (callback) => on("workspace-changed", callback),
  readFileBase64: (filePath) => ipcRenderer.invoke("read-file-base64", filePath),
  getFileUrl: (filePath) => pathToFileUrl(filePath),
  getOcrAssetRoot: () => resolveOcrAssetRoot(),
  readDocxHtml: (filePath) => ipcRenderer.invoke("read-docx-html", filePath),
  readXlsxHtml: (filePath) => ipcRenderer.invoke("read-xlsx-html", filePath),
  readDesignDocumentPreview: (filePath) => ipcRenderer.invoke("read-design-document-preview", filePath),
  getFilePath: (file) => webUtils.getPathForFile(file),

  openEditorWindow: (data) => ipcRenderer.invoke("open-editor-window", data),
  onEditorLoad: (callback) => on("editor-load", callback),
  editorDock: () => ipcRenderer.invoke("editor-dock"),
  editorClose: () => ipcRenderer.invoke("editor-close"),
  onEditorDockFile: (callback) => on("editor-dock-file", callback),
  onEditorDetached: (callback) => on("editor-detached", callback),

  spawnViewer: (data) => ipcRenderer.invoke("spawn-viewer", data),
  onViewerLoad: (callback) => on("viewer-load", callback),
  viewerClose: () => ipcRenderer.invoke("viewer-close"),
  onViewerClosed: (callback) => on("viewer-closed", callback),

  openBrowserViewer: (url, theme) => ipcRenderer.invoke("open-browser-viewer", theme || resolveTheme(), url),
  closeBrowserViewer: () => ipcRenderer.invoke("close-browser-viewer"),
  closeBrowser: () => ipcRenderer.invoke("close-browser-viewer"),
  onBrowserUpdate: (callback) => on("browser-update", callback),
  browserGoBack: () => ipcRenderer.invoke("browser-go-back"),
  browserGoForward: () => ipcRenderer.invoke("browser-go-forward"),
  browserReload: () => ipcRenderer.invoke("browser-reload"),
  browserNavigateTo: (url) => ipcRenderer.invoke("browser-navigate-url", url),
  browserNewTab: () => ipcRenderer.invoke("browser-new-tab"),
  browserSwitchTab: (tabId) => ipcRenderer.invoke("browser-switch-tab", tabId),
  browserCloseTab: (tabId) => ipcRenderer.invoke("browser-close-tab", tabId),
  browserEmergencyStop: () => ipcRenderer.invoke("browser-emergency-stop"),
  updateBrowserViewer: () => {},

  openSkillViewer: (data) => ipcRenderer.invoke("open-skill-viewer", data),
  listSkillFiles: (baseDir) => ipcRenderer.invoke("skill-viewer-list-files", baseDir),
  readSkillFile: (filePath) => ipcRenderer.invoke("skill-viewer-read-file", filePath),
  onSkillViewerLoad: (callback) => on("skill-viewer-load", callback),
  closeSkillViewer: () => ipcRenderer.invoke("close-skill-viewer"),
  onShowSkillViewer: (callback) => on("show-skill-viewer", callback),

  getAvatarPath: (role) => ipcRenderer.invoke("get-avatar-path", role),
  getSplashInfo: () => ipcRenderer.invoke("get-splash-info"),
  reloadMainWindow: () => ipcRenderer.invoke("reload-main-window"),
  onboardingComplete: (options) => ipcRenderer.invoke("onboarding-complete", options),
  debugOpenOnboarding: () => ipcRenderer.invoke("debug-open-onboarding"),
  debugOpenOnboardingPreview: () => ipcRenderer.invoke("debug-open-onboarding-preview"),
  showNotification: (title, body, agentId, options) => ipcRenderer.invoke("show-notification", title, body, agentId ?? null, options || null),

  getPlatform: () => ipcRenderer.invoke("get-platform"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowMaximize: () => ipcRenderer.invoke("window-maximize"),
  windowClose: () => ipcRenderer.invoke("window-close"),
  windowIsMaximized: () => ipcRenderer.invoke("window-is-maximized"),
  onMaximizeChange: (callback) => {
    const onMaximized = () => callback(true);
    const onUnmaximized = () => callback(false);
    ipcRenderer.on("window-maximized", onMaximized);
    ipcRenderer.on("window-unmaximized", onUnmaximized);
    return () => {
      ipcRenderer.removeListener("window-maximized", onMaximized);
      ipcRenderer.removeListener("window-unmaximized", onUnmaximized);
    };
  },
};

contextBridge.exposeInMainWorld("gsap", api);
contextBridge.exposeInMainWorld("platform", api);
contextBridge.exposeInMainWorld("hana", api);
