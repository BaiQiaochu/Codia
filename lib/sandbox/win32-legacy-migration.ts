// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { spawn as defaultSpawn } from "child_process";
import {
  buildWin32GsapWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
} from "./win32-legacy-maintenance.ts";
import {
  resolveWin32SandboxHelper,
} from "./win32-sandbox-helper.ts";

const LEGACY_PROFILE_PREFIXES = ["com.gsap.sandbox.", "com.hanako.sandbox."];
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const MIGRATION_MARKER_VERSION = 2;

function isWin32PathLike(value) {
  return /^[a-z]:[\\/]|^\\\\/i.test(String(value || ""));
}

function joinWin32Aware(root, ...segments) {
  if (!root) return null;
  return isWin32PathLike(root)
    ? path.win32.join(root, ...segments)
    : path.join(root, ...segments);
}

function normalizeWin32Aware(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = isWin32PathLike(raw) ? path.win32.normalize(raw) : path.resolve(raw);
  return normalized.replace(/[\\/]+$/g, (suffix) => {
    if (/^[a-z]:[\\/]$/i.test(normalized)) return suffix.slice(0, 1);
    if (normalized === "/" || normalized === "\\") return suffix.slice(0, 1);
    return "";
  });
}

function pushExistingUnique(out, seen, raw, existsSync) {
  const normalized = normalizeWin32Aware(raw);
  if (!normalized) return;
  if (!existsSync(normalized)) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(normalized);
}

export function isLegacyWin32SandboxProfileName(name) {
  if (typeof name !== "string") return false;
  return LEGACY_PROFILE_PREFIXES.some((prefix) => {
    if (!name.toLowerCase().startsWith(prefix)) return false;
    const rest = name.slice(prefix.length);
    const parts = rest.split(".");
    return parts.length === 2 && parts.every((part) => /^\d+$/.test(part));
  });
}

function packagesRoots({ env, homedir }) {
  const roots = [];
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, "Packages"));
  const home = env.USERPROFILE || homedir?.();
  if (home) roots.push(path.win32.join(home, "AppData", "Local", "Packages"));
  return [...new Set(roots.filter(Boolean).map((p) => path.win32.normalize(p)))];
}

function discoverLegacyProfileNames({ env, readdirSync, existsSync, homedir }) {
  const names = [];
  const seen = new Set();
  for (const root of packagesRoots({ env, homedir })) {
    if (!existsSync(root)) continue;
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries || []) {
      const name = typeof entry === "string" ? entry : entry?.name;
      if (!isLegacyWin32SandboxProfileName(name)) continue;
      if (entry && typeof entry !== "string" && typeof entry.isDirectory === "function" && !entry.isDirectory()) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

export function collectWin32LegacySandboxMigrationTargets({
  platform = process.platform,
  gsapHome,
  hanakoHome,
  workspaceRoots = [],
  env = process.env,
  resourcesPath = process.resourcesPath,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  homedir = os.homedir,
} = {}) {
  if (platform !== "win32") return { aclPaths: [], profileNames: [] };

  const home = gsapHome || hanakoHome;
  const aclPaths = [];
  const seen = new Set();
  const push = (target) => pushExistingUnique(aclPaths, seen, target, existsSync);

  if (home) {
    push(home);
    push(joinWin32Aware(home, ".ephemeral"));
    push(joinWin32Aware(home, "agents"));
    push(joinWin32Aware(home, "session-files"));
    push(joinWin32Aware(home, "uploads"));
  }
  for (const root of workspaceRoots || []) push(root);
  if (resourcesPath) {
    push(resourcesPath);
    push(joinWin32Aware(resourcesPath, "git"));
  }
  push(env.USERPROFILE);
  try { push(homedir?.()); } catch {}

  return {
    aclPaths,
    profileNames: discoverLegacyProfileNames({ env, readdirSync, existsSync, homedir }),
  };
}

function appendChunk(current, chunk, maxBytes) {
  const next = current + String(chunk || "");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) return next;
  return next.slice(0, maxBytes) + "\n[truncated]";
}

function runHelper(helperPath, args, {
  spawn = defaultSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    const timer = setTimeout(() => {
      try { child?.kill?.(); } catch {}
      finish({ code: null, timedOut: true });
    }, timeoutMs);

    try {
      child = spawn(helperPath, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: null, error: err });
      return;
    }

    child.stdout?.on?.("data", (chunk) => {
      stdout = appendChunk(stdout, chunk, maxOutputBytes);
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr = appendChunk(stderr, chunk, maxOutputBytes);
    });
    child.on?.("error", (err) => finish({ code: null, error: err }));
    child.on?.("close", (code) => finish({ code }));
  });
}

function defaultMigrationMarkerPath(gsapHome) {
  return gsapHome
    ? path.join(gsapHome, "user", "win32-sandbox-migration-v2.json")
    : null;
}

function hasCompletedMarker(markerPath) {
  if (!markerPath) return false;
  try {
    const data = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    return data?.version === MIGRATION_MARKER_VERSION && data?.status === "completed";
  } catch {
    return false;
  }
}

function writeCompletedMarker(markerPath, payload) {
  if (!markerPath) return;
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: MIGRATION_MARKER_VERSION,
    status: "completed",
    completedAt: new Date().toISOString(),
    ...payload,
  }, null, 2));
  fs.renameSync(tmp, markerPath);
}

function buildMigrationPhases({ targets, cleanup }) {
  const phases = [];
  const profileNames = targets.profileNames || [];
  if (targets.aclPaths?.length) {
    const args = [];
    if (cleanup) {
      args.push(...buildWin32GsapWriteAclCleanupArgs({ paths: targets.aclPaths }));
      for (const name of profileNames) args.push("--legacy-appcontainer-profile", name);
    }
    args.push(...buildWin32LegacyAclDiagnosticArgs({
      cleanup,
      paths: targets.aclPaths,
    }));
    phases.push({ name: "acl-cleanup", args });
  }
  if (cleanup && profileNames.length) {
    phases.push({
      name: "profile-cleanup",
      args: buildWin32LegacyProfileCleanupArgs({ profileNames }),
    });
  }
  return phases;
}

function combineOutput(results, stream) {
  return results.map((result) => result[stream]).filter(Boolean).join("");
}

function helperExitStatus(code) {
  if (code === 0) return "clean";
  if (code === 3) return "findings";
  return "failed";
}

export async function runWin32LegacySandboxMigration({
  platform = process.platform,
  gsapHome,
  hanakoHome,
  workspaceRoots = [],
  cleanup = false,
  markerPath,
  targets,
  helperPath,
  resolveHelper = resolveWin32SandboxHelper,
  env = process.env,
  spawn = defaultSpawn,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  resourcesPath = process.resourcesPath,
  homedir = os.homedir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") return { status: "skipped", reason: "platform" };

  const home = gsapHome || hanakoHome;
  const completionMarkerPath = cleanup ? (markerPath || defaultMigrationMarkerPath(home)) : null;
  if (hasCompletedMarker(completionMarkerPath)) {
    return {
      status: "skipped",
      reason: "already-completed",
      cleanup,
      markerPath: completionMarkerPath,
    };
  }

  const helper = helperPath || resolveHelper({ env, resourcesPath, existsSync });
  if (!helper) return { status: "skipped", reason: "helper-unavailable" };

  const resolvedTargets = targets || collectWin32LegacySandboxMigrationTargets({
    platform,
    gsapHome: home,
    workspaceRoots,
    env,
    resourcesPath,
    existsSync,
    readdirSync,
    homedir,
  });
  const phases = buildMigrationPhases({ targets: resolvedTargets, cleanup });
  if (phases.length === 0) {
    const result = {
      status: "clean",
      cleanup,
      helperPath: helper,
      markerPath: completionMarkerPath,
      targets: resolvedTargets,
      exitCode: 0,
      phaseResults: [],
    };
    if (cleanup) writeCompletedMarker(completionMarkerPath, { result });
    return result;
  }

  const phaseResults = [];
  for (const phase of phases) {
    const helperResult = await runHelper(helper, phase.args, { spawn, timeoutMs });
    const phaseResult = {
      phase: phase.name,
      args: phase.args,
      exitCode: helperResult.code,
      stdout: helperResult.stdout || "",
      stderr: helperResult.stderr || "",
      timedOut: helperResult.timedOut || undefined,
      error: helperResult.error?.message || undefined,
    };
    phaseResults.push(phaseResult);

    if (helperResult.error || helperResult.timedOut) {
      return {
        status: "failed",
        cleanup,
        helperPath: helper,
        markerPath: completionMarkerPath,
        targets: resolvedTargets,
        phaseResults,
        ...helperResult,
        error: helperResult.error?.message || (helperResult.timedOut ? "timeout" : "helper failed"),
      };
    }

    if (helperExitStatus(helperResult.code) === "failed") {
      return {
        status: "failed",
        cleanup,
        helperPath: helper,
        markerPath: completionMarkerPath,
        targets: resolvedTargets,
        phaseResults,
        exitCode: helperResult.code,
        stdout: combineOutput(phaseResults, "stdout"),
        stderr: combineOutput(phaseResults, "stderr"),
      };
    }
  }

  const status = phaseResults.some((result) => result.exitCode === 3) ? "findings" : "clean";
  const result = {
    status,
    cleanup,
    helperPath: helper,
    markerPath: completionMarkerPath,
    targets: resolvedTargets,
    exitCode: phaseResults.at(-1)?.exitCode ?? 0,
    phaseResults,
    stdout: combineOutput(phaseResults, "stdout"),
    stderr: combineOutput(phaseResults, "stderr"),
  };
  if (cleanup) writeCompletedMarker(completionMarkerPath, { result });
  return result;
}

export function summarizeWin32LegacySandboxMigration(result) {
  if (!result) return "no result";
  if (result.status === "skipped") return `skipped (${result.reason})`;
  const aclCount = result.targets?.aclPaths?.length || 0;
  const profileCount = result.targets?.profileNames?.length || 0;
  return `${result.status}; cleanup=${result.cleanup ? "on" : "off"}; aclPaths=${aclCount}; profiles=${profileCount}`;
}
