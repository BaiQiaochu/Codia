import crypto from "crypto";
import fs from "fs";
import path from "path";

const CACHE_DIR = "win32-sandbox-runtime";
const MARKER_FILE = ".gsap-sandbox-runtime.json";

function isWin32PathLike(filePath) {
  return /^[a-z]:[\\/]|^\\\\/i.test(String(filePath || ""));
}

function pathOpsFor(...paths) {
  return paths.some(isWin32PathLike) ? path.win32 : path;
}

function joinRuntimePath(root, ...segments) {
  const ops = pathOpsFor(root);
  return ops.join(root, ...segments);
}

function dirnameRuntimePath(filePath) {
  return pathOpsFor(filePath).dirname(filePath);
}

function normalizeForCompare(filePath) {
  const ops = pathOpsFor(filePath);
  const normalized = ops.normalize(String(filePath || ""));
  return ops === path.win32 ? normalized.toLowerCase() : normalized;
}

function isInsideRuntimeRoot(target, root) {
  if (!target || !root) return false;
  const ops = pathOpsFor(target, root);
  const targetNorm = normalizeForCompare(target);
  const rootNorm = normalizeForCompare(root);
  const rel = ops.relative(rootNorm, targetNorm);
  return rel === "" || (!!rel && !rel.startsWith("..") && !ops.isAbsolute(rel));
}

function runtimePrimaryPath(runtimeInfo) {
  return runtimeInfo?.git || runtimeInfo?.shell || runtimeInfo?.executable || null;
}

function runtimeSourceRoot(runtimeInfo) {
  if (runtimeInfo?.bundledRoot) return runtimeInfo.bundledRoot;
  const primary = runtimePrimaryPath(runtimeInfo);
  return primary ? dirnameRuntimePath(primary) : null;
}

function rewriteRuntimePath(sourcePath, sourceRoot, targetRoot) {
  if (!sourcePath) return sourcePath;
  const ops = pathOpsFor(sourcePath, sourceRoot, targetRoot);
  let rel = ops.relative(sourceRoot, sourcePath);
  if (!rel || rel.startsWith("..") || ops.isAbsolute(rel)) {
    rel = ops.basename(sourcePath);
  }
  return ops.join(targetRoot, rel);
}

function statSignature(filePath) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

function runtimeManifest({ sourceRoot, primaryPath, kind }) {
  return {
    version: 1,
    kind,
    sourceRoot: normalizeForCompare(sourceRoot),
    primaryPath: normalizeForCompare(primaryPath),
    sourceRootStat: statSignature(sourceRoot),
    primaryStat: statSignature(primaryPath),
  };
}

function manifestMatches(markerPath, manifest) {
  try {
    const existing = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    return JSON.stringify(existing) === JSON.stringify(manifest);
  } catch {
    return false;
  }
}

function stableCacheName({ sourceRoot, primaryPath, kind, manifest }) {
  const hash = crypto
    .createHash("sha256")
    .update(`${kind}\0${normalizeForCompare(sourceRoot)}\0${normalizeForCompare(primaryPath)}`)
    .update(`\0${JSON.stringify(manifest)}`)
    .digest("hex")
    .slice(0, 16);
  return `${kind}-${hash}`;
}

function copyRuntimeTree({ sourceRoot, targetRoot, markerPath, manifest }) {
  const ops = pathOpsFor(sourceRoot, targetRoot);
  const parent = ops.dirname(targetRoot);
  fs.mkdirSync(parent, { recursive: true });

  const tmpRoot = ops.join(parent, `.${ops.basename(targetRoot)}.tmp-${process.pid}-${Date.now()}`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  try {
    fs.cpSync(sourceRoot, tmpRoot, {
      recursive: true,
      force: true,
      dereference: true,
    });
    fs.writeFileSync(ops.join(tmpRoot, MARKER_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.renameSync(tmpRoot, targetRoot);
  } catch (err) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (fs.existsSync(targetRoot) && manifestMatches(markerPath, manifest)) return;
    throw err;
  }
}

function ensureCachedRuntimeRoot({ sourceRoot, primaryPath, gsapHome, kind }) {
  if (!gsapHome) {
    throw new Error("[win32-sandbox] GSAP_HOME is required to prepare sandbox runtime cache.");
  }
  if (!sourceRoot || !fs.existsSync(sourceRoot)) {
    throw new Error(`[win32-sandbox] Runtime source root does not exist: ${sourceRoot || "(missing)"}`);
  }
  if (!primaryPath || !fs.existsSync(primaryPath)) {
    throw new Error(`[win32-sandbox] Runtime executable does not exist: ${primaryPath || "(missing)"}`);
  }

  const cacheRoot = sandboxRuntimeCacheRoot(gsapHome);
  if (isInsideRuntimeRoot(sourceRoot, cacheRoot)) return sourceRoot;

  const manifest = runtimeManifest({ sourceRoot, primaryPath, kind });
  const targetRoot = joinRuntimePath(cacheRoot, stableCacheName({ sourceRoot, primaryPath, kind, manifest }));
  const markerPath = joinRuntimePath(targetRoot, MARKER_FILE);

  if (fs.existsSync(targetRoot) && manifestMatches(markerPath, manifest)) return targetRoot;

  copyRuntimeTree({ sourceRoot, targetRoot, markerPath, manifest });
  return targetRoot;
}

export function sandboxRuntimeCacheRoot(gsapHome) {
  if (!gsapHome) throw new Error("[win32-sandbox] GSAP_HOME is required for sandbox runtime cache.");
  return joinRuntimePath(gsapHome, ".ephemeral", CACHE_DIR);
}

export function prepareSandboxRuntime(runtimeInfo, { gsapHome, hanakoHome, kind }) {
  const home = gsapHome || hanakoHome;
  if (!runtimeInfo) return runtimeInfo;
  const sourceRoot = runtimeSourceRoot(runtimeInfo);
  const primaryPath = runtimePrimaryPath(runtimeInfo);
  const targetRoot = ensureCachedRuntimeRoot({ sourceRoot, primaryPath, gsapHome: home, kind });
  if (targetRoot === sourceRoot) return runtimeInfo;

  return {
    ...runtimeInfo,
    bundledRoot: runtimeInfo.bundledRoot ? targetRoot : runtimeInfo.bundledRoot,
    git: rewriteRuntimePath(runtimeInfo.git, sourceRoot, targetRoot),
    shell: rewriteRuntimePath(runtimeInfo.shell, sourceRoot, targetRoot),
    executable: rewriteRuntimePath(runtimeInfo.executable, sourceRoot, targetRoot),
  };
}
