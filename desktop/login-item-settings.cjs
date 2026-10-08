const START_AT_LOGIN_ARG = "--gsap-start-at-login";
const LEGACY_START_AT_LOGIN_ARG = "--gsap-start-at-login";

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
  if (platform === "win32" && rawSettings.openAtLogin !== true) {
    const path = require("node:path").win32;
    const legacyOptions = getLoginItemOptions(platform, path.join(path.dirname(execPath), "BYOUNG.exe"));
    legacyOptions.args = [LEGACY_START_AT_LOGIN_ARG];
    const legacySettings = app.getLoginItemSettings(legacyOptions);
    // Electron's openAtLogin compares the default AppUserModelID value against
    // path + args. launchItems additionally reports Task Manager's enabled flag.
    // Only migrate a uniquely identified, enabled user entry; aggregate
    // executableWillLaunchAtLogin may refer to a different name or arguments.
    const legacyItems = (legacySettings.launchItems || []).filter((item) =>
      item.scope === "user" && typeof item.name === "string" && item.name.length > 0
      && typeof item.path === "string"
      && path.normalize(item.path).toLowerCase() === path.normalize(legacyOptions.path).toLowerCase()
      && Array.isArray(item.args) && item.args.length === legacyOptions.args.length
      && item.args.every((arg, index) => arg === legacyOptions.args[index]));
    if (legacySettings.openAtLogin === true && legacyItems.length === 1 && legacyItems[0].enabled === true) {
      // Both paths use the SAME default registry value. Replace it once; a
      // following set(false) would delete that value regardless of its path.
      // Leave disabled/unknown and separately named legacy entries untouched.
      app.setLoginItemSettings({ openAtLogin: true, ...options });
      rawSettings = app.getLoginItemSettings(options);
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
