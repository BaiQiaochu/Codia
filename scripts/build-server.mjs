#!/usr/bin/env node
/**
  *
 * 策略：Vite bundle + 外部依赖 npm install + Node.js runtime
  *
 * codia-server -shell wrapper（设-CODIA_ROOT 并启动）
  *
 *         shared-XXXX.js
 *         core-XXXX.js
 *         lib-XXXX.js
 *         hub-XXXX.js
  *
 *       default-models.json
 *       config.example.yaml
 *       identity.example.md
 *       ishiki.example.md
 *       pinned.example.md
 *       identity-templates/
 *       ishiki-templates/
 *       public-ishiki-templates/
 *       yuan/
  *
 * package.json -external deps + version（node_modules 解析 + 运行时版本读取）
  *
  * */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { builtinModules } from "module";
import { createHash } from "crypto";
import { build as esbuild } from "esbuild";
import { prepareHermesRuntime } from "./prepare-hermes-runtime.mjs";
import { prepareBundledFfmpeg } from "./prepare-ffmpeg-portable.mjs";
import { pruneServerReleaseOutput } from "./prune-server-release-output.mjs";
import {
  buildBetterSqliteRuntimeSmokeScript,
  buildExternalPackage,
  verifyExternalEntrypoints,
} from "./build-server-deps.mjs";
import {
  collectBundledPluginPackageDependencies,
  copyOrTranspileRuntimeDependency,
  copyBundledPluginRuntimeDependencies,
  transpilePackagedRuntimeTypeScript,
  transpileBundledPluginTypeScript,
  validatePackagedRuntimeImports,
} from "./build-server-plugin-runtime-deps.mjs";
import { copyServerRuntimeAssets } from "./build-server-runtime-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
//
const osDirName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
const outDir = path.join(ROOT, "dist-server", `${osDirName}-${arch}`);

console.log(`[build-server] Building for ${platform}-${arch}...`);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeDirRobust(targetDir) {
  if (!fs.existsSync(targetDir)) return;

  let lastError = null;
  const retries = platform === "win32" ? 8 : 3;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) sleep(250 * (attempt + 1));
    }
  }

  if (platform === "win32") {
    const fallbackDir = `${targetDir}.__stale__${Date.now()}`;
    try {
      fs.renameSync(targetDir, fallbackDir);
      fs.rmSync(fallbackDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

// -- 0. 清理 --
removeDirRobust(outDir);
fs.mkdirSync(outDir, { recursive: true });

//
const NODE_VERSION = "v24.15.0";
const ESBUILD_NODE_TARGET = "--target=node24";
const NODE_RUNTIME_SHA256 = {
  "node-v24.15.0-darwin-arm64.tar.gz": "372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4",
  "node-v24.15.0-darwin-x64.tar.gz": "ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b",
  "node-v24.15.0-linux-arm64.tar.gz": "73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed",
  "node-v24.15.0-linux-x64.tar.gz": "44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89",
  "node-v24.15.0-win-x64.zip": "cc5149eabd53779ce1e7bdc5401643622d0c7e6800ade18928a767e940bb0e62",
};
const cacheDir = path.join(ROOT, ".cache", "node-runtime");
fs.mkdirSync(cacheDir, { recursive: true });

const nodeMap = {
  "darwin-arm64": `node-${NODE_VERSION}-darwin-arm64`,
  "darwin-x64": `node-${NODE_VERSION}-darwin-x64`,
  "linux-x64": `node-${NODE_VERSION}-linux-x64`,
  "linux-arm64": `node-${NODE_VERSION}-linux-arm64`,
  "win32-x64": `node-${NODE_VERSION}-win-x64`,
};

const nodeDirName = nodeMap[`${platform}-${arch}`];
if (!nodeDirName) {
  console.error(`[build-server] unsupported platform: ${platform}-${arch}`);
  process.exit(1);
}

const isWin = platform === "win32";
const ext = isWin ? "zip" : "tar.gz";
const filename = `${nodeDirName}.${ext}`;
const cachedArchive = path.join(cacheDir, filename);
const cachedNodeBin = isWin
  ? path.join(cacheDir, nodeDirName, "node.exe")
  : path.join(cacheDir, nodeDirName, "bin", "node");
const cachedNpmCli = isWin
  ? path.join(cacheDir, nodeDirName, "node_modules", "npm", "bin", "npm-cli.js")
  : path.join(cacheDir, nodeDirName, "lib", "node_modules", "npm", "bin", "npm-cli.js");

function verifyNodeRuntimeArchive(filePath, archiveName) {
  const expected = NODE_RUNTIME_SHA256[archiveName];
  if (!expected) throw new Error(`[build-server] missing checksum for node runtime archive: ${archiveName}`);
  const actual = createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `[build-server] node runtime archive checksum mismatch: ${archiveName}\n`
      + `expected ${expected}\n`
      + `actual   ${actual}`,
    );
  }
}

if (!fs.existsSync(cachedNodeBin)) {
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${filename}`;
  console.log(`[build-server] downloading Node.js ${NODE_VERSION} for ${platform}-${arch}...`);
  execSync(`curl -L -o "${cachedArchive}" "${url}"`, { stdio: "inherit" });
  verifyNodeRuntimeArchive(cachedArchive, filename);

  if (isWin) {
    execSync(`tar -xf "${cachedArchive}" -C "${cacheDir}"`, { stdio: "inherit" });
  } else {
    execSync(`tar xzf "${cachedArchive}" -C "${cacheDir}"`, { stdio: "inherit" });
  }

  try { fs.unlinkSync(cachedArchive); } catch {}
  console.log("[build-server] Node.js runtime cached");
} else {
  console.log(`[build-server] using cached Node.js ${NODE_VERSION}`);
}

// 复制 node 二进制到 dist
const destNode = path.join(outDir, isWin ? "codia-server.exe" : "node");
fs.copyFileSync(cachedNodeBin, destNode);
if (!isWin) fs.chmodSync(destNode, 0o755);
console.log("[build-server] Node.js runtime ready");

const targetNodeDir = path.dirname(cachedNodeBin);
const targetEnv = {
  ...process.env,
  NODE_ENV: "production",
  PUPPETEER_SKIP_DOWNLOAD: "1",
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "1",
  npm_config_puppeteer_skip_download: "true",
  PATH: `${targetNodeDir}${path.delimiter}${process.env.PATH}`,
};
function runWithTargetNode(cmd, opts = {}) {
  execSync(`"${cachedNodeBin}" ${cmd}`, {
    cwd: outDir,
    stdio: "inherit",
    env: targetEnv,
    ...opts,
  });
}

function envWithNoDeprecationWarnings(env) {
  const existingNodeOptions = String(env.NODE_OPTIONS || "").trim();
  return {
    ...env,
    NODE_OPTIONS: `${existingNodeOptions} --no-deprecation`.trim(),
  };
}

function patchPrebuildInstallDeprecation(targetRoot) {
  const downloadJs = path.join(targetRoot, "node_modules", "prebuild-install", "download.js");
  if (!fs.existsSync(downloadJs)) return;

  const original = fs.readFileSync(downloadJs, "utf-8");
  const patched = original
    .replace(/\bfs\.R_OK\b/g, "fs.constants.R_OK")
    .replace(/\bfs\.W_OK\b/g, "fs.constants.W_OK");
  if (patched === original) return;

  fs.writeFileSync(downloadJs, patched);
  console.log("[build-server] patched prebuild-install Node 24 deprecation usage");
}

function runBetterSqliteRuntimeSmokeIfNeeded() {
  if (!externalPkg.dependencies["better-sqlite3"]) return;
  const smokeScript = path.join(outDir, ".better-sqlite3-smoke.mjs");
  fs.writeFileSync(smokeScript, buildBetterSqliteRuntimeSmokeScript());
  try {
    runWithTargetNode(path.basename(smokeScript));
  } finally {
    fs.rmSync(smokeScript, { force: true });
  }
}

// -- 2. Vite bundle --
//
console.log("[build-server] running Vite bundle...");
const viteBundleDir = path.join(ROOT, "dist-server-bundle");
execSync("npx vite build --config vite.config.server.js", {
  cwd: ROOT,
  stdio: "inherit",
});

// 复制 bundle 产出
const bundleOutDir = path.join(outDir, "bundle");
fs.cpSync(viteBundleDir, bundleOutDir, { recursive: true });
console.log("[build-server] Vite bundle copied to bundle/");

const bootstrapTs = path.join(ROOT, "server", "bootstrap.ts");
const bootstrapJs = path.join(ROOT, "server", "bootstrap.js");
if (fs.existsSync(bootstrapTs)) {
  await esbuild({
    entryPoints: [bootstrapTs],
    outfile: path.join(outDir, "bootstrap.js"),
    platform: "node",
    target: ESBUILD_NODE_TARGET.replace("--target=", ""),
    format: "esm",
    bundle: true,
    sourcemap: false,
    logLevel: "silent",
  });
  console.log("[build-server] bootstrap.js built from server/bootstrap.ts");
} else {
  fs.copyFileSync(bootstrapJs, path.join(outDir, "bootstrap.js"));
  console.log("[build-server] bootstrap.js copied");
}

//

const LIB_DATA_GLOBS = [
  "known-models.json",
  "known-model-fallbacks.json",
  "default-models.json",
  "config.example.yaml",
  "identity.example.md",
  "ishiki.example.md",
  "pinned.example.md",
];
const libOutDir = path.join(outDir, "lib");
fs.mkdirSync(libOutDir, { recursive: true });
for (const file of LIB_DATA_GLOBS) {
  const src = path.join(ROOT, "lib", file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(libOutDir, file));
    console.log(`[build-server]   lib/${file}`);
  } else {
    console.warn(`[build-server] 鈿?lib/${file} not found, skipping`);
  }
}

const LIB_TEMPLATE_DIRS = [
  "identity-templates",
  "ishiki-templates",
  "public-ishiki-templates",
  "yuan",
];
for (const dir of LIB_TEMPLATE_DIRS) {
  const src = path.join(ROOT, "lib", dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(libOutDir, dir), { recursive: true });
    console.log(`[build-server]   lib/${dir}/`);
  } else {
    console.warn(`[build-server] 鈿?lib/${dir}/ not found, skipping`);
  }
}

// skills2set（运行时复制到用户数据目录）
const skillsSrc = path.join(ROOT, "skills2set");
if (fs.existsSync(skillsSrc)) {
  fs.cpSync(skillsSrc, path.join(outDir, "skills2set"), { recursive: true });
  console.log("[build-server]   skills2set/");
}

const localesSrc = path.join(ROOT, "desktop", "src", "locales");
fs.mkdirSync(path.join(outDir, "desktop", "src", "locales"), { recursive: true });
fs.cpSync(localesSrc, path.join(outDir, "desktop", "src", "locales"), { recursive: true });
console.log("[build-server]   desktop/src/locales/");

const themesSrc = path.join(ROOT, "desktop", "src", "themes");
if (fs.existsSync(themesSrc)) {
  fs.mkdirSync(path.join(outDir, "desktop", "src", "themes"), { recursive: true });
  fs.cpSync(themesSrc, path.join(outDir, "desktop", "src", "themes"), { recursive: true });
  console.log("[build-server]   desktop/src/themes/");
}

// Character-card import/export previews read default avatars, card backs, and
// Yuan icons through fromRoot(). Packaged servers run from resources/server, so
// these assets must be copied into dist-server.
for (const copiedAsset of copyServerRuntimeAssets({ rootDir: ROOT, outDir })) {
  console.log(`[build-server]   ${copiedAsset}`);
}

const pluginsSrc = path.join(ROOT, "plugins");
if (fs.existsSync(pluginsSrc)) {
  const pluginsOutDir = path.join(outDir, "plugins");
  fs.cpSync(pluginsSrc, pluginsOutDir, { recursive: true });
  for (const output of transpileBundledPluginTypeScript({ pluginsDir: pluginsOutDir })) {
    console.log(`[build-server]   plugins/${output}`);
  }
  console.log("[build-server]   plugins/");
}

// Runtime plugin files keep relative imports to ../../../shared/*.js.
// Copy shared helpers so bundled server resources can load plugins directly.
const sharedSrc = path.join(ROOT, "shared");
if (fs.existsSync(sharedSrc)) {
  fs.cpSync(sharedSrc, path.join(outDir, "shared"), { recursive: true });
  console.log("[build-server]   shared/");
}

// Built-in plugins import a small host-runtime surface by relative ESM paths.
// Keep these files explicit so a clean release build does not depend on the
// tracer happening to discover a specific plugin entry first.
const REQUIRED_PLUGIN_HOST_RUNTIME_DEPS = [
  path.join("lib", "i18n.js"),
  path.join("lib", "debug-log.js"),
  path.join("lib", "log-redactor.js"),
  path.join("shared", "app-root.js"),
  path.join("shared", "log-redactor.cjs"),
  path.join("server", "hono-helpers.js"),
];

for (const relativePath of REQUIRED_PLUGIN_HOST_RUNTIME_DEPS) {
  console.log(`[build-server]   ${copyOrTranspileRuntimeDependency({
    rootDir: ROOT,
    outDir,
    relativePath,
  })}`);
}

// Hermes Agent runtime（外-Python agent，打包为可分发依赖）
for (const copiedDependency of await copyBundledPluginRuntimeDependencies({
  rootDir: ROOT,
  outDir,
  allowedHostDirs: ["core", "lib", "shared", "server"],
})) {
  console.log(`[build-server]   ${copiedDependency}`);
}

for (const runtimeOutput of transpilePackagedRuntimeTypeScript({ outDir })) {
  console.log(`[build-server]   ${runtimeOutput}`);
}

const runtimeImportValidation = validatePackagedRuntimeImports({ outDir });
console.log(`[build-server] packaged runtime imports checked: ${runtimeImportValidation.checkedFiles} files`);

const hermesRuntime = prepareHermesRuntime({ rootDir: ROOT, outDir, platform });
if (hermesRuntime.prepared) {
  console.log("[build-server]   hermes-agent-runtime/");
} else {
  console.log(`[build-server]   hermes-agent-runtime skipped (${hermesRuntime.reason})`);
}

const ffmpegRuntime = prepareBundledFfmpeg({ rootDir: ROOT, outDir, platform });
if (ffmpegRuntime.prepared) {
  console.log("[build-server]   ffmpeg/");
} else {
  console.log(`[build-server]   ffmpeg skipped (${ffmpegRuntime.reason})`);
}

console.log("[build-server] resource files copied");

// -- 4. External dependencies --
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

// defineConfig 是纯 identity 函数，import 安全无副作用
const viteConfig = (await import("../vite.config.server.js")).default;
const viteExternals = viteConfig.build?.rollupOptions?.external;
if (!Array.isArray(viteExternals)) {
  throw new Error("[build-server] vite.config.server.js external must be an array");
}

const builtinSet = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const deps = rootPkg.dependencies || {};
const externalDeps = {};

for (const ext of viteExternals) {
  if (typeof ext === "string") {
    if (builtinSet.has(ext)) continue;
    if (deps[ext]) externalDeps[ext] = deps[ext];
 // 不在 dependencies 中的（如 fsevents、photon-node）由 transitive -optional 提供
  } else if (ext instanceof RegExp) {
    for (const dep of Object.keys(deps)) {
      if (ext.test(dep)) externalDeps[dep] = deps[dep];
    }
  }
}

const pluginPackageDeps = await collectBundledPluginPackageDependencies({ rootDir: ROOT });
for (const packageName of pluginPackageDeps) {
  if (deps[packageName]) {
    externalDeps[packageName] = deps[packageName];
  }
}
const undeclaredPluginDeps = pluginPackageDeps.filter((packageName) => !deps[packageName]);
if (undeclaredPluginDeps.length > 0) {
  throw new Error(
    "[build-server] bundled plugin imports npm packages missing from root dependencies: "
      + undeclaredPluginDeps.join(", "),
  );
}

console.log(`[build-server] derived external deps: ${Object.keys(externalDeps).join(", ")}`);

const rootLock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"));
// jsdom is externalized and loads lru-cache at runtime. Pin it to the exact
// root lockfile version so fresh installer/PWA/portable builds cannot float to
// an unverified package export shape.
const externalPkg = buildExternalPackage(rootPkg, externalDeps, {
  rootLock,
  // pi-coding-agent 1.1.0 declares its sibling packages with caret ranges.
  // Installing the generated server package without these direct pins can mix
  // pi 1.1.0 with newer sibling releases whose export contracts differ.
  pinnedTransitiveDeps: [
    "lru-cache",
    "@earendil-works/chord",
    "@earendil-works/pi-codemode",
    "@earendil-works/pi-mcp",
    "@earendil-works/pi-telemetry",
    "@earendil-works/pi-tui",
  ],
  packageName: "codia-server",
});
const pinnedDeps = Object.entries(externalPkg.dependencies)
  .map(([name, version]) => `${name}@${version}`)
  .join(", ");
console.log(`[build-server] pinned server deps: ${pinnedDeps}`);

fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(externalPkg, null, 2) + "\n",
);

//
// （prebuild-install 下载正确 ABI 的预编译二进制）
//
runWithTargetNode(
  `"${cachedNpmCli}" install --omit=dev --no-audit --no-fund --ignore-scripts=false --loglevel=error`,
  { env: envWithNoDeprecationWarnings(targetEnv) },
);
patchPrebuildInstallDeprecation(outDir);

//
const OPTIONAL_EXTERNALS = new Set(["fsevents"]);
const missing = [];
for (const ext of viteExternals) {
  if (typeof ext !== "string" || builtinSet.has(ext)) continue;
  if (!fs.existsSync(path.join(outDir, "node_modules", ext))) {
    if (OPTIONAL_EXTERNALS.has(ext)) continue;
    missing.push(ext);
  }
}
if (missing.length > 0) {
  console.error(`[build-server] 鉂?Vite externals missing from node_modules: ${missing.join(", ")}`);
  console.error(`[build-server]   These packages are external in the bundle but not installed.`);
  console.error(`[build-server]   Fix: add them to root package.json dependencies, or check transitive dep chains.`);
  process.exit(1);
}

// -- 6. PI SDK patch --
// package.json 没有 postinstall，手动跑补丁
try {
  verifyExternalEntrypoints(outDir, Object.keys(externalPkg.dependencies));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
runBetterSqliteRuntimeSmokeIfNeeded();

const patchScript = path.join(ROOT, "scripts", "patch-pi-sdk.cjs");
if (fs.existsSync(patchScript)) {
  fs.mkdirSync(path.join(outDir, "scripts"), { recursive: true });
  fs.copyFileSync(patchScript, path.join(outDir, "scripts", "patch-pi-sdk.cjs"));
  runWithTargetNode("scripts/patch-pi-sdk.cjs");
  fs.rmSync(path.join(outDir, "scripts"), { recursive: true });
}

// -- 7. 清理 node_modules/.bin --
//
function removeBinDirs(nmDir) {
  const topBin = path.join(nmDir, ".bin");
  if (fs.existsSync(topBin)) fs.rmSync(topBin, { recursive: true });
 // 嵌套-node_modules/.bin
  for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const nested = path.join(nmDir, entry.name, "node_modules", ".bin");
    if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true });
  }
}
removeBinDirs(path.join(outDir, "node_modules"));

console.log("[build-server] dependencies installed");

//
console.log("[build-server] skipping nft prune on this build");
const nmDir = path.join(outDir, "node_modules");

const koffiBuilds = path.join(nmDir, "koffi", "build", "koffi");
if (fs.existsSync(koffiBuilds)) {
  const target = `${platform === "darwin" ? "darwin" : platform === "win32" ? "win32" : "linux"}_${arch}`;
  let koffiRemoved = 0;
  for (const entry of fs.readdirSync(koffiBuilds)) {
    if (entry !== target) {
      fs.rmSync(path.join(koffiBuilds, entry), { recursive: true, force: true });
      koffiRemoved++;
    }
  }
  if (koffiRemoved > 0) {
    console.log(`[build-server] koffi: kept ${target}, removed ${koffiRemoved} other platform binaries`);
  }
}

// -- 9. 更新 package.json --
// npm ci 之后 package.json 仍在，确保它包含 version 字段
//
pruneServerReleaseOutput(outDir);

const installedPkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf-8"));
installedPkg.version = rootPkg.version;
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(installedPkg, null, 2) + "\n",
);

//
if (isWin) {
  fs.writeFileSync(
    path.join(outDir, "codia-server.cmd"),
    '@echo off\r\nset "CODIA_ROOT=%~dp0"\r\nset "CODIA_SERVER_ENTRY=%~dp0bundle\\index.js"\r\n"%~dp0codia-server.exe" "%~dp0bootstrap.js" %*\r\n',
  );
} else {
  const wrapper = path.join(outDir, "codia-server");
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'export CODIA_ROOT="$DIR"',
    'export CODIA_SERVER_ENTRY="$DIR/bundle/index.js"',
    'exec "$DIR/node" "$DIR/bootstrap.js" "$@"',
    "",
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);
}
console.log("[build-server] wrapper created");

console.log("[build-server] Done!");
