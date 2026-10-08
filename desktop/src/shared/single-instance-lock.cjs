const path = require("path");

function normalizeForCompare(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getUserDataAppName(gsapHome, defaultHome) {
  if (normalizeForCompare(gsapHome) === normalizeForCompare(defaultHome)) {
    return "G-SAP";
  }
  const suffix = path.basename(gsapHome).replace(/^\./, "");
  if (!suffix) return "G-SAP";
  if (suffix.toLowerCase() === "gsap") return "G-SAP";
  if (suffix.toLowerCase().startsWith("gsap-")) return `G-SAP${suffix.slice(4)}`;
  return suffix.charAt(0).toUpperCase() + suffix.slice(1);
}

function exitDuplicateClient(app) {
  if (typeof app.exit === "function") {
    app.exit(0);
    return;
  }
  app.quit();
}

function focusExistingWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (win.isMinimized?.()) win.restore?.();
  win.show?.();
  win.focus?.();
  return true;
}

function configureClientSingleInstance(app, opts) {
  const { defaultHome, onSecondInstance } = opts;
  const gsapHome = opts.gsapHome || opts.hanakoHome;
  const appName = getUserDataAppName(gsapHome, defaultHome || gsapHome);
  if (appName) {
    app.setPath("userData", path.join(app.getPath("appData"), appName));
  }

  const gotLock = app.requestSingleInstanceLock({ gsapHome });
  if (!gotLock) {
    exitDuplicateClient(app);
    return false;
  }

  app.on("second-instance", () => {
    onSecondInstance?.();
  });
  return true;
}

module.exports = {
  configureClientSingleInstance,
  focusExistingWindow,
  getUserDataAppName,
};
