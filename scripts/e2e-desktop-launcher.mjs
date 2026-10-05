import path from "node:path";

export function desktopLaunchEnv(overrides = {}, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    ...overrides,
  };
  if (env.GSAP_E2E === "1" && !env.GSAP_PORT) {
    env.GSAP_PORT = "0";
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function desktopLaunchCommand(rootDir, extraArgs = []) {
  const packagedApp = String(process.env.GSAP_E2E_DESKTOP_APP || "").trim();
  if (packagedApp) {
    return {
      command: packagedApp,
      // Packaged Windows builds reject Chromium switches as app CLI options.
      // The main process reads GSAP_E2E_REMOTE_DEBUG_PORT from env instead.
      args: [],
      cwd: path.dirname(packagedApp),
      mode: "packaged",
    };
  }
  return {
    command: process.execPath,
    args: ["scripts/launch.js", "electron", ...extraArgs],
    cwd: rootDir,
    mode: "source",
  };
}
