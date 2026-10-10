// @ts-nocheck
import { existsSync } from "fs";
import path, { dirname, join, resolve } from "path";
import { spawnSync } from "child_process";
import { spawnAndStream } from "./exec-helper.ts";
import { classifyWin32Command } from "./win32-command-router.ts";
import { assertSafeWin32BashCommand } from "./win32-bash-guard.ts";
import { buildWin32SandboxGrants } from "./win32-policy.ts";
import {
  buildWin32SandboxHelperArgs,
  resolveWin32SandboxHelper,
  resourceSiblingDir,
} from "./win32-sandbox-helper.ts";
import { prepareSandboxRuntime } from "./win32-runtime-cache.ts";
import { assertExecutionCwd } from "../shell/execution-cwd.ts";
import {
  quoteCmdArg,
  resolveWin32DefaultPowerShellExecutable,
  resolveWin32PowerShellExecutable,
  splitShellLikeArgs as splitShellLikeArgsBase,
} from "../shell/shell-utils.ts";

export interface Win32ExecResult {
  exitCode: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

export interface Win32ExecOptions {
  onData?: (chunk: unknown) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, any>;
}

export type Win32Exec = (
  command: string,
  cwd: string,
  options: Win32ExecOptions,
) => Promise<Win32ExecResult>;

export interface Win32ExecFactoryOptions {
  sandbox?: any;
}

let _cachedShell = null;

const PROBE_TOKEN = "__codia_probe_ok__";
const PYTHON_COMMANDS = new Set(["python", "python.exe", "python3", "python3.exe"]);
const NODE_COMMANDS = new Set(["node", "node.exe"]);
const POWERSHELL_COMMANDS = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const DRIVE_LETTERS = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const SPAWN_ERROR_CODES = new Set(["ENOENT", "EACCES", "EPERM", "UNKNOWN"]);

function probeShell(shell, args) {
  try {
    const result = spawnSync(shell, [...args, `echo ${PROBE_TOKEN}`], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = (result.stdout || "").trim();
    return result.status === 0 && stdout.length > 0 && stdout.includes(PROBE_TOKEN);
  } catch {
    return false;
  }
}

function looksLikeWin32Path(value) {
  return /^[a-z]:[\\/]/i.test(String(value || "")) || /^\\\\/.test(String(value || ""));
}

function joinPath(root, ...parts) {
  return looksLikeWin32Path(root) ? path.win32.join(root, ...parts) : join(root, ...parts);
}

function resolveSibling(root, ...parts) {
  return looksLikeWin32Path(root) ? path.win32.resolve(root, ...parts) : resolve(root, ...parts);
}

function shellRoot(shell) {
  const value = String(shell || "");
  const parts = value.split(/[\\/]+/);
  const index = parts.findIndex((part) => {
    const lower = part.toLowerCase();
    return lower === "git" || lower === "git-portable";
  });
  if (index < 0) return null;
  const prefix = value.startsWith("\\\\") ? "\\\\" : "";
  const joined = parts.slice(0, index + 1).join(path.sep);
  return prefix ? prefix + joined.replace(/^\\+/, "") : joined;
}

function basenameRuntimePath(filePath) {
  return looksLikeWin32Path(filePath) ? path.win32.basename(filePath) : path.basename(filePath);
}

function dirnameRuntimePath(filePath) {
  return looksLikeWin32Path(filePath) ? path.win32.dirname(filePath) : dirname(filePath);
}

function pushUniqueRuntimePath(list, item) {
  if (!item) return;
  const key = String(item).toLowerCase();
  if (list.some(existing => String(existing).toLowerCase() === key)) return;
  list.push(item);
}

function pushCandidate(found, shell, label, extra = {}) {
  if (existsSync(shell) && !found.some(c => c.shell === shell)) {
    found.push({ shell, args: ["-c"], label, ...extra });
  }
}

function pushUniqueCandidate(found, candidate) {
  if (!candidate?.shell || found.some(c => c.shell === candidate.shell)) return;
  found.push(candidate);
}

function getBundledShellCandidates(env = process.env, deps = {}) {
  const found = [];
  const roots = [];
  const resourcesPath = deps.resourcesPath !== undefined ? deps.resourcesPath : process.resourcesPath;
  const resolveResourceSibling = deps.resourceSiblingDir || ((name, options) => resourceSiblingDir(name, options));
  const exists = deps.exists || existsSync;
  if (resourcesPath) roots.push(joinPath(resourcesPath, "git"));
  if (env.CODIA_ROOT) roots.push(resolveSibling(env.CODIA_ROOT, "..", "git"));
  const siblingGit = resolveResourceSibling("git", { env, resourcesPath });
  if (siblingGit) roots.push(siblingGit);
  roots.push(join(process.cwd(), "vendor", "git-portable"));

  const uniqueRoots = [...new Set(roots.filter(Boolean))];
  for (const root of uniqueRoots) {
    const shellCandidates = [
      { relative: ["bin", "bash.exe"], args: ["-lc"] },
      { relative: ["usr", "bin", "bash.exe"], args: ["-lc"] },
      { relative: ["mingw64", "bin", "bash.exe"], args: ["-lc"] },
      { relative: ["usr", "bin", "sh.exe"], args: ["-c"] },
      { relative: ["usr", "bin", "ash.exe"], args: ["-c"] },
      { relative: ["mingw64", "bin", "sh.exe"], args: ["-c"] },
      { relative: ["mingw64", "bin", "ash.exe"], args: ["-c"] },
      { relative: ["mingw64", "bin", "busybox.exe"], args: ["sh", "-c"] },
      { relative: ["cmd", "ash.exe"], args: ["-c"] },
    ];
    for (const candidate of shellCandidates) {
      const shell = joinPath(root, ...candidate.relative);
      if (exists(shell) && !found.some(c => c.shell === shell)) {
        found.push({ shell, args: candidate.args, label: `Bundled Git shell (${shell})`, bundledRoot: root });
      }
    }
  }
  return found;
}

function getBundledGitCandidates(env = process.env) {
  const roots = [];
  if (process.resourcesPath) roots.push(join(process.resourcesPath, "git"));
  if (env.CODIA_ROOT) roots.push(resolveSibling(env.CODIA_ROOT, "..", "git"));
  const siblingGit = resourceSiblingDir("git", { env });
  if (siblingGit) roots.push(siblingGit);
  roots.push(join(process.cwd(), "vendor", "git-portable"));

  const found = [];
  for (const root of [...new Set(roots.filter(Boolean))]) {
    for (const rel of [
      ["cmd", "git.exe"],
      ["mingw64", "bin", "git.exe"],
    ]) {
      const git = joinPath(root, ...rel);
      if (existsSync(git) && !found.some(c => c.git === git)) {
        found.push({ git, label: `Bundled PortableGit git.exe (${git})`, bundledRoot: root });
      }
    }
  }
  return found;
}

function getAllGitCandidates({ bundledOnly = false, env = process.env } = {}) {
  const found = [...getBundledGitCandidates(env)];
  if (bundledOnly) return found;

  const addIfExists = (git, label) => {
    if (!git || !existsSync(git)) return;
    if (found.some(c => String(c.git).toLowerCase() === String(git).toLowerCase())) return;
    found.push({ git, label });
  };

  try {
    const result = spawnSync("where", ["git.exe"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate) continue;
        addIfExists(candidate, `PATH git.exe (${candidate})`);
        if (found.some(c => c.git === candidate)) break;
      }
    }
  } catch {}

  const roots = [];
  if (env.ProgramFiles) roots.push(`${env.ProgramFiles}\\Git`);
  if (env["ProgramFiles(x86)"]) roots.push(`${env["ProgramFiles(x86)"]}\\Git`);
  if (env.LOCALAPPDATA) roots.push(`${env.LOCALAPPDATA}\\Programs\\Git`);
  if (env.USERPROFILE) roots.push(`${env.USERPROFILE}\\scoop\\apps\\git\\current`);
  for (const d of DRIVE_LETTERS) roots.push(`${d}:\\Git`);
  for (const root of roots) addIfExists(`${root}\\cmd\\git.exe`, `Git for Windows (${root}\\cmd\\git.exe)`);

  return found;
}

function findGitRuntime({ env = process.env, bundledOnly = false } = {}) {
  const runtime = getAllGitCandidates({ env, bundledOnly })[0] || null;
  if (runtime) return runtime;
  if (bundledOnly) {
    throw new Error(
      "[win32-exec] Sandboxed Git commands require bundled Git runtime, " +
      "but resources/git/cmd/git.exe was not found. Rebuild the Windows package with vendor/git-portable."
    );
  }
  throw new Error("[win32-exec] No usable git.exe found. Install Git for Windows or rebuild Codia with bundled PortableGit.");
}

function getAllShellCandidates({ preferBundled = true, bundledOnly = false, env = process.env } = {}) {
  const found = [];
  const bundled = getBundledShellCandidates(env);
  if (preferBundled) {
    for (const candidate of bundled) pushUniqueCandidate(found, candidate);
    if (found.length > 0) return found;
  }
  if (bundledOnly) return found;

  const gitBashPaths = [];
  if (process.env.ProgramFiles) gitBashPaths.push(`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`);
  if (process.env["ProgramFiles(x86)"]) gitBashPaths.push(`${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`);
  if (process.env.LOCALAPPDATA) gitBashPaths.push(`${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`);
  if (process.env.USERPROFILE) gitBashPaths.push(`${process.env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`);
  for (const d of DRIVE_LETTERS) gitBashPaths.push(`${d}:\\Git\\bin\\bash.exe`);

  for (const p of gitBashPaths) pushCandidate(found, p, `Git Bash (${p})`);

  for (const regKey of [
    "HKLM\\SOFTWARE\\GitForWindows",
    "HKCU\\SOFTWARE\\GitForWindows",
    "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  ]) {
    try {
      const result = spawnSync("reg", ["query", regKey, "/v", "InstallPath"], {
        encoding: "utf-8",
        timeout: 5000,
        windowsHide: true,
      });
      if (result.status === 0 && result.stdout) {
        const match = result.stdout.match(/InstallPath\s+REG_SZ\s+(.+)/i);
        if (match) {
          const gitBash = joinPath(match[1].trim(), "bin", "bash.exe");
          pushCandidate(found, gitBash, `Git Bash via registry ${regKey} (${gitBash})`);
        }
      }
    } catch {}
  }

  if (!preferBundled) {
    for (const candidate of bundled) pushUniqueCandidate(found, candidate);
  }

  for (const name of ["bash.exe", "sh.exe"]) {
    try {
      const result = spawnSync("where", [name], { encoding: "utf-8", timeout: 5000, windowsHide: true });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.trim().split(/\r?\n/)) {
          const candidate = line.trim();
          if (!candidate || !existsSync(candidate)) continue;
          if (found.some(c => c.shell === candidate)) continue;
          const lower = candidate.toLowerCase();
          if (lower.includes("\\windows\\system32\\") || lower.includes("\\windows\\syswow64\\")) continue;
          found.push({ shell: candidate, args: ["-c"], label: `PATH ${name} (${candidate})`, bundledRoot: shellRoot(candidate) });
          break;
        }
      }
    } catch {}
  }

  for (const d of DRIVE_LETTERS) {
    for (const p of [
      `${d}:\\msys64\\usr\\bin\\bash.exe`,
      `${d}:\\cygwin64\\bin\\bash.exe`,
      `${d}:\\cygwin\\bin\\bash.exe`,
    ]) {
      pushCandidate(found, p, `MSYS2/Cygwin (${p})`);
    }
  }

  return found;
}

function findAndCacheShell(startAfter, options = {}) {
  if (_cachedShell && !startAfter && (!options.preferBundled || _cachedShell.bundledRoot)) return _cachedShell;

  const candidates = getAllShellCandidates(options);
  let startIdx = 0;
  if (startAfter) {
    const idx = candidates.findIndex(c => c.shell === startAfter);
    if (idx >= 0) startIdx = idx + 1;
  }

  const failures = [];
  for (let i = startIdx; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (probeShell(candidate.shell, candidate.args)) {
      _cachedShell = candidate;
      return candidate;
    }
    failures.push(candidate.label);
  }

  const allLabels = startAfter ? [`(previous candidates skipped)`, ...failures] : candidates.map(c => c.label);
  throw new Error(
    `[win32-exec] No usable bash-compatible shell found.\n` +
    `Tried (probe failed):\n${allLabels.map(s => `  - ${s}`).join("\n")}\n\n` +
    `Suggestions:\n` +
    `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
    `  2. Make sure bash.exe has execute permission\n` +
    `  3. If antivirus software is enabled, check whether it blocks bash.exe`
  );
}

function isShellSpawnError(err, shellPath) {
  if (!err || typeof err.code !== "string") return false;
  if (!SPAWN_ERROR_CODES.has(err.code)) return false;
  if (err.code === "ENOENT" && err.path && err.path !== shellPath) return false;
  return true;
}

function enrichError(retryErr, primaryShell, originalErr) {
  const msg = [
    `[win32-exec] Cannot execute shell command.`,
    ``,
    `Primary shell: ${primaryShell.label}`,
    `  Error: ${originalErr.message} (${originalErr.code || "unknown"})`,
    ``,
    `Fallback also failed: ${retryErr.message}`,
    ``,
    `Suggestions:`,
    `  1. Reinstall Git for Windows: https://git-scm.com/download/win`,
    `  2. Make sure bash.exe has execute permission`,
    `  3. If antivirus software is enabled, check whether it blocks bash.exe`,
  ].join("\n");

  const enriched = new Error(msg);
  enriched.code = originalErr.code;
  return enriched;
}

function cleanShellEnv(baseEnv) {
  const env = { ...baseEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function withWin32Utf8Defaults(baseEnv) {
  const env = cleanShellEnv(baseEnv);
  if (env.PYTHONUTF8 == null) env.PYTHONUTF8 = "1";
  if (env.PYTHONIOENCODING == null) env.PYTHONIOENCODING = "utf-8";
  if (env.LANG == null) env.LANG = "C.UTF-8";
  if (env.LC_ALL == null) env.LC_ALL = "C.UTF-8";
  return env;
}

function getShellEnv() {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return withWin32Utf8Defaults({ ...process.env, [pathKey]: process.env[pathKey] ?? "" });
}

function getBundledRuntimePathDirs(bundledRoot) {
  return [
    joinPath(bundledRoot, "bin"),
    joinPath(bundledRoot, "usr", "bin"),
    joinPath(bundledRoot, "mingw64", "bin"),
    joinPath(bundledRoot, "cmd"),
  ];
}

function getRuntimeEnvForCandidate(baseEnv, runtimeInfo) {
  const env = cleanShellEnv(baseEnv || {});
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = String(env[pathKey] ?? "");
  const delimiter = current.includes(";") || looksLikeWin32Path(runtimeInfo?.git || runtimeInfo?.shell || "") ? ";" : path.delimiter;
  const existing = new Set(current.split(delimiter).filter(Boolean).map((entry) => entry.toLowerCase()));
  const prepend = [];
  const executable = runtimeInfo?.git || runtimeInfo?.shell || runtimeInfo?.executable || null;
  const dirs = [
    executable ? dirnameRuntimePath(executable) : null,
    ...(runtimeInfo?.bundledRoot ? getBundledRuntimePathDirs(runtimeInfo.bundledRoot) : []),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const key = dir.toLowerCase();
    if (existing.has(key) || prepend.some((entry) => entry.toLowerCase() === key)) continue;
    prepend.push(dir);
  }
  env[pathKey] = [...prepend, ...current.split(delimiter).filter(Boolean)].join(delimiter);
  return env;
}

export function resolveWin32ShellRuntime(options = {}) {
  return findAndCacheShell(null, options);
}

export function getWin32ShellEnvForRuntime(baseEnv, runtimeInfo) {
  return getRuntimeEnvForCandidate(baseEnv, runtimeInfo);
}

function splitShellLikeArgs(command) {
  return splitShellLikeArgsBase(command, {
    throwOnUnterminated: true,
    errorPrefix: "[win32-exec]",
  });
}

function parseGitCommandArgs(command) {
  const args = splitShellLikeArgs(command);
  const commandName = basenameRuntimePath(args[0] || "").toLowerCase();
  if (commandName !== "git" && commandName !== "git.exe") {
    throw new Error(`[win32-exec] Internal error: git runner received non-git command: ${command}`);
  }
  return args.slice(1);
}

function isPowerShellCommandName(name) {
  return POWERSHELL_COMMANDS.has(String(name || "").toLowerCase());
}

function powerShellBaseArgs() {
  return ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass"];
}

function resolvePowerShellExecutable(token, env) {
  const raw = String(token || "");
  if (looksLikeWin32Path(raw) || raw.includes("\\") || raw.includes("/")) return raw;
  return resolveWin32PowerShellExecutable(raw, env);
}

function parsePowerShellCommand(command, env) {
  const args = splitShellLikeArgs(command);
  const token = args[0] || "";
  const commandName = basenameRuntimePath(token).toLowerCase();
  if (!isPowerShellCommandName(commandName)) {
    throw new Error(`[win32-exec] Internal error: PowerShell runner received non-PowerShell command: ${command}`);
  }
  return {
    executable: resolvePowerShellExecutable(token, env),
    args: [...powerShellBaseArgs(), ...args.slice(1)],
  };
}

function parsePowerShellFileCommand(command, env) {
  const args = splitShellLikeArgs(command);
  const script = args[0] || "";
  if (!/\.ps1$/i.test(basenameRuntimePath(script))) {
    throw new Error(`[win32-exec] Internal error: PowerShell file runner received non-.ps1 command: ${command}`);
  }
  return {
    executable: resolveWin32DefaultPowerShellExecutable(env),
    args: [...powerShellBaseArgs(), "-File", script, ...args.slice(1)],
  };
}

function parsePowerShellInlineCommand(command, env) {
  return {
    executable: resolveWin32DefaultPowerShellExecutable(env),
    args: [...powerShellBaseArgs(), "-Command", command],
  };
}

function cmdScriptCommand(command) {
  const args = splitShellLikeArgs(command);
  const script = args[0] || "";
  if (!/\.(?:bat|cmd)$/i.test(basenameRuntimePath(script))) {
    throw new Error(`[win32-exec] Internal error: CMD script runner received non-.bat/.cmd command: ${command}`);
  }
  return [
    quoteCmdArg(script, { always: true }),
    ...args.slice(1).map((arg) => quoteCmdArg(arg)),
  ].join(" ");
}

function normalizeRuntimePathForCompare(target) {
  const raw = String(target || "");
  return (looksLikeWin32Path(raw) ? path.win32.normalize(raw) : path.resolve(raw)).toLowerCase();
}

function runtimePathsEqual(a, b) {
  return normalizeRuntimePathForCompare(a) === normalizeRuntimePathForCompare(b);
}

function resolveRuntimePath(root, target) {
  return looksLikeWin32Path(root) || looksLikeWin32Path(target)
    ? path.win32.resolve(root || "", target)
    : resolve(root || "", target);
}

function isInsideRuntimeRoot(target, root) {
  if (!target || !root) return false;
  const winPath = looksLikeWin32Path(target) || looksLikeWin32Path(root);
  const targetNorm = normalizeRuntimePathForCompare(target);
  const rootNorm = normalizeRuntimePathForCompare(root);
  const rel = winPath ? path.win32.relative(rootNorm, targetNorm) : path.relative(rootNorm, targetNorm);
  const isAbs = winPath ? path.win32.isAbsolute(rel) : path.isAbsolute(rel);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbs);
}

function isPythonCommandName(name) {
  return PYTHON_COMMANDS.has(String(name || "").toLowerCase());
}

function isNodeCommandName(name) {
  return NODE_COMMANDS.has(String(name || "").toLowerCase());
}

function resolveExplicitExecutableToken(token, cwd) {
  const raw = String(token || "");
  if (!raw) return null;
  if (looksLikeWin32Path(raw)) return raw;
  if (/^\.{1,2}[\\/]/.test(raw) || raw.includes("\\") || raw.includes("/")) {
    return resolveRuntimePath(cwd, raw);
  }
  return null;
}

function executableInfoFromPath(executable, label, args = []) {
  return { executable, args, label };
}

function isUsableCurrentNodeRuntime(executable) {
  const base = basenameRuntimePath(executable).toLowerCase();
  return isNodeCommandName(base) && !!executable && existsSync(executable);
}

function findNodeRuntimeOnPath(commandName, args, env) {
  const candidates = [];
  if (env?.CODIA_DEV_NODE_BIN) {
    candidates.push(executableInfoFromPath(env.CODIA_DEV_NODE_BIN, `CODIA_DEV_NODE_BIN (${env.CODIA_DEV_NODE_BIN})`, args));
  }
  if (isUsableCurrentNodeRuntime(process.execPath)) {
    candidates.push(executableInfoFromPath(process.execPath, `Current Node runtime (${process.execPath})`, args));
  }

  try {
    const result = spawnSync("where", [commandName], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      env,
    });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate || !existsSync(candidate)) continue;
        if (!isNodeCommandName(basenameRuntimePath(candidate).toLowerCase())) continue;
        candidates.push(executableInfoFromPath(candidate, `PATH Node (${candidate})`, args));
      }
    }
  } catch {}

  for (const candidate of candidates) {
    const executable = candidate.executable;
    if (!executable || !existsSync(executable)) continue;
    return candidate;
  }
  return null;
}

function findNodeRuntime({ command, cwd, env = process.env } = {}) {
  const args = splitShellLikeArgs(command);
  const token = args[0] || "";
  const commandName = basenameRuntimePath(token).toLowerCase();
  if (!isNodeCommandName(commandName)) {
    throw new Error(`[win32-exec] Internal error: node runner received non-node command: ${command}`);
  }

  const explicit = resolveExplicitExecutableToken(token, cwd);
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`[win32-exec] Node executable not found: ${explicit}`);
    }
    if (!isInsideRuntimeRoot(explicit, cwd)) {
      const pathRuntime = findNodeRuntimeOnPath(commandName, args.slice(1), env);
      if (!pathRuntime || !runtimePathsEqual(pathRuntime.executable, explicit)) {
        throw new Error(
          `[win32-exec] Explicit Node executable is outside the workspace and not available on PATH: ${explicit}`
        );
      }
      return pathRuntime;
    }
    return { executable: explicit, args: args.slice(1), label: `Node (${explicit})` };
  }

  const pathRuntime = findNodeRuntimeOnPath(commandName, args.slice(1), env);
  if (pathRuntime) return pathRuntime;

  throw new Error(
    `[win32-exec] No usable Node runtime found for "${commandName}". ` +
    "Install Node.js, add it to PATH, or use an explicit node.exe path."
  );
}

function findPythonRuntimeOnPath(commandName, args, env) {
  try {
    const result = spawnSync("where", [commandName], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
      env,
    });
    if (result.status === 0 && result.stdout) {
      for (const line of result.stdout.trim().split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate || !existsSync(candidate)) continue;
        if (!isPythonCommandName(basenameRuntimePath(candidate).toLowerCase())) continue;
        return { executable: candidate, args, label: `PATH Python (${candidate})` };
      }
    }
  } catch {}
  return null;
}

function findPythonRuntime({ command, cwd, env = process.env } = {}) {
  const args = splitShellLikeArgs(command);
  const token = args[0] || "";
  const commandName = basenameRuntimePath(token).toLowerCase();
  if (!isPythonCommandName(commandName)) {
    throw new Error(`[win32-exec] Internal error: python runner received non-python command: ${command}`);
  }

  const explicit = resolveExplicitExecutableToken(token, cwd);
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`[win32-exec] Python executable not found: ${explicit}`);
    }
    if (!isInsideRuntimeRoot(explicit, cwd)) {
      const pathRuntime = findPythonRuntimeOnPath(commandName, args.slice(1), env);
      if (!pathRuntime || !runtimePathsEqual(pathRuntime.executable, explicit)) {
        throw new Error(
          `[win32-exec] Explicit Python executable is outside the workspace and not available on PATH: ${explicit}`
        );
      }
      return pathRuntime;
    }
    return { executable: explicit, args: args.slice(1), label: `Python (${explicit})` };
  }

  const pathRuntime = findPythonRuntimeOnPath(commandName, args.slice(1), env);
  if (pathRuntime) return pathRuntime;

  throw new Error(
    `[win32-exec] No usable Python runtime found for "${commandName}". ` +
    `Install Python, add it to PATH, or use an explicit python.exe path.`
  );
}

function runtimeReadPathsForBundledRuntime(runtimeInfo) {
  const paths = [];
  pushUniqueRuntimePath(paths, runtimeInfo?.bundledRoot);
  const executable = runtimeInfo?.git || runtimeInfo?.shell || runtimeInfo?.executable || null;
  pushUniqueRuntimePath(paths, executable);
  if (executable) pushUniqueRuntimePath(paths, dirnameRuntimePath(executable));
  if (runtimeInfo?.bundledRoot) {
    for (const dir of getBundledRuntimePathDirs(runtimeInfo.bundledRoot)) {
      pushUniqueRuntimePath(paths, dir);
    }
  }
  return paths;
}

function runtimeReadPathsForPythonRuntime(runtimeInfo) {
  const paths = [];
  const executable = runtimeInfo?.executable;
  pushUniqueRuntimePath(paths, executable);
  if (!executable) return paths;

  const executableDir = dirnameRuntimePath(executable);
  const runtimeRoot = basenameRuntimePath(executableDir).toLowerCase() === "scripts"
    ? dirnameRuntimePath(executableDir)
    : executableDir;

  pushUniqueRuntimePath(paths, executableDir);
  pushUniqueRuntimePath(paths, runtimeRoot);
  return paths;
}

function runtimeReadPathsForNodeRuntime(runtimeInfo) {
  const paths = [];
  const executable = runtimeInfo?.executable;
  pushUniqueRuntimePath(paths, executable);
  if (!executable) return paths;

  const executableDir = dirnameRuntimePath(executable);
  pushUniqueRuntimePath(paths, executableDir);
  return paths;
}

function cmdArgsForCommand(command) {
  return ["/d", "/s", "/c", `chcp 65001 >NUL & ${command}`];
}

function spawnViaCmd(command, cwd, { env, onData, signal, timeout }) {
  return spawnAndStream(process.env.COMSPEC || "cmd.exe", cmdArgsForCommand(command), {
    cwd,
    env,
    onData,
    signal,
    timeout,
  });
}

function sandboxIsEnabled(sandbox) {
  return !!sandbox;
}

function prepareRuntimeForSandbox(runtimeInfo, sandbox, kind) {
  if (!sandboxIsEnabled(sandbox)) return runtimeInfo;
  const codiaHome = sandbox.codiaHome || sandbox.codiaHome || null;
  if (!codiaHome) return runtimeInfo;
  return prepareSandboxRuntime(runtimeInfo, { codiaHome, kind });
}

function readOnlyRuntimeGrants(paths) {
  return { optionalReadPaths: paths || [] };
}

function fullRuntimeGrants(paths) {
  return { optionalWritePaths: paths || [] };
}

function grantsForSandbox(sandbox, cwd) {
  if (!sandbox) {
    return { readPaths: [], optionalReadPaths: [], writePaths: [], optionalWritePaths: [], denyReadPaths: [], denyWritePaths: [] };
  }
  if (sandbox.grants) {
    return {
      readPaths: sandbox.grants.readPaths || [],
      optionalReadPaths: sandbox.grants.optionalReadPaths || [],
      writePaths: sandbox.grants.writePaths || [],
      optionalWritePaths: sandbox.grants.optionalWritePaths || [],
      denyReadPaths: sandbox.grants.denyReadPaths || [],
      denyWritePaths: sandbox.grants.denyWritePaths || [],
    };
  }
  return buildWin32SandboxGrants({
    policy: sandbox.policy,
    cwd,
  });
}

function assertSandboxNetworkSupported(sandbox) {
  const mode = typeof sandbox.getSandboxNetworkMode === "function"
    ? sandbox.getSandboxNetworkMode()
    : null;
  const enabled = typeof sandbox.getSandboxNetworkEnabled === "function"
    ? sandbox.getSandboxNetworkEnabled()
    : true;

  if (mode === "none" || mode === false || !enabled) {
    throw new Error(
      "[win32-sandbox] Windows restricted-token sandbox does not support network-off mode. " +
      "Re-enable sandbox networking or disable the command sandbox explicitly."
    );
  }
}

function spawnViaSandboxHelper({ sandbox, executable, args, cwd, env, onData, signal, timeout }) {
  const helper = sandbox.helperPath || resolveWin32SandboxHelper({ env });
  if (!helper) {
    throw new Error(
      "[win32-sandbox] Windows restricted-token helper is unavailable. " +
      "Run scripts/build-windows-sandbox-helper.mjs during packaging, or disable sandbox explicitly."
    );
  }
  assertSandboxNetworkSupported(sandbox);
  const helperArgs = buildWin32SandboxHelperArgs({
    cwd,
    grants: grantsForSandbox(sandbox, cwd),
    executable,
    args,
  });
  return spawnAndStream(helper, helperArgs, { cwd, env, onData, signal, timeout });
}

export function createWin32Exec({ sandbox = null }: Win32ExecFactoryOptions = {}): Win32Exec {
  return async (command, cwd, { onData, signal, timeout, env }) => {
    cwd = assertExecutionCwd(cwd);
    const shellEnv = withWin32Utf8Defaults(env ?? getShellEnv());
    const route = classifyWin32Command(command);

    if (route.runner === "cmd") {
      if (sandboxIsEnabled(sandbox)) {
        const executable = process.env.COMSPEC || "cmd.exe";
        const args = cmdArgsForCommand(command);
        return spawnViaSandboxHelper({
          sandbox,
          executable,
          args,
          cwd,
          env: shellEnv,
          onData,
          signal,
          timeout,
          runtimeGrants: readOnlyRuntimeGrants([]),
        });
      }
      return spawnViaCmd(command, cwd, { env: shellEnv, onData, signal, timeout });
    }

    if (route.runner === "cmd-script") {
      const nativeCommand = `call ${cmdScriptCommand(command)}`;
      if (sandboxIsEnabled(sandbox)) {
        const executable = process.env.COMSPEC || "cmd.exe";
        const args = cmdArgsForCommand(nativeCommand);
        return spawnViaSandboxHelper({
          sandbox,
          executable,
          args,
          cwd,
          env: shellEnv,
          onData,
          signal,
          timeout,
        });
      }
      return spawnViaCmd(nativeCommand, cwd, { env: shellEnv, onData, signal, timeout });
    }

    if (route.runner === "powershell" || route.runner === "powershell-file" || route.runner === "powershell-command") {
      const powerShellInfo = route.runner === "powershell"
        ? parsePowerShellCommand(command, shellEnv)
        : route.runner === "powershell-file"
          ? parsePowerShellFileCommand(command, shellEnv)
          : parsePowerShellInlineCommand(command, shellEnv);

      if (sandboxIsEnabled(sandbox)) {
        return spawnViaSandboxHelper({
          sandbox,
          executable: powerShellInfo.executable,
          args: powerShellInfo.args,
          cwd,
          env: shellEnv,
          onData,
          signal,
          timeout,
        });
      }

      return spawnAndStream(powerShellInfo.executable, powerShellInfo.args, {
        cwd,
        env: shellEnv,
        onData,
        signal,
        timeout,
      });
    }

    if (route.runner === "git") {
      const gitInfo = prepareRuntimeForSandbox(findGitRuntime({
        env: shellEnv,
        bundledOnly: sandboxIsEnabled(sandbox),
      }), sandbox, "git");
      const gitArgs = parseGitCommandArgs(command);
      const gitEnv = getRuntimeEnvForCandidate(shellEnv, gitInfo);
      const runtimeReadPaths = runtimeReadPathsForBundledRuntime(gitInfo);

      if (sandboxIsEnabled(sandbox)) {
        return spawnViaSandboxHelper({
          sandbox,
          executable: gitInfo.git,
          args: gitArgs,
          cwd,
          env: gitEnv,
          onData,
          signal,
          timeout,
          runtimeGrants: readOnlyRuntimeGrants(runtimeReadPaths),
        });
      }

      return spawnAndStream(gitInfo.git, gitArgs, {
        cwd,
        env: gitEnv,
        onData,
        signal,
        timeout,
      });
    }

    if (route.runner === "python") {
      const pythonInfo = findPythonRuntime({ command, cwd, env: shellEnv });
      const pythonEnv = getRuntimeEnvForCandidate(shellEnv, pythonInfo);
      const runtimeReadPaths = runtimeReadPathsForPythonRuntime(pythonInfo);

      if (sandboxIsEnabled(sandbox)) {
        return spawnViaSandboxHelper({
          sandbox,
          executable: pythonInfo.executable,
          args: pythonInfo.args,
          cwd,
          env: pythonEnv,
          onData,
          signal,
          timeout,
          runtimeGrants: fullRuntimeGrants(runtimeReadPaths),
        });
      }

      return spawnAndStream(pythonInfo.executable, pythonInfo.args, {
        cwd,
        env: pythonEnv,
        onData,
        signal,
        timeout,
      });
    }

    if (route.runner === "node") {
      const nodeInfo = prepareRuntimeForSandbox(
        findNodeRuntime({ command, cwd, env: shellEnv }),
        sandbox,
        "node",
      );
      const nodeEnv = getRuntimeEnvForCandidate(shellEnv, nodeInfo);
      const runtimeReadPaths = runtimeReadPathsForNodeRuntime(nodeInfo);

      if (sandboxIsEnabled(sandbox)) {
        return spawnViaSandboxHelper({
          sandbox,
          executable: nodeInfo.executable,
          args: nodeInfo.args,
          cwd,
          env: nodeEnv,
          onData,
          signal,
          timeout,
          runtimeGrants: readOnlyRuntimeGrants(runtimeReadPaths),
        });
      }

      return spawnAndStream(nodeInfo.executable, nodeInfo.args, {
        cwd,
        env: nodeEnv,
        onData,
        signal,
        timeout,
      });
    }

    assertSafeWin32BashCommand(command);

    const shellInfo = prepareRuntimeForSandbox(findAndCacheShell(null, {
      preferBundled: true,
      bundledOnly: sandboxIsEnabled(sandbox),
      env: shellEnv,
    }), sandbox, "bash");
    const execEnv = getRuntimeEnvForCandidate(shellEnv, shellInfo);
    const bashRuntimeReadPaths = runtimeReadPathsForBundledRuntime(shellInfo);

    if (sandboxIsEnabled(sandbox)) {
      return spawnViaSandboxHelper({
        sandbox,
        executable: shellInfo.shell,
        args: [...shellInfo.args, command],
        cwd,
        env: execEnv,
        onData,
        signal,
        timeout,
        runtimeGrants: readOnlyRuntimeGrants(bashRuntimeReadPaths),
      });
    }

    try {
      return await spawnAndStream(shellInfo.shell, [...shellInfo.args, command], {
        cwd,
        env: execEnv,
        onData,
        signal,
        timeout,
      });
    } catch (err) {
      if (!isShellSpawnError(err, shellInfo.shell)) throw err;

      console.warn(`[win32-exec] Shell exec failed (${shellInfo.label}): ${err.code} ${err.message}, trying fallback...`);
      _cachedShell = null;
      let fallback = null;

      try {
        fallback = findAndCacheShell(shellInfo.shell);
        console.warn(`[win32-exec] fallback shell: ${fallback.label}`);
        const fallbackEnv = getRuntimeEnvForCandidate(shellEnv, fallback);
        return await spawnAndStream(fallback.shell, [...fallback.args, command], {
          cwd,
          env: fallbackEnv,
          onData,
          signal,
          timeout,
        });
      } catch (retryErr) {
        if (fallback && isShellSpawnError(retryErr, fallback.shell)) {
          throw enrichError(retryErr, shellInfo, err);
        }
        throw retryErr;
      }
    }
  };
}

export const __testing = {
  getBundledShellCandidates,
  getShellEnvForCandidate: getRuntimeEnvForCandidate,
};
