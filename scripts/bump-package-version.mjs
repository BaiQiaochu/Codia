#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const STRICT_RELEASE_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function incrementPatchVersion(version) {
  const match = STRICT_RELEASE_RE.exec(String(version || "").trim());
  if (!match) {
    throw new Error(`Cannot auto-increment package version. Expected x.y.z, got: ${version || "unknown"}`);
  }
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`;
}

export function bumpPackageVersion({ rootDir = process.cwd(), fsImpl = fs } = {}) {
  const packagePath = path.join(rootDir, "package.json");
  const lockPath = path.join(rootDir, "package-lock.json");
  if (!fsImpl.existsSync(packagePath)) {
    throw new Error(`package.json not found: ${packagePath}`);
  }

  const pkg = readJson(fsImpl, packagePath);
  const previousVersion = String(pkg.version || "");
  const nextVersion = incrementPatchVersion(previousVersion);
  pkg.version = nextVersion;
  writeJson(fsImpl, packagePath, pkg);

  if (fsImpl.existsSync(lockPath)) {
    const lock = readJson(fsImpl, lockPath);
    if (lock.version) lock.version = nextVersion;
    if (lock.packages?.[""]?.version) lock.packages[""].version = nextVersion;
    writeJson(fsImpl, lockPath, lock);
  }

  return { previousVersion, nextVersion };
}

function readJson(fsImpl, filePath) {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf-8"));
}

function writeJson(fsImpl, filePath, data) {
  fsImpl.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

function runCli() {
  const result = bumpPackageVersion();
  console.log(`[version] ${result.previousVersion} -> ${result.nextVersion}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(runCli());
  } catch (error) {
    console.error(`[version] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
