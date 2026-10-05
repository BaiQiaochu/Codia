const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const stageArg = process.argv[2];
const kind = String(process.argv[3] || "").trim().toLowerCase();

if (!stageArg) {
  throw new Error("usage: node scripts/finalize-win-artifacts.cjs <stageDir> [nsis|portable]");
}

const stageDir = path.resolve(root, stageArg);
const distDir = path.join(root, "dist");
const movedEntries = [];

function log(message) {
  console.log(`[finalize-win-artifacts] ${message}`);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupUpdateArtifacts(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "latest.yml" || entry.endsWith(".blockmap")) {
      const target = path.join(dir, entry);
      try {
        fs.rmSync(target, { force: true });
        log(`removed ${path.relative(root, target)}`);
      } catch (error) {
        log(`skip cleanup for ${path.relative(root, target)}: ${error.message}`);
      }
    }
  }
}

function clearTarget(target) {
  if (!fs.existsSync(target)) return true;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error?.code)) {
        throw error;
      }
      sleep(500);
    }
  }

  const archivedTarget = `${target}-stale-${stamp()}`;
  try {
    fs.renameSync(target, archivedTarget);
    log(`moved busy target to ${path.relative(root, archivedTarget)}`);
    return true;
  } catch (error) {
    if (["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error?.code)) {
      log(`unable to clear ${path.relative(root, target)}; skipping replacement`);
      return false;
    }
    throw error;
  }
}

function moveEntry(source, target) {
  if (!clearTarget(target)) return false;

  try {
    fs.renameSync(source, target);
    movedEntries.push(path.relative(root, target));
    log(`moved ${path.relative(root, source)} -> ${path.relative(root, target)}`);
    return true;
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES"].includes(error?.code)) {
      throw error;
    }
  }

  const stats = fs.statSync(source);
  if (stats.isDirectory()) {
    fs.cpSync(source, target, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  } else {
    fs.copyFileSync(source, target);
    fs.rmSync(source, { force: true });
  }

  movedEntries.push(path.relative(root, target));
  log(`copied ${path.relative(root, source)} -> ${path.relative(root, target)}`);
  return true;
}

function shouldMoveFile(name) {
  const lowerName = name.toLowerCase();
  if (!lowerName.endsWith(".exe")) return false;
  if (kind === "portable") return lowerName.includes("portable");
  if (kind === "nsis") return !lowerName.includes("portable");
  return true;
}

if (!fs.existsSync(stageDir)) {
  throw new Error(`[finalize-win-artifacts] missing ${stageDir}`);
}

fs.mkdirSync(distDir, { recursive: true });
cleanupUpdateArtifacts(stageDir);

for (const entry of fs.readdirSync(stageDir, { withFileTypes: true })) {
  const source = path.join(stageDir, entry.name);
  const target = path.join(distDir, entry.name);

  if (entry.isDirectory() && entry.name === "win-unpacked") {
    moveEntry(source, target);
    continue;
  }

  if (entry.isFile() && shouldMoveFile(entry.name)) {
    moveEntry(source, target);
  }
}

cleanupUpdateArtifacts(distDir);

if (fs.existsSync(stageDir)) {
  fs.rmSync(stageDir, { recursive: true, force: true });
}

if (!movedEntries.length) {
  throw new Error(`[finalize-win-artifacts] no artifacts moved from ${stageDir}`);
}

log(`finalized ${movedEntries.join(", ")}`);
