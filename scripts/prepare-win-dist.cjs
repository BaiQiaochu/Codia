const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const distRuntimeDir = path.join(distDir, "win-unpacked");
const stagingDirs = ["dist-repack", "dist-portable", "dist-folder"];

function log(message) {
  console.log(`[prepare-win-dist] ${message}`);
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryRemove(target) {
  fs.rmSync(target, { recursive: true, force: true });
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

function removeOrArchive(target) {
  if (!fs.existsSync(target)) return;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      tryRemove(target);
      log(`removed ${path.relative(root, target)}`);
      return;
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
    log(`moved busy path to ${path.relative(root, archivedTarget)}`);
  } catch (error) {
    if (["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error?.code)) {
      log(`left busy path in place: ${path.relative(root, target)}`);
      return;
    }
    throw error;
  }
}

function stopLockedDistProcesses() {
  if (process.platform !== "win32") return;

  const powershellScript = `
$targetRoot = [System.IO.Path]::GetFullPath($env:GSAP_DIST_ROOT)
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ExecutablePath -and
    [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
      $targetRoot,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Host ("[prepare-win-dist] stopped pid={0} path={1}" -f $_.ProcessId, $_.ExecutablePath)
  }
`;

  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", powershellScript],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GSAP_DIST_ROOT: distRuntimeDir,
      },
    },
  );

  if (typeof result.status === "number" && result.status !== 0) {
    throw new Error(`failed to stop dist processes (exit ${result.status})`);
  }
}

fs.mkdirSync(distDir, { recursive: true });
stopLockedDistProcesses();
removeOrArchive(path.join(distDir, "win-unpacked"));
cleanupUpdateArtifacts(distDir);

for (const stagingDir of stagingDirs) {
  removeOrArchive(path.join(root, stagingDir));
}
