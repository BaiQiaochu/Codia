const fs = require("fs");
const path = require("path");

const CRITICAL_BUNDLED_EXTERNALS = [
  "ws",
  "better-sqlite3",
  "qrcode",
];

const CRITICAL_BUNDLED_FILES = [
  "bootstrap.js",
  "bundle/index.js",
];

const DEFAULT_BACKOFF_MS = [200, 500, 1000, 2000, 4000, 8000];
const SERVER_INFO_FIRST_WAIT_MS = 90_000;
const SERVER_INFO_PROGRESS_GRACE_MS = 180_000;
const SERVER_INFO_MAX_WAIT_MS = 5 * 60_000;

async function ensureServerFilesReady(serverRoot, opts = {}) {
  const backoffMs = opts.backoffMs || DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const start = Date.now();

  const checkOnce = () => {
    const missing = [];
    for (const file of CRITICAL_BUNDLED_FILES) {
      const filePath = path.join(serverRoot, ...file.split("/"));
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch {
        missing.push(file);
      }
    }
    for (const pkg of CRITICAL_BUNDLED_EXTERNALS) {
      const pkgJson = path.join(serverRoot, "node_modules", pkg, "package.json");
      try {
        fs.accessSync(pkgJson, fs.constants.R_OK);
      } catch {
        missing.push(`node_modules/${pkg}/package.json`);
      }
    }
    return missing;
  };

  let missing = checkOnce();
  if (missing.length === 0) return { ok: true };

  if (opts.onRetry) opts.onRetry(missing);
  for (const wait of backoffMs) {
    await sleep(wait);
    missing = checkOnce();
    if (missing.length === 0) return { ok: true };
  }

  return { ok: false, missing, waitedMs: Date.now() - start };
}

function isModuleResolutionError(stderrLogs) {
  if (!Array.isArray(stderrLogs) || stderrLogs.length === 0) return null;
  const joined = stderrLogs.join("");
  const match = joined.match(/Cannot find (?:package|module) ['"]([^'"]+)['"]/);
  if (match) return match[1];
  if (joined.includes("ERR_MODULE_NOT_FOUND")) return "unknown-module";
  return null;
}

function normalizeListenStartupPayload(value) {
  if (!value || (value.code !== "PORT_IN_USE" && value.code !== "LISTEN_PERMISSION_DENIED")) return null;
  const port = Number(value.port);
  return {
    code: value.code,
    host: typeof value.host === "string" && value.host ? value.host : "unknown",
    port: Number.isInteger(port) ? port : null,
    networkMode: typeof value.networkMode === "string" && value.networkMode ? value.networkMode : "unknown",
    listenHost: typeof value.listenHost === "string" && value.listenHost ? value.listenHost : undefined,
    suggestions: Array.isArray(value.suggestions)
      ? value.suggestions.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : [],
  };
}

function parsePortInUseStartupError(stderrLogs) {
  if (!Array.isArray(stderrLogs) || stderrLogs.length === 0) return null;
  const joined = stderrLogs.join("");
  const marker = "[server] startup-error ";
  const markerIndex = joined.indexOf(marker);
  if (markerIndex >= 0) {
    const afterMarker = joined.slice(markerIndex + marker.length);
    const line = afterMarker.split(/\r?\n/, 1)[0]?.trim();
    try {
      const parsed = JSON.parse(line);
      if (parsed?.code === "PORT_IN_USE" || parsed?.code === "LISTEN_PERMISSION_DENIED") {
        return normalizeListenStartupPayload(parsed);
      }
    } catch {}
  }

  const eaddrMatch = joined.match(/EADDRINUSE[^,\n]*?(?:address already in use\s*)?([^\s:]+):(\d+)/i);
  if (eaddrMatch) {
    return normalizeListenStartupPayload({
      code: "PORT_IN_USE",
      host: eaddrMatch[1],
      port: Number(eaddrMatch[2]),
      networkMode: "unknown",
      suggestions: [],
    });
  }

  const eaccesMatch = joined.match(/EACCES[^,\n]*?(?:permission denied\s*)?([^\s:]+):(\d+)/i);
  if (!eaccesMatch) return null;
  return normalizeListenStartupPayload({
    code: "LISTEN_PERMISSION_DENIED",
    host: eaccesMatch[1],
    port: Number(eaccesMatch[2]),
    networkMode: "unknown",
    suggestions: [],
  });
}

function extractRootServerStartupError(stderrLogs) {
  const listenError = parsePortInUseStartupError(stderrLogs);
  if (listenError) {
    const suggestions = listenError.suggestions.length
      ? ` Suggestions: ${listenError.suggestions.join(" ")}`
      : "";
    const unknownCause = listenError.networkMode === "unknown"
      ? (listenError.code === "PORT_IN_USE" ? " (EADDRINUSE)" : " (EACCES)")
      : "";
    const detail = listenError.code === "PORT_IN_USE"
      ? "is already in use"
      : "cannot be listened on";
    return `${listenError.code}${unknownCause}: ${listenError.host}:${listenError.port} ${detail} (network mode: ${listenError.networkMode}).${suggestions}`;
  }

  if (!Array.isArray(stderrLogs) || stderrLogs.length === 0) return null;
  return stderrLogs
    .join("")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[stderr\]\s*/, "").trim())
    .find((line) => /EADDRINUSE|EACCES/i.test(line)) || null;
}

function shouldKeepWaitingForServerInfo({
  nowMs,
  startedAtMs,
  firstDeadlineMs,
  lastProgressAtMs,
  childAlive,
  progressGraceMs = SERVER_INFO_PROGRESS_GRACE_MS,
  maxWaitMs = SERVER_INFO_MAX_WAIT_MS,
}) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(startedAtMs) || !Number.isFinite(firstDeadlineMs)) {
    return false;
  }
  if (nowMs <= firstDeadlineMs) return true;
  if (!childAlive) return false;
  if (nowMs - startedAtMs >= maxWaitMs) return false;
  if (!Number.isFinite(lastProgressAtMs)) return false;
  return nowMs - lastProgressAtMs <= progressGraceMs;
}

module.exports = {
  CRITICAL_BUNDLED_FILES,
  CRITICAL_BUNDLED_EXTERNALS,
  SERVER_INFO_FIRST_WAIT_MS,
  SERVER_INFO_PROGRESS_GRACE_MS,
  SERVER_INFO_MAX_WAIT_MS,
  ensureServerFilesReady,
  isModuleResolutionError,
  parsePortInUseStartupError,
  extractRootServerStartupError,
  shouldKeepWaitingForServerInfo,
};
