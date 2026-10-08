// @ts-nocheck
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { readLocalServerInfo, resolveCliGrapHome } from "./local-server.ts";

function packagedRootFromEnv(env = process.env) {
  const roots = [env.GSAP_ROOT, env.HANA_ROOT].filter(Boolean);
  return roots.find((root) => fs.existsSync(path.join(root, "bootstrap.js"))
    && fs.existsSync(path.join(root, "bundle", "index.js"))) || null;
}

export function resolveServerSpawnSpec({
  projectRoot,
  env = process.env,
  extraArgs = [],
} = {}) {
  const root = projectRoot || path.resolve(import.meta.dirname, "..");
  const packagedRoot = packagedRootFromEnv(env) || (
    fs.existsSync(path.join(root, "bootstrap.js"))
    && fs.existsSync(path.join(root, "bundle", "index.js"))
      ? root
      : null
  );

  if (packagedRoot) {
    return {
      mode: "packaged",
      command: process.execPath,
      args: [path.join(packagedRoot, "bootstrap.js"), ...extraArgs],
      env: {
        ...env,
        GSAP_ROOT: packagedRoot,
        GSAP_SERVER_ENTRY: path.join(packagedRoot, "bundle", "index.js"),
        HANA_ROOT: env.HANA_ROOT || packagedRoot,
        HANA_SERVER_ENTRY: env.HANA_SERVER_ENTRY || path.join(packagedRoot, "bundle", "index.js"),
      },
    };
  }

  return {
    mode: "source",
    command: process.execPath,
    args: [path.join(root, "server", "index.ts"), ...extraArgs],
    env,
  };
}

export function spawnServerForeground({ projectRoot, extraArgs = [], env = process.env } = {}) {
  const spec = resolveServerSpawnSpec({ projectRoot, env, extraArgs });
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    env: spec.env,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
  return child;
}

export async function startLocalServerAndWait({
  projectRoot,
  env = process.env,
  timeoutMs = 30000,
  intervalMs = 250,
} = {}) {
  const gsapHome = resolveCliGrapHome(env);
  const existing = readLocalServerInfo({ gsapHome });
  if (existing.ok) return existing;

  const spec = resolveServerSpawnSpec({ projectRoot, env, extraArgs: [] });
  const child = spawn(spec.command, spec.args, {
    stdio: "ignore",
    detached: true,
    env: spec.env,
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const info = readLocalServerInfo({ gsapHome });
    if (info.ok) return { ...info, started: true, serverMode: spec.mode };
    await delay(intervalMs);
  }

  throw new Error(`G-SAP server did not become ready within ${Math.round(timeoutMs / 1000)}s`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
