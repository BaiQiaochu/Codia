// @ts-nocheck
/**
 * Linux bubblewrap sandbox.
 *
 * Build an allowlist mount plan instead of exposing the whole host filesystem.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { spawnAndStream } from "./exec-helper.ts";
import { writeScript, cleanup } from "./script.ts";

export function createBwrapExec(policy, { getExternalReadPaths, getSandboxNetworkEnabled } = {}) {
  return async (command, cwd, { onData, signal, timeout, env }) => {
    const { scriptPath } = writeScript(command, cwd);
    const args = buildBwrapArgs(policy, {
      cwd,
      env,
      allowNetwork: typeof getSandboxNetworkEnabled === "function"
        ? getSandboxNetworkEnabled()
        : true,
      externalReadPaths: typeof getExternalReadPaths === "function" ? getExternalReadPaths() : [],
      runtimeReadPaths: [scriptPath],
    });
    try {
      return await spawnAndStream(
        "bwrap",
        [...args, "--", "/bin/bash", scriptPath],
        { cwd, env, onData, signal, timeout },
      );
    } finally {
      cleanup(scriptPath);
    }
  };
}

const SYSTEM_READONLY_PATHS = [
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/opt",
  "/nix/store",
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/pki",
  "/etc/passwd",
  "/etc/group",
  "/etc/nsswitch.conf",
  "/etc/hosts",
  "/etc/localtime",
];

function existingPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths || []) {
    if (!p || seen.has(p) || !fs.existsSync(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function addParentDirs(args, target, createdDirs, { skipExisting = false } = {}) {
  const absolute = path.resolve(target);
  const dirs = [];
  let current = path.dirname(absolute);
  while (current && current !== path.dirname(current)) {
    if (
      current !== "/" &&
      !createdDirs.has(current) &&
      !(skipExisting && fs.existsSync(current))
    ) {
      dirs.push(current);
    }
    current = path.dirname(current);
  }
  for (const dir of dirs.reverse()) {
    createdDirs.add(dir);
    args.push("--dir", dir);
  }
}

function addMount(args, op, source, target, createdDirs, opts = {}) {
  addParentDirs(args, target, createdDirs, opts);
  args.push(op, source, target);
}

function addPrivateRuntimeEnv(args) {
  const runtimeDirs = ["/tmp/codia-home", "/tmp/codia-cache", "/tmp/codia-npm-cache", "/tmp/codia-pip-cache"];
  for (const dir of runtimeDirs) args.push("--dir", dir);
  args.push(
    "--setenv", "HOME", "/tmp/codia-home",
    "--setenv", "XDG_CACHE_HOME", "/tmp/codia-cache",
    "--setenv", "npm_config_cache", "/tmp/codia-npm-cache",
    "--setenv", "PIP_CACHE_DIR", "/tmp/codia-pip-cache",
  );
}

export function buildBwrapArgs(policy, {
  cwd,
  env,
  allowNetwork = true,
  externalReadPaths = [],
  runtimeReadPaths = [],
} = {}) {
  const readAll = policy.allowExternalReads !== false;
  const args = [
    ...(readAll ? ["--ro-bind", "/", "/"] : []),
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--unshare-pid",
  ];
  if (!allowNetwork) args.push("--unshare-net");
  args.push("--new-session", "--die-with-parent");
  const createdDirs = new Set(["/"]);
  const mountOpts = readAll ? { skipExisting: true } : {};

  addPrivateRuntimeEnv(args);

  if (!readAll) {
    for (const p of existingPaths(SYSTEM_READONLY_PATHS)) {
      addMount(args, "--ro-bind", p, p, createdDirs);
    }
  }

  if (cwd && fs.existsSync(cwd)) {
    addMount(args, "--bind", cwd, cwd, createdDirs, mountOpts);
    args.push("--chdir", cwd);
  }

  for (const p of existingPaths(policy.writablePaths)) {
    addMount(args, "--bind", p, p, createdDirs, mountOpts);
  }

  for (const p of existingPaths([
    ...(policy.readablePaths || []),
    ...externalReadPaths,
    ...runtimeReadPaths,
  ])) {
    addMount(args, "--ro-bind", p, p, createdDirs, mountOpts);
  }

  for (const p of existingPaths(policy.protectedPaths)) {
    addMount(args, "--ro-bind", p, p, createdDirs, mountOpts);
  }

  for (const p of policy.denyReadPaths || []) {
    if (!fs.existsSync(p)) continue;
    try {
      if (fs.statSync(p).isDirectory()) {
        addParentDirs(args, p, createdDirs, mountOpts);
        args.push("--tmpfs", p);
      } else {
        addMount(args, "--ro-bind", "/dev/null", p, createdDirs, mountOpts);
      }
    } catch {}
  }

  const home = env?.HOME || os.homedir();
  const cacheDirs = [
    path.join(home, ".cache"),
    path.join(home, ".npm"),
  ];
  for (const d of cacheDirs) {
    const isWritable = (policy.writablePaths || []).some(
      (w) => d === w || d.startsWith(w + path.sep),
    );
    if (!isWritable && fs.existsSync(d)) {
      addParentDirs(args, d, createdDirs, mountOpts);
      args.push("--tmpfs", d);
    }
  }

  return args;
}
