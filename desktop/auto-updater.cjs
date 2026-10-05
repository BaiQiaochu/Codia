/**
 * auto-updater.cjs
 *
 * Flow:
 * - background check
 * - silent download
 * - renderer shows state
 * - user installs from the About tab
 */
const { ipcMain, app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");

const CHECK_INTERVAL = 4 * 60 * 60 * 1000;
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

let _mainWindow = null;
let _setIsUpdating = null;
let _appHome = null;
let _checkTimer = null;
let _ipcHandlersRegistered = false;
let _updaterConfigured = false;
let _feedConfigured = false;
let _installPromise = null;
let _autoUpdater = null;
let _autoUpdaterLoadAttempted = false;
let _autoUpdaterDisabledError = null;
let _autoUpdaterDisabledLog = null;

function isAutoCheckEnabled() {
  try {
    const prefsPath = path.join(_appHome || "", "user", "preferences.json");
    const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
    return prefs.auto_check_updates !== false;
  } catch {
    return true;
  }
}

let _updateState = {
  status: "idle",
  version: null,
  releaseNotes: null,
  releaseUrl: null,
  downloadUrl: null,
  progress: null,
  error: null,
};

function getUpdateFeedUrl() {
  return String(process.env.GSAP_UPDATE_FEED_URL || "").trim();
}

function isUpdateFeedConfigured() {
  return !!getUpdateFeedUrl();
}

function getAppVersion() {
  try {
    return String(app.getVersion?.() || "").trim();
  } catch {
    return "";
  }
}

function isStrictSemverVersion(version) {
  return STRICT_SEMVER_RE.test(String(version || ""));
}

function setAutoUpdaterDisabledReason(error, message) {
  _feedConfigured = false;
  _autoUpdaterDisabledError = error;
  _autoUpdaterDisabledLog = message;
}

function markUpdaterDisabled() {
  const error = _autoUpdaterDisabledError || "update_feed_not_configured";
  const message = _autoUpdaterDisabledLog || "update feed not configured; auto-updater disabled";
  logUpdate(message);
  setState({
    status: "disabled",
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error,
  });
}

function setUpdaterDisabledSilently() {
  const error = _autoUpdaterDisabledError || "update_feed_not_configured";
  const message = _autoUpdaterDisabledLog || "update feed not configured; auto-updater disabled";
  logUpdate(message);
  Object.assign(_updateState, {
    status: "disabled",
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error,
  });
}

function getAutoUpdater() {
  if (_autoUpdater) return _autoUpdater;
  if (_autoUpdaterLoadAttempted) return null;
  _autoUpdaterLoadAttempted = true;

  const version = getAppVersion();
  if (!isStrictSemverVersion(version)) {
    setAutoUpdaterDisabledReason(
      "invalid_app_version_for_auto_update",
      `app version is not strict semver; auto-updater disabled: ${version || "unknown"}`,
    );
    return null;
  }

  try {
    _autoUpdater = require("electron-updater").autoUpdater;
    return _autoUpdater;
  } catch (err) {
    setAutoUpdaterDisabledReason(
      "auto_updater_unavailable",
      `auto-updater unavailable: ${err?.message || String(err)}`,
    );
    return null;
  }
}

function getState() {
  return { ..._updateState };
}

function logUpdate(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    console.log(`[auto-updater] ${message}`);
  } catch {}
  if (!_appHome) return;
  try {
    const logDir = path.join(_appHome, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, "auto-update.log"), line + "\n", "utf-8");
  } catch {}
}

function isMissingLatestMetadataError(err) {
  const message = err?.message || String(err || "");
  return (
    /\blatest(?:-mac)?\.ya?ml\b/i.test(message)
    && /(cannot find|not found|missing|404)/i.test(message)
  );
}

function getRendererWindows() {
  const windows = [];
  try {
    if (BrowserWindow?.getAllWindows) windows.push(...BrowserWindow.getAllWindows());
  } catch {}
  if (windows.length === 0 && _mainWindow) windows.push(_mainWindow);
  return [...new Set(windows)].filter((win) => {
    try {
      return win && !win.isDestroyed?.();
    } catch {
      return false;
    }
  });
}

function sendToRenderer(channel, data) {
  for (const win of getRendererWindows()) {
    try {
      win.webContents?.send?.(channel, data);
    } catch {}
  }
}

function setState(patch) {
  Object.assign(_updateState, patch);
  sendToRenderer("auto-update-state", getState());
}

function resetState() {
  _updateState = {
    status: "idle",
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
  };
}

async function installDownloadedUpdate(source = "manual") {
  if (_updateState.status === "installing") return true;
  if (_updateState.status !== "downloaded") {
    logUpdate(`install ignored: status=${_updateState.status}, source=${source}`);
    return false;
  }
  if (_installPromise) return _installPromise;

  _installPromise = (async () => {
    const version = _updateState.version;
    logUpdate(`install requested: source=${source}, version=${version || "unknown"}`);
    if (_setIsUpdating) _setIsUpdating(true);
    setState({ status: "installing", version, progress: null, error: null });

    try {
      const updater = getAutoUpdater();
      if (!updater) {
        markUpdaterDisabled();
        return false;
      }
      // Keep install immediate. The NSIS installer owns process cleanup,
      // including the bundled server, before overlaying files.
      updater.quitAndInstall(true, true);
      return true;
    } catch (err) {
      const message = err?.message || String(err);
      logUpdate(`install failed before quitAndInstall: ${message}`);
      if (_setIsUpdating) _setIsUpdating(false);
      setState({ status: "error", error: message });
      return false;
    } finally {
      _installPromise = null;
    }
  })();

  return _installPromise;
}

async function hasSufficientDiskSpace(checkPath, minMB) {
  try {
    const stats = await fs.promises.statfs(checkPath);
    const availableBytes = stats.bavail * stats.bsize;
    return availableBytes >= minMB * 1024 * 1024;
  } catch {
    return true;
  }
}

function isRunningFromDmg() {
  if (process.platform !== "darwin") return false;
  return app.getPath("exe").startsWith("/Volumes/");
}

async function cleanUpdateCache() {
  const dataDir = _appHome;
  const versionFile = path.join(dataDir, "last-update-version");

  const currentVersion = app.getVersion();
  let shouldClean = false;

  try {
    const lastVersion = fs.readFileSync(versionFile, "utf-8").trim();
    if (lastVersion !== currentVersion) shouldClean = true;
  } catch {}

  try {
    fs.mkdirSync(path.dirname(versionFile), { recursive: true });
    fs.writeFileSync(versionFile, currentVersion);
  } catch {}

  if (!shouldClean) {
    const cacheDir = path.join(app.getPath("userData"), "pending");
    try {
      const size = await dirSize(cacheDir);
      if (size > 500 * 1024 * 1024) shouldClean = true;
    } catch {}
  }

  if (shouldClean) {
    const cacheDir = path.join(app.getPath("userData"), "pending");
    try {
      await fs.promises.rm(cacheDir, { recursive: true, force: true });
      console.log("[auto-updater] cleaned update cache");
    } catch {}
  }
}

async function dirSize(dir) {
  let total = 0;
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const stat = await fs.promises.stat(full);
        total += stat.size;
      } else if (entry.isDirectory()) {
        total += await dirSize(full);
      }
    }
  } catch {}
  return total;
}

function setupAutoUpdater() {
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) return;

  const feedUrl = getUpdateFeedUrl();
  if (feedUrl) {
    autoUpdater.setFeedURL(feedUrl);
    _feedConfigured = true;
  } else {
    _feedConfigured = false;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableDifferentialDownload = true;
  if (process.platform === "win32") {
    autoUpdater.installDirectory = path.dirname(app.getPath("exe"));
  }

  autoUpdater.on("checking-for-update", () => {
    logUpdate("checking for update");
    setState({ status: "checking", progress: null, error: null });
  });

  autoUpdater.on("update-available", async (info) => {
    logUpdate(`update available: version=${info.version || "unknown"}`);
    setState({
      status: "available",
      version: info.version,
      progress: null,
      error: null,
      releaseNotes: typeof info.releaseNotes === "string"
        ? info.releaseNotes
        : Array.isArray(info.releaseNotes)
          ? info.releaseNotes.map((note) => note.note || note).join("\n")
          : null,
    });

    const ok = await hasSufficientDiskSpace(app.getPath("userData"), 500);
    if (!ok) {
      logUpdate(`download blocked: insufficient disk space, version=${info.version || "unknown"}`);
      setState({ status: "error", error: "disk_space_insufficient", version: info.version });
      return;
    }

    autoUpdater.downloadUpdate().catch((err) => {
      logUpdate(`download failed: ${err?.message || String(err)}`);
      setState({ status: "error", error: err?.message || String(err) });
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    setState({
      status: "downloading",
      progress: {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      },
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    logUpdate(`update downloaded: version=${info.version || "unknown"}`);
    setState({
      status: "downloaded",
      version: info.version,
      progress: null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    logUpdate("update not available");
    setState({ status: "latest" });
  });

  autoUpdater.on("error", (err) => {
    if (isMissingLatestMetadataError(err)) {
      logUpdate(`update metadata not ready; treating as no update available: ${err?.message || String(err)}`);
      if (_updateState.status === "installing" && _setIsUpdating) _setIsUpdating(false);
      setState({ status: "latest", error: null, progress: null });
      return;
    }
    if (_updateState.status !== "idle" && _updateState.status !== "latest") {
      logUpdate(`error: ${err?.message || String(err)}`);
      if (_updateState.status === "installing" && _setIsUpdating) _setIsUpdating(false);
      setState({ status: "error", error: err?.message || String(err) });
    }
  });
}

function registerIpcHandlers() {
  if (_ipcHandlersRegistered) return;
  _ipcHandlersRegistered = true;

  ipcMain.handle("auto-update-check", async () => {
    if (_updateState.status === "installing") return getState();
    if (!_feedConfigured) {
      markUpdaterDisabled();
      return getState();
    }
    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) {
      markUpdaterDisabled();
      return getState();
    }
    resetState();
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (isMissingLatestMetadataError(err)) {
        setState({ status: "latest", error: null, progress: null });
      } else {
        setState({ status: "error", error: err?.message || String(err) });
      }
    }
  });

  ipcMain.handle("auto-update-download", async () => true);

  ipcMain.handle("auto-update-install", async () => {
    return installDownloadedUpdate("manual");
  });

  ipcMain.handle("auto-update-state", () => getState());

  ipcMain.handle("auto-update-set-channel", (_event, channel) => {
    const autoUpdater = getAutoUpdater();
    if (autoUpdater) autoUpdater.allowPrerelease = channel === "beta";
  });
}

function startPolling() {
  if (_checkTimer) return;
  _checkTimer = setInterval(() => {
    if (!_feedConfigured) return;
    if (!isAutoCheckEnabled()) return;
    const autoUpdater = getAutoUpdater();
    if (!autoUpdater) return;
    autoUpdater.checkForUpdates().catch(() => {});
  }, CHECK_INTERVAL);
}

function initAutoUpdater(mainWindow, {
  shutdownServer,
  setIsUpdating,
  appHome,
  gsapHome,
  hanakoHome,
} = {}) {
  _mainWindow = mainWindow;
  void shutdownServer;
  _setIsUpdating = setIsUpdating;
  _appHome = appHome || gsapHome || hanakoHome;

  registerIpcHandlers();

  if (!app.isPackaged) return;

  if (isRunningFromDmg()) {
    setState({ status: "error", error: "running_from_dmg" });
    return;
  }

  if (_updaterConfigured) return;
  _updaterConfigured = true;

  if (!isStrictSemverVersion(getAppVersion())) {
    getAutoUpdater();
    setUpdaterDisabledSilently();
    return;
  }

  cleanUpdateCache().catch(() => {});
  setupAutoUpdater();
  if (!_feedConfigured) {
    setUpdaterDisabledSilently();
    return;
  }
  startPolling();
}

async function checkForUpdatesAuto() {
  if (!app.isPackaged || isRunningFromDmg()) return;
  if (!_feedConfigured) return;
  if (!isAutoCheckEnabled()) return;
  const autoUpdater = getAutoUpdater();
  if (!autoUpdater) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch {}
}

function setUpdateChannel(channel) {
  const autoUpdater = getAutoUpdater();
  if (autoUpdater) autoUpdater.allowPrerelease = channel === "beta";
}

function setMainWindow(win) {
  _mainWindow = win;
}

module.exports = {
  initAutoUpdater,
  checkForUpdatesAuto,
  setMainWindow,
  setUpdateChannel,
  getState,
  installDownloadedUpdate,
};
