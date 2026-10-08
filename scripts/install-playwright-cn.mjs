#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import extract from "extract-zip";

const mirrorRoot = process.env.PLAYWRIGHT_CN_MIRROR || "https://registry.npmmirror.com/-/binary";
const playwrightCli = path.join(process.cwd(), "node_modules", "playwright", "cli.js");
const dryRun = execFileSync(process.execPath, [playwrightCli, "install", "--dry-run", "chromium"], {
  cwd: process.cwd(),
  encoding: "utf-8",
  stdio: ["ignore", "pipe", "pipe"],
});

const downloads = parseDryRun(dryRun);
if (downloads.length === 0) {
  throw new Error("No Playwright Chromium downloads were found in dry-run output.");
}

for (const item of downloads) {
  const mirrorUrl = toMirrorUrl(item.url);
  if (!mirrorUrl) {
    throw new Error(`Unsupported Playwright download URL: ${item.url}`);
  }
  await installItem(item, mirrorUrl);
}

const { chromium } = await import("playwright");
const browser = await chromium.launch({ headless: true });
await browser.close();
console.log(`[install-playwright-cn] bundled Chromium ready: ${chromium.executablePath()}`);

function parseDryRun(text) {
  const rows = [];
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const location = block.match(/Install location:\s+(.+)/)?.[1]?.trim();
    const url = block.match(/Download url:\s+(.+)/)?.[1]?.trim();
    if (!location || !url) continue;
    if (rows.some((row) => row.location === location)) continue;
    rows.push({ location, url });
  }
  return rows;
}

function toMirrorUrl(url) {
  const cft = url.match(/\/builds\/cft\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (cft) return `${mirrorRoot}/chrome-for-testing/${cft[1]}/${cft[2]}/${cft[3]}`;
  const playwright = url.match(/\/playwright\/builds\/(.+)$/);
  if (playwright) return `${mirrorRoot}/playwright/builds/${playwright[1]}`;
  return null;
}

async function installItem(item, url) {
  const target = path.resolve(item.location);
  const msRoot = path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), "AppData", "Local", "ms-playwright"));
  if (process.platform === "win32" && !target.toLowerCase().startsWith(msRoot.toLowerCase())) {
    throw new Error(`Refusing to install outside Playwright cache: ${target}`);
  }
  const zipPath = path.join(os.tmpdir(), `playwright-cn-${path.basename(target)}.zip`);
  fs.rmSync(zipPath, { force: true });
  console.log(`[install-playwright-cn] download ${path.basename(target)} from ${url}`);
  await download(url, zipPath);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  await extract(zipPath, { dir: target });
  fs.rmSync(zipPath, { force: true });
  assertExpectedExecutable(target);
}

async function download(url, filePath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} ${url}`);
  }
  const file = fs.createWriteStream(filePath);
  await new Promise((resolve, reject) => {
    response.body.pipeTo(new WritableStream({
      write(chunk) {
        file.write(Buffer.from(chunk));
      },
      close() {
        file.end(resolve);
      },
      abort(reason) {
        file.destroy(reason);
        reject(reason);
      },
    })).catch(reject);
  });
}

function assertExpectedExecutable(target) {
  const base = path.basename(target);
  const expected = base.startsWith("chromium_headless_shell-")
    ? ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]
    : base.startsWith("chromium-")
      ? ["chrome-win64", "chrome.exe"]
      : base.startsWith("ffmpeg-")
        ? ["ffmpeg-win64.exe"]
        : base.startsWith("winldd-")
          ? ["PrintDeps.exe"]
          : [];
  if (expected.length === 0) return;
  const exePath = path.join(target, ...expected);
  if (!fs.existsSync(exePath)) throw new Error(`Installed file missing: ${exePath}`);
}
