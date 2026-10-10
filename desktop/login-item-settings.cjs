const START_AT_LOGIN_ARG = "--codia-start-at-login";
const LEGACY_START_AT_LOGIN_ARG = "--codia-start-at-login";

function isAutoLaunchSupported(platform) {
  return platform === "darwin" || platform === "win32";
}

function getLoginItemOptions(platform, execPath) {
  if (platform !== "win32") return {};
  return {
    path: execPath,
    args: [START_AT_LOGIN_ARG],
  };
}

function wasLaunchedAtLogin({ platform, argv = [], loginItemSettings = {} } = {}) {
  if (platform === "win32") {
    return argv.includes(START_AT_LOGIN_ARG);
  }
  if (platform === "darwin") {
    return loginItemSettings.wasOpenedAtLogin === true
      || loginItemSettings.wasOpenedAsHidden === true;
  }
  return false;
}

function normalizeStatus({ platform, argv, rawSettings }) {
  if (!isAutoLaunchSupported(platform)) {
    return {
      supported: false,
      openAtLogin: false,
      openedAtLogin: false,
      status: "unsupported",
    };
  }

  return {
    supported: true,
    openAtLogin: rawSettings.openAtLogin === true,
    openedAtLogin: wasLaunchedAtLogin({ platform, argv, loginItemSettings: rawSettings }),
    status: rawSettings.status || null,
    executableWillLaunchAtLogin: rawSettings.executableWillLaunchAtLogin === undefined
      ? null
      : rawSettings.executableWillLaunchAtLogin === true,
  };
}

function getAutoLaunchStatus({ app, platform = process.platform, argv = process.argv, execPath = process.execPath } = {}) {
  if (!isAutoLaunchSupported(platform)) {
    return normalizeStatus({ platform, argv, rawSettings: {} });
  }
  const options = getLoginItemOptions(platform, execPath);
  let rawSettings = app.getLoginItemSettings(options);
  if (platform === "win32") {
    const path = require("node:path");
    const legacyOptions = getLoginItemOptions(platform, path.join(path.dirname(execPath), "CODIA.exe"));
    legacyOptions.args = [LEGACY_START_AT_LOGIN_ARG];
    const legacySettings = app.getLoginItemSettings(legacyOptions);
    if (legacySettings.openAtLogin === true) {
      if (!rawSettings.openAtLogin) {
        app.setLoginItemSettings({ openAtLogin: true, ...options });
      }
      app.setLoginItemSettings({ openAtLogin: false, ...legacyOptions });
      if (!rawSettings.openAtLogin) rawSettings = app.getLoginItemSettings(options);
    }
  }
  return normalizeStatus({ platform, argv, rawSettings });
}

function setAutoLaunchEnabled({
  app,
  enabled,
  platform = process.platform,
  argv = process.argv,
  execPath = process.execPath,
} = {}) {
  if (!isAutoLaunchSupported(platform)) {
    return normalizeStatus({ platform, argv, rawSettings: {} });
  }
  const options = getLoginItemOptions(platform, execPath);
  app.setLoginItemSettings({
    openAtLogin: enabled === true,
    ...options,
  });
  return getAutoLaunchStatus({ app, platform, argv, execPath });
}

module.exports = {
  START_AT_LOGIN_ARG,
  getAutoLaunchStatus,
  getLoginItemOptions,
  isAutoLaunchSupported,
  setAutoLaunchEnabled,
  wasLaunchedAtLogin,
};
