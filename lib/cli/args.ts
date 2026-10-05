// @ts-nocheck
import os from "node:os";
import path from "node:path";
import { CliError } from "./errors.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_HOST = "127.0.0.1";

export function expandHome(value, env = process.env) {
  if (!value) return value;
  if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) return value;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (value === "~") return home;
  return path.join(home, value.slice(2));
}

export function resolveGsapHome(env = process.env, { existsSync = null } = {}) {
  const configured = env.GSAP_HOME;
  if (configured) return path.resolve(expandHome(configured, env));
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const gsapHome = path.join(home, ".gsap");
  const legacyHome = path.join(home, `.${["h", "anako"].join("")}`);
  if (existsSync?.(gsapHome)) return gsapHome;
  if (env.GSAP_USE_LEGACY_GSAP_HOME === "1" && existsSync?.(legacyHome)) return legacyHome;
  return gsapHome;
}

export function parseGlobalArgs(rawArgs, context = {}) {
  const env = context.env || process.env;
  const opts = {
    home: resolveGsapHome(env, context),
    serverInfo: null,
    host: DEFAULT_HOST,
    port: null,
    token: null,
    apiBase: env.GSAP_API_BASE || env.GSAP_BACKEND_URL || "",
    noStartServer: false,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    color: context.stdoutIsTTY !== false && !env.NO_COLOR,
    approvalMode: null,
    sandboxMode: null,
  };
  const args = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    const needValue = () => {
      if (i >= rawArgs.length - 1) throw new CliError(`${arg} 需要参数`);
      i += 1;
      return rawArgs[i];
    };
    if (arg === "--home") opts.home = path.resolve(expandHome(needValue(), env));
    else if (arg === "--server-info") opts.serverInfo = needValue();
    else if (arg === "--host") opts.host = needValue();
    else if (arg === "--port") opts.port = Number(needValue());
    else if (arg === "--token") opts.token = needValue();
    else if (arg === "--api-base" || arg === "--backend") opts.apiBase = needValue();
    else if (arg === "--no-start-server") opts.noStartServer = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--timeout") opts.timeoutMs = Number(needValue()) || DEFAULT_TIMEOUT_MS;
    else if (arg === "--no-color") opts.color = false;
    else if (arg === "--approval-mode" || arg === "--approval-policy" || arg === "--approval" || arg === "--ask-for-approval" || arg === "-a") opts.approvalMode = needValue();
    else if (arg === "--sandbox" || arg === "--sandbox-mode" || arg === "-s") opts.sandboxMode = needValue();
    else if (arg === "--dangerously-bypass-approvals-and-sandbox" || arg === "--yolo") {
      opts.approvalMode = "never";
      opts.sandboxMode = "danger-full-access";
    }
    else if (arg === "--full-auto") {
      opts.approvalMode = "never";
      opts.sandboxMode = "workspace-write";
    }
    else args.push(arg);
  }
  return { opts, args };
}
