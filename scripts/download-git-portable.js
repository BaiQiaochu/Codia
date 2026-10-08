#!/usr/bin/env node

import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { prunePortableGitRuntime } from "./prune-git-portable.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VENDOR_ROOT = path.join(ROOT, "vendor");
const VENDOR_DIR = path.join(VENDOR_ROOT, "git-portable");

const PORTABLE_GIT_VERSION = "2.54.0";
const PORTABLE_GIT_RELEASE = `v${PORTABLE_GIT_VERSION}.windows.1`;
const PORTABLE_GIT_SHA256 = "bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311";
const PORTABLE_GIT_URL =
  `https://github.com/git-for-windows/git/releases/download/${PORTABLE_GIT_RELEASE}/` +
  `PortableGit-${PORTABLE_GIT_VERSION}-64-bit.7z.exe`;
const ARCHIVE_PATH = path.join(VENDOR_ROOT, `portablegit-${PORTABLE_GIT_VERSION}.7z.exe`);

function hasPortableGitRuntime() {
  return fs.existsSync(path.join(VENDOR_DIR, "cmd", "git.exe")) &&
    (
      fs.existsSync(path.join(VENDOR_DIR, "bin", "bash.exe")) ||
      fs.existsSync(path.join(VENDOR_DIR, "usr", "bin", "bash.exe"))
    );
}

function verifySha256(filePath, expected) {
  const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  if (actual !== expected) {
    throw new Error(`PortableGit checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

function extractPortableGitArchive() {
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  if (process.platform === "win32") {
    execFileSync(ARCHIVE_PATH, ["-y", `-o${VENDOR_DIR}`], { stdio: "inherit", windowsHide: true });
    return;
  }

  for (const binary of ["7zz", "7z"]) {
    try {
      execFileSync(binary, ["x", "-y", `-o${VENDOR_DIR}`, ARCHIVE_PATH], { stdio: "inherit" });
      return;
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  throw new Error("extracting PortableGit on non-Windows hosts requires 7zz or 7z");
}

async function main(argv = process.argv) {
  const force = argv.includes("--force");
  const pruneExisting = argv.includes("--prune-existing");

  if (!force && hasPortableGitRuntime()) {
    console.log(`[download-git-portable] PortableGit runtime already present at ${VENDOR_DIR}.`);
    if (pruneExisting) {
      console.log("[download-git-portable] Pruning existing runtime...");
      prunePortableGitRuntime(VENDOR_DIR);
    }
    return;
  }

  fs.mkdirSync(VENDOR_ROOT, { recursive: true });

  console.log(`[download-git-portable] Downloading PortableGit ${PORTABLE_GIT_VERSION}...`);
  execFileSync("curl", ["--fail", "-L", "-o", ARCHIVE_PATH, PORTABLE_GIT_URL], { stdio: "inherit" });
  verifySha256(ARCHIVE_PATH, PORTABLE_GIT_SHA256);

  console.log("[download-git-portable] Extracting...");
  extractPortableGitArchive();

  fs.rmSync(ARCHIVE_PATH, { force: true });

  console.log("[download-git-portable] Pruning runtime...");
  prunePortableGitRuntime(VENDOR_DIR);

  console.log(`[download-git-portable] PortableGit ${PORTABLE_GIT_VERSION} ready at ${VENDOR_DIR}`);
}

main().catch((err) => {
  console.error("[download-git-portable] Failed:", err?.message || String(err));
  process.exit(1);
});
