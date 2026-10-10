/**
 * electron-builder afterPack hook.
 *
 * Ensures packaged apps include production dependencies that the static
 * dependency scanner may miss.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REQUIRED_SERVER_NODE_MODULE_FILES = [
  path.join("ws", "package.json"),
  path.join("qrcode", "package.json"),
  path.join("better-sqlite3", "package.json"),
];

function copyBundledServerNodeModules(serverDir, serverBuildModules, { log = console.log } = {}) {
  if (!serverDir || !serverBuildModules) return false;
  if (!fs.existsSync(serverDir) || !fs.existsSync(serverBuildModules)) return false;

  const serverNodeModules = path.join(serverDir, "node_modules");
  fs.rmSync(serverNodeModules, { recursive: true, force: true });
  fs.cpSync(serverBuildModules, serverNodeModules, { recursive: true });
  log(`[fix-modules] copied server native deps -> ${serverNodeModules}`);
  assertBundledServerNodeModulesReady(serverNodeModules);
  return true;
}

function assertBundledServerNodeModulesReady(serverNodeModules) {
  for (const relativePath of REQUIRED_SERVER_NODE_MODULE_FILES) {
    const requiredPath = path.join(serverNodeModules, relativePath);
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`[fix-modules] packaged server dependency missing: ${requiredPath.replace(/\\/g, "/")}`);
    }
  }
}

exports.default = async function (context) {
  const platformName = context.packager.platform.name;
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : "x64";
  const appDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources", "app")
    : path.join(context.appOutDir, "resources", "app");
  const distModules = path.join(appDir, "node_modules");
  const localModules = path.resolve(__dirname, "..", "node_modules");

  // Copy server native dependencies built by build-server into app resources.
  const resourcesDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  if (platformName === "mac") {
    const computerUseHelper = path.join(resourcesDir, "computer-use", "macos", "codia-computer-use-helper");
    if (!fs.existsSync(computerUseHelper)) {
      throw new Error(
        `[fix-modules] Computer Use helper missing from macOS app resources: ${computerUseHelper}. ` +
        "Run scripts/build-computer-use-helper.mjs before electron-builder.",
      );
    }
    const mode = fs.statSync(computerUseHelper).mode;
    if ((mode & 0o111) === 0) {
      throw new Error(`[fix-modules] Computer Use helper is not executable: ${computerUseHelper}`);
    }
  }
  const serverDir = path.join(resourcesDir, "server");
  const osDirName = platformName === "mac" ? "mac" : platformName === "windows" ? "win" : "linux";
  const serverBuildModules = path.join(__dirname, "..", "dist-server", `${osDirName}-${arch}`, "node_modules");
  copyBundledServerNodeModules(serverDir, serverBuildModules);

  if (!fs.existsSync(distModules)) return;

  // Read the production dependency tree.
  let prodDeps;
  try {
    const raw = execSync("npm ls --all --json --omit=dev", {
      cwd: path.resolve(__dirname, ".."),
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    prodDeps = JSON.parse(raw);
  } catch (e) {
    // npm ls can exit 1 for peer dependency warnings while still printing JSON.
    try {
      prodDeps = JSON.parse(e.stdout?.toString() || "{}");
    } catch {
      console.log("[fix-modules] unable to parse dependency tree; skipping");
      return;
    }
  }

  function collectDeps(obj, set = new Set()) {
    if (!obj || !obj.dependencies) return set;
    for (const [name, info] of Object.entries(obj.dependencies)) {
      set.add(name);
      collectDeps(info, set);
    }
    return set;
  }

  const allProd = collectDeps(prodDeps);
  let copied = 0;

  // Native bindings need platform-matched copies.
  const NATIVE_PACKAGES = new Set(["bufferutil", "utf-8-validate"]);

  for (const dep of allProd) {
    const distPath = path.join(distModules, dep);
    const localPath = path.join(localModules, dep);
    if (!fs.existsSync(distPath) && fs.existsSync(localPath)) {
      if (NATIVE_PACKAGES.has(dep)) {
        console.warn(`[fix-modules] copying native package "${dep}" for the current platform`);
      }
      fs.cpSync(localPath, distPath, { recursive: true });
      copied++;
    }
  }

  if (copied > 0) {
    console.log(`[fix-modules] copied ${copied} missing production dependencies`);
  }

  // Remove .bin symlinks that point outside the packaged app.
  let removedLinks = 0;
  function cleanBinLinks(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        if (path.isAbsolute(target) && !target.startsWith(appDir)) {
          fs.unlinkSync(full);
          removedLinks++;
        }
      } else if (entry.isDirectory() && entry.name !== ".bin") {
        // Recurse into nested node_modules only.
        const binDir = path.join(full, "node_modules", ".bin");
        if (fs.existsSync(binDir)) cleanBinLinks(binDir);
      }
    }
  }

  // Scan top-level and nested .bin directories.
  const topBin = path.join(distModules, ".bin");
  if (fs.existsSync(topBin)) cleanBinLinks(topBin);
  for (const entry of fs.readdirSync(distModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = path.join(distModules, entry.name, "node_modules", ".bin");
    if (fs.existsSync(nested)) cleanBinLinks(nested);
  }

  if (removedLinks > 0) {
    console.log(`[fix-modules] removed ${removedLinks} .bin links pointing outside bundle`);
  }
};

exports.copyBundledServerNodeModules = copyBundledServerNodeModules;
exports.assertBundledServerNodeModulesReady = assertBundledServerNodeModulesReady;
