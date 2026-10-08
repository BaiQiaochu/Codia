import fs from "fs";
import path from "path";

export const SESSION_MANIFEST_DB_FILE_NAMES = [
  "session-manifest.db",
  "session-manifest.db-wal",
  "session-manifest.db-shm",
];

export function sanitizeSessionManifestFileSuffix(value: any) {
  return String(value || "")
    .replace(/:/g, "-")
    .replace(/\./g, "-");
}

export function moveSessionManifestDbFilesAside(opts: any = {}) {
  const inputHome = opts.gsapHome || opts.hanaHome;
  if (!inputHome) throw new Error("moveSessionManifestDbFilesAside requires gsapHome");
  if (!opts.suffix) throw new Error("moveSessionManifestDbFilesAside requires suffix");
  const gsapHome = path.resolve(inputHome);
  const suffix = sanitizeSessionManifestFileSuffix(opts.suffix);
  const moved = [];

  for (const fileName of SESSION_MANIFEST_DB_FILE_NAMES) {
    const from = path.join(gsapHome, fileName);
    if (!fs.existsSync(from)) continue;
    const to = path.join(gsapHome, `${fileName}.${suffix}`);
    if (fs.existsSync(to)) {
      throw new Error(`Session manifest database target already exists: ${to}`);
    }
    fs.renameSync(from, to);
    moved.push({ from, to });
  }

  return moved;
}
