// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_HOST, expandHome } from "./args.ts";
import { CliError } from "./errors.ts";
import { parseJson } from "./json.ts";
import { resolveServerLaunchConfig } from "./runtime-paths.ts";

export const SERVER_START_TIMEOUT_MS = 90_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function serverInfoPath(opts) {
  if (opts.serverInfo) return path.resolve(expandHome(opts.serverInfo));
  if (process.env.GSAP_SERVER_INFO) return path.resolve(expandHome(process.env.GSAP_SERVER_INFO));
  return path.join(opts.home, "server-info.cli.json");
}

export function loadServerInfo(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const data = parseJson(fs.readFileSync(filePath, "utf8"), path.basename(filePath));
    const port = Number(data.port);
    const token = typeof data.token === "string" ? data.token : "";
    if (!port || !token) return null;
    return { port, token, version: data.version || null, source: filePath };
  } catch {
    return null;
  }
}

export async function checkServerInfo(info, host = DEFAULT_HOST) {
  if (!info?.port || !info?.token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://${host}:${info.port}/api/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return info;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkApiBase(apiBase, token) {
  if (!apiBase || !token) return null;
  const baseUrl = apiBase.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1800);
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return { baseUrl, token, source: "api-base" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function startDetachedServer(opts) {
  const launch = resolveServerLaunchConfig();
  fs.mkdirSync(opts.home, { recursive: true });
  const logDir = path.join(opts.home, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const infoPath = serverInfoPath(opts);
  const out = fs.openSync(path.join(logDir, "gsapctl-server.out.log"), "a");
  const err = fs.openSync(path.join(logDir, "gsapctl-server.err.log"), "a");
  const child = spawn(launch.command, launch.args, {
    cwd: launch.root,
    env: {
      ...process.env,
      ...launch.env,
      GSAP_HOME: opts.home,
      GSAP_HOST: opts.host || DEFAULT_HOST,
      GSAP_SERVER_SCOPE: "cli",
      GSAP_SERVER_INFO: infoPath,
    },
    detached: true,
    stdio: ["ignore", out, err],
    windowsHide: true,
  });
  child.unref();
  try {
    fs.writeSync(out, `gsapctl: starting ${launch.kind} backend from ${launch.root}\n`);
  } catch {}
  return child.pid;
}

export function spawnServerForeground(opts, extraArgs = []) {
  const launch = resolveServerLaunchConfig();
  fs.mkdirSync(opts.home, { recursive: true });
  const infoPath = serverInfoPath(opts);
  const env = {
    ...process.env,
    ...launch.env,
    GSAP_HOME: opts.home,
    GSAP_HOST: opts.host || DEFAULT_HOST,
    GSAP_SERVER_SCOPE: "cli",
    GSAP_SERVER_INFO: infoPath,
  };
  if (opts.port !== null && opts.port !== undefined) {
    env.GSAP_PORT = String(opts.port);
  }
  if (opts.token) {
    env.GSAP_TOKEN = opts.token;
  }
  return spawn(launch.command, [...launch.args, ...extraArgs], {
    cwd: launch.root,
    env,
    stdio: "inherit",
    windowsHide: false,
  });
}

export async function ensureServerInfo(opts, streams = { stderr: process.stderr }) {
  if (opts.apiBase) {
    const token = opts.token || process.env.GSAP_API_TOKEN || process.env.GSAP_TOKEN || "";
    const info = await checkApiBase(opts.apiBase, token);
    if (info) return info;
    throw new CliError("无法连接 GSAP_API_BASE 指定的后端，请检查地址和 token", { code: 2 });
  }

  if (opts.port && opts.token) {
    const direct = { port: Number(opts.port), token: opts.token, source: "argv" };
    const alive = await checkServerInfo(direct, opts.host);
    if (alive) return alive;
    throw new CliError(`无法连接 ${opts.host}:${opts.port}`, { code: 2 });
  }

  const infoPath = serverInfoPath(opts);
  const existing = await checkServerInfo(loadServerInfo(infoPath), opts.host);
  if (existing) return existing;

  if (opts.noStartServer) {
    throw new CliError(
      `没有找到可用的 G-SAP server: ${infoPath}\n请先运行 npm run server，或移除 --no-start-server 让 CLI 自动启动。`,
      { code: 2 },
    );
  }

  const pid = startDetachedServer(opts);
  if (!opts.json) {
    streams.stderr.write(`gsapctl: 未检测到后端，已启动 server (pid ${pid})，正在等待就绪...\n`);
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVER_START_TIMEOUT_MS) {
    const info = await checkServerInfo(loadServerInfo(infoPath), opts.host);
    if (info) return info;
    await sleep(750);
  }
  throw new CliError(`G-SAP server 启动超时，日志目录: ${path.join(opts.home, "logs")}`, { code: 2 });
}
