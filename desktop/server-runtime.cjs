const fs = require("fs");
const path = require("path");

function resolvePlatformDirName(platform = process.platform) {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return platform;
}

function getDistServerRoot({
  projectRoot = path.resolve(__dirname, ".."),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return path.join(projectRoot, "dist-server", `${resolvePlatformDirName(platform)}-${arch}`);
}

function resolveServerBinary(serverRoot, platform = process.platform) {
  if (!serverRoot) return "";
  const binaryNames = platform === "win32"
    ? ["gsap-server.exe", "hana-server.exe"]
    : ["gsap-server", "hana-server"];
  for (const name of binaryNames) {
    const binary = path.join(serverRoot, name);
    if (fs.existsSync(binary)) return binary;
  }
  return "";
}

function buildWrappedServerArgs(serverBin, platform = process.platform) {
  if (platform !== "win32") return [];
  return [path.join(path.dirname(serverBin), "bootstrap.js")];
}

function buildBundledServerEntry(serverRoot) {
  return path.join(serverRoot, "bundle", "index.js");
}

function parseNodeMajor(nodeVersion = process.versions.node) {
  const match = String(nodeVersion || "").match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function supportsRawTypeScript(env = process.env) {
  return parseNodeMajor(env.GSAP_LAUNCH_NODE_VERSION || process.versions.node) >= 24;
}

function buildSourceBootstrap(sourceRoot) {
  const tsBootstrap = path.join(sourceRoot, "server", "bootstrap.ts");
  const jsBootstrap = path.join(sourceRoot, "server", "bootstrap.js");
  if (fs.existsSync(tsBootstrap)) return tsBootstrap;
  if (fs.existsSync(jsBootstrap)) return jsBootstrap;
  return fs.existsSync(path.join(sourceRoot, "server", "index.ts")) ? tsBootstrap : jsBootstrap;
}

function withServerEntryEnv(baseEnv, entry) {
  return {
    ...baseEnv,
    GSAP_SERVER_ENTRY: entry,
    HANA_SERVER_ENTRY: entry,
  };
}

function pathListDelimiter(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}

function prependPathEntries(env, entries, platform = process.platform) {
  const validEntries = [...new Set((entries || []).filter(Boolean))];
  if (validEntries.length === 0) return { ...env };

  const next = { ...env };
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === "path") || "PATH";
  const existingPath = next[pathKey] || "";
  if (pathKey !== "PATH") delete next[pathKey];

  const delimiter = pathListDelimiter(platform);
  const existingEntries = String(existingPath)
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => !validEntries.some((candidate) => {
      return platform === "win32"
        ? candidate.toLowerCase() === entry.toLowerCase()
        : candidate === entry;
    }));

  next.PATH = [...validEntries, ...existingEntries].join(delimiter);
  return next;
}

function withServerBinaryPaths(baseEnv, serverRoot, platform = process.platform) {
  const ffmpegBinary = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const ffmpegDir = serverRoot ? path.join(serverRoot, "ffmpeg") : "";
  const extraPaths = fs.existsSync(path.join(ffmpegDir, ffmpegBinary)) ? [ffmpegDir] : [];
  return prependPathEntries(baseEnv, extraPaths, platform);
}

function resolveNodePath(env = process.env) {
  const candidates = [
    env.GSAP_LAUNCH_NODE,
    env.npm_node_execpath,
    env.NODE,
    env.NODE_EXE_PATH,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) return resolved;
    } catch {
      // Ignore invalid candidates.
    }
  }

  return "";
}

function resolveServerLaunchConfig({
  env = process.env,
  projectRoot = path.resolve(__dirname, ".."),
  resourcesPath = process.resourcesPath || "",
  platform = process.platform,
  arch = process.arch,
  electronExecPath = process.execPath,
} = {}) {
  const mode = String(env.GSAP_DESKTOP_SERVER_MODE || "auto").trim().toLowerCase();
  const sourceRoot = projectRoot;
  const sourceEntryJs = path.join(sourceRoot, "server", "index.js");
  const sourceEntryTs = path.join(sourceRoot, "server", "index.ts");
  const sourceEntry = fs.existsSync(sourceEntryTs) ? sourceEntryTs : sourceEntryJs;
  const sourceEntryIsTs = sourceEntry.endsWith(".ts");
  const canUseRawTypeScript = !sourceEntryIsTs || supportsRawTypeScript(env);
  const safeSourceEntry = canUseRawTypeScript
    ? sourceEntry
    : path.join(sourceRoot, "dist-server-bundle", "index.js");
  const packagedRoot = resourcesPath ? path.join(resourcesPath, "server") : "";
  const packagedBin = resolveServerBinary(packagedRoot, platform);

  if (packagedBin) {
    return {
      kind: "bundled",
      serverBin: packagedBin,
      serverArgs: buildWrappedServerArgs(packagedBin, platform),
      serverRoot: packagedRoot,
      serverEnv: withServerBinaryPaths(withServerEntryEnv({
        ...env,
        GSAP_ROOT: packagedRoot,
        HANA_ROOT: packagedRoot,
      }, buildBundledServerEntry(packagedRoot)), packagedRoot, platform),
    };
  }

  const sourceNode = resolveNodePath(env);
  const canUseSourceNode = Boolean(
    sourceNode
    && fs.existsSync(sourceEntry)
    && canUseRawTypeScript,
  );
  const distRoot = getDistServerRoot({ projectRoot, platform, arch });
  const distBin = resolveServerBinary(distRoot, platform);
  const canUseDist = Boolean(distBin);

  if (mode !== "dist" && canUseSourceNode) {
    return {
      kind: "dev-source-node",
      serverBin: sourceNode,
      serverArgs: [buildSourceBootstrap(sourceRoot)],
      serverRoot: sourceRoot,
      serverEnv: withServerEntryEnv({
        GSAP_ROOT: sourceRoot,
        HANA_ROOT: sourceRoot,
      }, safeSourceEntry),
    };
  }

  if (canUseDist) {
    return {
      kind: "dev-dist-server",
      serverBin: distBin,
      serverArgs: buildWrappedServerArgs(distBin, platform),
      serverRoot: distRoot,
      serverEnv: withServerBinaryPaths(withServerEntryEnv({
        ...env,
        GSAP_ROOT: distRoot,
        HANA_ROOT: distRoot,
      }, buildBundledServerEntry(distRoot)), distRoot, platform),
    };
  }

  if (mode === "source" && canUseSourceNode) {
    return {
      kind: "dev-source-node",
      serverBin: sourceNode,
      serverArgs: [buildSourceBootstrap(sourceRoot)],
      serverRoot: sourceRoot,
      serverEnv: withServerEntryEnv({
        GSAP_ROOT: sourceRoot,
        HANA_ROOT: sourceRoot,
      }, safeSourceEntry),
    };
  }

  return {
    kind: "dev-electron-node",
    serverBin: electronExecPath,
    serverArgs: [buildSourceBootstrap(sourceRoot)],
    serverRoot: sourceRoot,
    serverEnv: withServerEntryEnv({
      ELECTRON_RUN_AS_NODE: "1",
      GSAP_ROOT: sourceRoot,
      HANA_ROOT: sourceRoot,
    }, safeSourceEntry),
  };
}

module.exports = {
  buildBundledServerEntry,
  buildSourceBootstrap,
  buildWrappedServerArgs,
  getDistServerRoot,
  prependPathEntries,
  resolveNodePath,
  resolvePlatformDirName,
  resolveServerBinary,
  resolveServerLaunchConfig,
  withServerBinaryPaths,
};
