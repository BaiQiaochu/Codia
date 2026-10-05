// @ts-nocheck
import { existsSync as defaultExistsSync } from "fs";
import path from "path";
export {
  buildWin32GsapWriteAclCleanupArgs,
  buildWin32LegacyAclDiagnosticArgs,
  buildWin32LegacyProfileCleanupArgs,
} from "./win32-legacy-maintenance.ts";

export const WIN32_SANDBOX_HELPER_NAME = "gsap-win-sandbox.exe";

export function resourceSiblingDir(name, { env = process.env, resourcesPath = process.resourcesPath } = {}) {
  const candidates = [];
  if (resourcesPath) candidates.push(path.join(resourcesPath, name));
  if (env.GSAP_ROOT) candidates.push(path.resolve(env.GSAP_ROOT, "..", name));
  if (env.HANA_ROOT) candidates.push(path.resolve(env.HANA_ROOT, "..", name));
  return candidates.find((candidate) => defaultExistsSync(candidate)) || candidates[0] || null;
}

export function resolveWin32SandboxHelper({
  env = process.env,
  resourcesPath = process.resourcesPath,
  cwd = process.cwd(),
  arch = process.arch,
  existsSync = defaultExistsSync,
} = {}) {
  const candidates = [
    env.GSAP_WIN32_SANDBOX_HELPER,
    env.HANA_WIN32_SANDBOX_HELPER,
    resourcesPath ? path.join(resourcesPath, "sandbox", "windows", WIN32_SANDBOX_HELPER_NAME) : null,
    env.GSAP_ROOT ? path.resolve(env.GSAP_ROOT, "..", "sandbox", "windows", WIN32_SANDBOX_HELPER_NAME) : null,
    env.HANA_ROOT ? path.resolve(env.HANA_ROOT, "..", "sandbox", "windows", WIN32_SANDBOX_HELPER_NAME) : null,
    path.join(cwd, "dist-sandbox", `win-${arch}`, WIN32_SANDBOX_HELPER_NAME),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export function buildWin32SandboxHelperArgs({
  cwd,
  grants = {},
  executable,
  args = [],
} = {}) {
  if (!cwd) throw new Error("win32 sandbox helper requires cwd");
  if (!executable) throw new Error("win32 sandbox helper requires executable");

  const out = ["--cwd", cwd];
  for (const p of grants.writePaths || []) out.push("--writable-root", p);
  for (const p of grants.optionalWritePaths || []) out.push("--writable-root-optional", p);
  for (const p of grants.denyWritePaths || []) out.push("--deny-write", p);
  out.push("--", executable, ...args);
  return out;
}

export function buildWin32SandboxTokenDiagnosticArgs(options = {}) {
  return ["--diagnose-token", ...buildWin32SandboxHelperArgs(options)];
}
