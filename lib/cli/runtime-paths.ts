// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "./args.ts";
import { CliError } from "./errors.ts";

export function repoRoot(metaUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..", "..");
}

export function platformDirName(platform = process.platform) {
  if (platform === "darwin") return "mac";
  if (platform === "win32") return "win";
  return platform;
}

export function normalizeApiPath(apiPath) {
  if (!apiPath) throw new CliError("缺少 API 路径");
  if (/^https?:\/\//i.test(apiPath)) return apiPath;
  if (!apiPath.startsWith("/")) apiPath = `/${apiPath}`;
  if (apiPath === "/api" || apiPath.startsWith("/api/")) return apiPath;
  if (apiPath === "/ws") return apiPath;
  return `/api${apiPath}`;
}

export function isBundledServerRoot(root) {
  return fs.existsSync(path.join(root, "bootstrap.js"))
    && fs.existsSync(path.join(root, "bundle", "index.js"));
}

export function isSourceServerRoot(root) {
  return fs.existsSync(path.join(root, "server", "index.ts"))
    || fs.existsSync(path.join(root, "server", "index.js"));
}

export function sourceServerEntry(root) {
  const tsEntry = path.join(root, "server", "index.ts");
  return fs.existsSync(tsEntry) ? tsEntry : path.join(root, "server", "index.js");
}

export function bundledServerBinary(root, platform = process.platform) {
  const executable = path.join(root, platform === "win32" ? "gsap-server.exe" : "gsap-server");
  return fs.existsSync(executable) ? executable : process.execPath;
}

export function resolveServerLaunchConfig({
  root = repoRoot(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const explicitRoot = env.GSAP_CLI_BACKEND_ROOT || env.GSAP_BACKEND_ROOT || env.GSAP_MAIN_ROOT;
  const candidates = explicitRoot
    ? [path.resolve(expandHome(explicitRoot, env))]
    : [
      root,
      path.join(root, "dist-server", `${platformDirName(platform)}-${arch}`),
    ];

  for (const candidate of candidates) {
    if (isBundledServerRoot(candidate)) {
      return {
        kind: "bundled",
        root: candidate,
        command: bundledServerBinary(candidate, platform),
        args: [path.join(candidate, "bootstrap.js")],
        env: {
          GSAP_ROOT: candidate,
          GSAP_SERVER_ENTRY: path.join(candidate, "bundle", "index.js"),
        },
      };
    }
    if (isSourceServerRoot(candidate)) {
      return {
        kind: "source",
        root: candidate,
        command: process.execPath,
        args: [sourceServerEntry(candidate)],
        env: { GSAP_ROOT: candidate },
      };
    }
  }

  throw new CliError(`找不到可启动的 G-SAP 后端: ${candidates.join(", ")}`, { code: 2 });
}
