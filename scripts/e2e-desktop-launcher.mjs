import path from "node:path";

export function desktopLaunchEnv(overrides = {}, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    ...overrides,
  };
  if (env.CODIA_E2E === "1") {
    if (!env.CODIA_PORT) env.CODIA_PORT = "0";
    // Keep local smoke runs free of SDK discovery, telemetry and update traffic.
    env.PI_OFFLINE = "1";
    env.PI_TELEMETRY = "0";
    env.PI_SKIP_VERSION_CHECK = "1";
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function desktopLaunchCommand(rootDir, extraArgs = []) {
  const packagedApp = String(process.env.CODIA_E2E_DESKTOP_APP || "").trim();
  if (packagedApp) {
    return {
      command: packagedApp,
      // Packaged Windows builds reject Chromium switches as app CLI options.
      // The main process reads CODIA_E2E_REMOTE_DEBUG_PORT from env instead.
      args: [],
      cwd: path.dirname(packagedApp),
      mode: "packaged",
    };
  }
  return {
    command: process.execPath,
    args: ["scripts/launch.js", process.env.CODIA_E2E_DESKTOP_MODE === "built" ? "electron-built" : "electron", ...extraArgs],
    cwd: rootDir,
    mode: process.env.CODIA_E2E_DESKTOP_MODE === "built" ? "built" : "source",
  };
}
