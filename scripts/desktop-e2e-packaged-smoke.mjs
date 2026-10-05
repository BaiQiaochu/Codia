#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const distDir = path.join(ROOT, "dist");
const productName = pkg.build?.productName || "BYOUNG";
const winExecutableName = pkg.build?.win?.executableName || productName;
const winExecutableFileName = `${winExecutableName}.exe`;
const steps = [
  ["media-settings", "scripts/e2e-media-settings-defaults.mjs"],
  ["desk-workflow", "scripts/e2e-desk-workflow.mjs"],
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function findPackagedApp() {
  const explicit = String(process.env.GSAP_E2E_DESKTOP_APP || "").trim();
  if (explicit) return path.resolve(explicit);

  if (process.platform === "win32") {
    const expected = path.join(distDir, `${productName}-${pkg.version}-Windows-x64-Portable-Folder`, winExecutableFileName);
    const winUnpacked = path.join(distDir, "win-unpacked", winExecutableFileName);
    const recursive = walk(distDir)
      .filter((file) => path.basename(file).toLowerCase() === winExecutableFileName.toLowerCase())
      .sort((a, b) => scoreCandidate(a) - scoreCandidate(b));
    return [expected, winUnpacked, ...recursive].find((file) => fs.existsSync(file)) || "";
  }

  const recursive = walk(distDir);
  if (process.platform === "darwin") {
    return recursive.find((file) => file.endsWith(".app/Contents/MacOS/BYOUNG")) || "";
  }
  return recursive.find((file) => file.endsWith(".AppImage")) || "";
}

function scoreCandidate(file) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("portable-folder")) return 0;
  if (normalized.includes("win-unpacked")) return 1;
  return 2;
}

const appPath = findPackagedApp();
if (!appPath || !fs.existsSync(appPath)) {
  console.error("[desktop-e2e-packaged] no packaged desktop app found. Build/package first or set GSAP_E2E_DESKTOP_APP.");
  process.exit(2);
}

console.log(`[desktop-e2e-packaged] app=${appPath}`);
for (const [name, script] of steps) {
  console.log(`\n==> desktop:packaged:e2e:${name}`);
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      GSAP_E2E_DESKTOP_APP: appPath,
    },
  });
  if (result.status !== 0) {
    if (result.error) console.error(`[desktop-e2e-packaged] ${result.error.message}`);
    console.error(`[desktop-e2e-packaged] ${name} failed with exit ${result.status ?? "unknown"}`);
    process.exit(result.status || 1);
  }
}

console.log("\n[desktop-e2e-packaged] packaged smoke checks passed");
