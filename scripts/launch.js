#!/usr/bin/env node
/**
 * Cross-platform dev launcher
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_CODIA_DEV_HOME, applyCodiaHomeEnv, resolveServerInfoPath } from "../shared/codia-home.ts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const sourceServerEntryTs = fileURLToPath(new URL("../server/index.ts", import.meta.url));
const sourceServerEntryJs = fileURLToPath(new URL("../server/index.js", import.meta.url));
const bundledServerEntry = fileURLToPath(new URL("../dist-server-bundle/index.js", import.meta.url));
const sourceServerBootstrapTs = fileURLToPath(new URL("../server/bootstrap.ts", import.meta.url));
const sourceServerBootstrapJs = fileURLToPath(new URL("../server/bootstrap.js", import.meta.url));
const sourceServerEntry = fs.existsSync(sourceServerEntryTs) ? sourceServerEntryTs : sourceServerEntryJs;
const sourceServerBootstrap = fs.existsSync(sourceServerBootstrapTs) ? sourceServerBootstrapTs : sourceServerBootstrapJs;

const launchEnv = { ...process.env };
if (!launchEnv.CODIA_HOME) {
  applyCodiaHomeEnv(DEFAULT_CODIA_DEV_HOME, launchEnv);
}

const mode = process.argv[2];
const extra = process.argv.slice(3);

let bin, args;
switch (mode) {
  case "electron":
  case "electron-dev":
  case "electron-vite":
    // The source launcher owns Vite and the temporary sandbox preload.
    process.argv.splice(2, 1);
    if (mode === "electron-dev") process.argv.push("--dev");
    await import('./dev-desktop.mjs');
    process.exit(process.exitCode || 0);
    break;
  case "electron-built": {
    const requiredFiles = ["desktop/preload.bundle.cjs", "desktop/dist-renderer/index.html"];
    const missing = requiredFiles.filter((file) => !fs.existsSync(fileURLToPath(new URL(`../${file}`, import.meta.url))));
    if (missing.length) {
      console.error(`[launch] Missing local build files: ${missing.join(", ")}. Run 'npm run build:client' or 'npm run start:local'.`);
      process.exit(1);
    }
    launchEnv.CODIA_LAUNCH_NODE = process.execPath;
    launchEnv.CODIA_LAUNCH_NODE_VERSION = process.versions.node;
    launchEnv.CODIA_PORT = launchEnv.CODIA_PORT || "0";
    delete launchEnv.VITE_DEV_URL;
    delete launchEnv.CODIA_DEV_PRELOAD_PATH;
    bin = require("electron");
    args = [projectRoot, ...extra];
    break;
  }
  case "cli":
    bin = process.execPath;
    args = ["scripts/codiactl.mjs", ...extra];
    break;
  case "server":
    launchEnv.CODIA_SERVER_SCOPE = launchEnv.CODIA_SERVER_SCOPE || "pwa";
    launchEnv.CODIA_SERVER_INFO = launchEnv.CODIA_SERVER_INFO || resolveServerInfoPath(launchEnv.CODIA_HOME, launchEnv, "pwa");
    launchEnv.CODIA_ROOT = launchEnv.CODIA_ROOT || projectRoot;
    launchEnv.CODIA_SERVER_ENTRY = launchEnv.CODIA_SERVER_ENTRY || (
      fs.existsSync(sourceServerEntry) ? sourceServerEntry : bundledServerEntry
    );
    bin = process.execPath;
    args = [sourceServerBootstrap, ...extra];
    break;
  default:
    console.error("Usage: node scripts/launch.js <electron|electron-dev|electron-vite|electron-built|cli|server>");
    process.exit(1);
}

// When Electron is spawned from a terminal that set ELECTRON_RUN_AS_NODE,
// clear it so require("electron") returns Electron's runtime API.
delete launchEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(bin, args, {
  cwd: projectRoot, stdio: "inherit", env: launchEnv,
  // The desktop GUI must not inherit a hidden Windows startup state.
  windowsHide: false,
});
child.on("error", (error) => {
  console.error(`[launch] ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => process.exit(code ?? 1));
