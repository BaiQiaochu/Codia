const path = require("path");

function normalizeForCompare(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getUserDataAppName(codiaHome, defaultHome) {
  if (normalizeForCompare(codiaHome) === normalizeForCompare(defaultHome)) {
    return "Codia";
  }
  const suffix = path.basename(codiaHome).replace(/^\./, "");
  if (!suffix) return "Codia";
  if (suffix.toLowerCase() === "codia") return "Codia";
  if (suffix.toLowerCase().startsWith("codia-")) return `Codia${suffix.slice("codia".length)}`;
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
  const codiaHome = opts.codiaHome;
  const appName = getUserDataAppName(codiaHome, defaultHome || codiaHome);
  if (appName) {
    app.setPath("userData", path.join(app.getPath("appData"), appName));
  }

  const gotLock = app.requestSingleInstanceLock({ codiaHome });
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
