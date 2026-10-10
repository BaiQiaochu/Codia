import path from "node:path";
import { spawnSync } from "node:child_process";

const POWERSHELL_7_MIN_MAJOR = 7;
let cachedWin32DefaultPowerShell: string | null = null;

export function envValue(env, name) {
  const source = env || {};
  if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
  const key = Object.keys(source).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? source[key] : undefined;
}

export function isWin32PathLike(filePath) {
  return /^[a-z]:[\\/]|^\\\\/i.test(String(filePath || ""));
}

export function baseNameForShellPath(filePath, { stripExe = false } = {}) {
  const raw = String(filePath || "").trim();
  if (!raw) return "";
  const base = isWin32PathLike(raw) || raw.includes("\\")
    ? path.win32.basename(raw)
    : path.basename(raw);
  return stripExe ? base.replace(/\.exe$/i, "") : base;
}

export function resolveWin32PowerShellExecutable(token = "powershell.exe", env = process.env) {
  const raw = String(token || "").trim();
  if (!raw) return "powershell.exe";
  if (isWin32PathLike(raw) || raw.includes("\\") || raw.includes("/")) return raw;
  const commandName = baseNameForShellPath(raw, { stripExe: false }).toLowerCase();
  if (commandName === "pwsh" || commandName === "pwsh.exe") {
    return envValue(env, "CODIA_POWERSHELL") || "pwsh.exe";
  }
  return win32WindowsPowerShellPath(env);
}

export function resolveWin32DefaultPowerShellExecutable(env = process.env, options: Record<string, any> = {}) {
    const override = envValue(env, "CODIA_POWERSHELL");
  if (override) return override;
  const useCache = options.cache !== false;
  if (useCache && cachedWin32DefaultPowerShell) return cachedWin32DefaultPowerShell;

  const found = findWin32PowerShell7Executable(env, options);
  const executable = found || win32WindowsPowerShellPath(env);
  if (useCache) cachedWin32DefaultPowerShell = executable;
  return executable;
}

function win32WindowsPowerShellPath(env = process.env) {
  const systemRoot = envValue(env, "SystemRoot") || envValue(env, "WINDIR") || "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function findWin32PowerShell7Executable(env = process.env, options: Record<string, any> = {}) {
  const spawn = options.spawn || spawnSync;
  const candidates = [];
  const addCandidate = (candidate) => {
    const value = String(candidate || "").trim();
    if (!value || candidates.some(existing => existing.toLowerCase() === value.toLowerCase())) return;
    candidates.push(value);
  };

  try {
    const result = spawn("where.exe", ["pwsh.exe"], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
      env,
    });
    if (result?.status === 0 && result.stdout) {
      for (const line of String(result.stdout).split(/\r?\n/)) addCandidate(line);
    }
  } catch {
    // PATH probing is best-effort.
  }

  const programFiles = envValue(env, "ProgramFiles");
  if (programFiles) addCandidate(`${programFiles}\\PowerShell\\7\\pwsh.exe`);
  const programFilesX86 = envValue(env, "ProgramFiles(x86)");
  if (programFilesX86) addCandidate(`${programFilesX86}\\PowerShell\\7\\pwsh.exe`);
  const localAppData = envValue(env, "LOCALAPPDATA");
  if (localAppData) addCandidate(`${localAppData}\\Microsoft\\powershell\\7\\pwsh.exe`);

  for (const candidate of candidates) {
    if (probePowerShellMajor(candidate, spawn, env) >= POWERSHELL_7_MIN_MAJOR) return candidate;
  }
  return null;
}

function probePowerShellMajor(executable, spawn, env) {
  try {
    const result = spawn(executable, [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "$PSVersionTable.PSVersion.Major",
    ], {
      encoding: "utf-8",
      timeout: 3000,
      windowsHide: true,
      env,
    });
    if (result?.status !== 0) return 0;
    return Number.parseInt(String(result.stdout || "").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function splitShellLikeArgs(command, {
  throwOnUnterminated = false,
  errorPrefix = "",
} = {}) {
  const args = [];
  let current = "";
  let quote = null;

  const input = String(command || "");
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (ch === "\\" && quote !== "'") {
      const next = input[i + 1];
      if (next && (/\s/.test(next) || next === "'" || next === "\"" || next === "\\")) {
        current += next;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote && throwOnUnterminated) {
    const prefix = errorPrefix ? `${errorPrefix} ` : "";
    throw new Error(`${prefix}Unterminated quote in command: ${command}`);
  }
  if (current.length > 0) args.push(current);
  return args;
}

export function quoteCmdArg(arg, { always = false } = {}) {
  const text = String(arg ?? "");
  if (!always && /^[^\s"&|<>^()]+$/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}
