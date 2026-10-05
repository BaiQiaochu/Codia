const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
const productName = pkg.build?.productName || pkg.name || "app";
const arch = process.arch === "ia32" ? "ia32" : "x64";
const sourceDir = path.join(root, "dist-folder", "win-unpacked");
const targetDir = path.join(root, "dist", `${productName}-${pkg.version}-Windows-${arch}-Portable-Folder`);
const legacyPortableExe = path.join(root, "dist", `${productName}-${pkg.version}-Windows-${arch}-Portable.exe`);

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getPublishConfig() {
  const publish = pkg.build?.publish;
  if (Array.isArray(publish)) return publish[0] || null;
  return publish || null;
}

function ensureAppUpdateConfig(appDir) {
  const target = path.join(appDir, "resources", "app-update.yml");
  if (fs.existsSync(target)) return;

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const reusable = path.join(root, "dist", "win-unpacked", "resources", "app-update.yml");
  if (fs.existsSync(reusable)) {
    fs.copyFileSync(reusable, target);
    return;
  }

  const publish = getPublishConfig();
  if (!publish || publish.provider !== "github" || !publish.owner || !publish.repo) return;

  const updaterCacheDirName = `${String(pkg.name || productName).toLowerCase()}-updater`;
  const body = [
    `owner: ${publish.owner}`,
    `repo: ${publish.repo}`,
    `provider: github`,
    `updaterCacheDirName: ${updaterCacheDirName}`,
    "",
  ].join("\n");
  fs.writeFileSync(target, body, "utf-8");
}

function copyPortableIcons(appDir) {
  const configuredIco = pkg.build?.win?.icon || "desktop/src/icon.ico";
  const configuredPng = pkg.build?.linux?.icon || "desktop/src/icon.png";
  const iconSources = [
    { from: path.resolve(root, configuredIco), to: path.join(appDir, `${productName}.ico`) },
    { from: path.resolve(root, configuredPng), to: path.join(appDir, `${productName}.png`) },
  ];
  for (const { from, to } of iconSources) {
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, to);
  }
}

if (!fs.existsSync(sourceDir)) {
  throw new Error(`[folder-portable] missing ${sourceDir}`);
}

fs.mkdirSync(path.dirname(targetDir), { recursive: true });
let finalTargetDir = targetDir;
let targetCleared = false;
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    targetCleared = true;
    break;
  } catch (error) {
    if (!["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error?.code)) throw error;
    sleep(500);
  }
}
if (!targetCleared && fs.existsSync(targetDir)) {
  finalTargetDir = `${targetDir}-${stamp()}`;
  console.warn(`[folder-portable] target busy, fallback to ${finalTargetDir}`);
}
try {
  fs.renameSync(sourceDir, finalTargetDir);
} catch (error) {
  if (!["EPERM", "EXDEV", "EACCES"].includes(error?.code)) throw error;
  fs.cpSync(sourceDir, finalTargetDir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
}
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    fs.rmSync(path.join(root, "dist-folder"), { recursive: true, force: true });
    break;
  } catch (error) {
    if (!["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(error?.code)) throw error;
    sleep(500);
  }
}
try {
  fs.rmSync(legacyPortableExe, { force: true });
} catch (error) {
  if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
  console.warn(`[folder-portable] kept legacy portable exe: ${legacyPortableExe}`);
}

ensureAppUpdateConfig(finalTargetDir);
copyPortableIcons(finalTargetDir);

console.log(`[folder-portable] created ${finalTargetDir}`);
fs.writeFileSync(
  path.join(root, "dist", ".last-portable-folder"),
  `${finalTargetDir}\n`,
  "utf-8",
);
