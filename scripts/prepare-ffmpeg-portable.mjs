import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function findFileRecursive(rootDir, filename) {
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) {
        return full;
      }
    }
  }
  return "";
}

export function prepareBundledFfmpeg({ rootDir, outDir, platform }) {
  if (platform !== "win32") {
    return { prepared: false, reason: "unsupported-platform" };
  }
  if (process.env.CODIA_SKIP_BUNDLED_FFMPEG === "1") {
    console.log("[prepare-ffmpeg] skipped by CODIA_SKIP_BUNDLED_FFMPEG=1");
    return { prepared: false, reason: "skipped-by-env" };
  }

  const vendorRoot = path.join(rootDir, "vendor", "ffmpeg-portable");
  const cachedDir = path.join(vendorRoot, "win-x64");
  const ffmpegExe = path.join(cachedDir, "ffmpeg.exe");
  const ffprobeExe = path.join(cachedDir, "ffprobe.exe");
  ensureDir(vendorRoot);

  if (!fileExists(ffmpegExe) || !fileExists(ffprobeExe)) {
    const archivePath = path.join(vendorRoot, "ffmpeg-portable.zip");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-ffmpeg-"));
    try {
      console.log("[prepare-ffmpeg] downloading bundled ffmpeg...");
      execFileSync("curl.exe", ["-L", "-o", archivePath, FFMPEG_URL], { stdio: "inherit" });

      console.log("[prepare-ffmpeg] extracting...");
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`,
      ], { stdio: "inherit", windowsHide: true });

      const extractedFfmpeg = findFileRecursive(tempDir, "ffmpeg.exe");
      const extractedFfprobe = findFileRecursive(tempDir, "ffprobe.exe");
      if (!extractedFfmpeg || !extractedFfprobe) {
        throw new Error("ffmpeg.exe or ffprobe.exe not found in downloaded archive");
      }

      ensureDir(cachedDir);
      fs.copyFileSync(extractedFfmpeg, ffmpegExe);
      fs.copyFileSync(extractedFfprobe, ffprobeExe);
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(archivePath); } catch {}
    }
  } else {
    console.log("[prepare-ffmpeg] using cached bundled ffmpeg");
  }

  const targetDir = path.join(outDir, "ffmpeg");
  fs.rmSync(targetDir, { recursive: true, force: true });
  ensureDir(targetDir);
  fs.copyFileSync(ffmpegExe, path.join(targetDir, "ffmpeg.exe"));
  fs.copyFileSync(ffprobeExe, path.join(targetDir, "ffprobe.exe"));
  console.log("[prepare-ffmpeg] bundled ffmpeg ready");

  return {
    prepared: true,
    ffmpegPath: path.join(targetDir, "ffmpeg.exe"),
    ffprobePath: path.join(targetDir, "ffprobe.exe"),
  };
}
