/**
 * extract-zip.js - cross-platform zip extraction.
 *
 * Use the bundled JS extractor instead of system unzip/PowerShell.
 * Security: reject symlink entries. extract-zip@2.0.1 does not constrain
 * symlink targets before later entries can write through them.
 */

import extractZipImpl from "extract-zip";

const IFMT = 0o170000;
const IFLNK = 0o120000;

export function isSymlinkEntry(entry) {
  if (!entry || typeof entry.externalFileAttributes !== "number") return false;
  const mode = (entry.externalFileAttributes >> 16) & 0xFFFF;
  return (mode & IFMT) === IFLNK;
}

function rejectSymlinkEntries(entry) {
  if (isSymlinkEntry(entry)) {
    const name = entry?.fileName || "<unnamed>";
    throw new Error(`extract-zip: symlink entry is not allowed (entry: ${name})`);
  }
}

export async function extractZip(zipPath, destDir) {
  await extractZipImpl(zipPath, {
    dir: destDir,
    onEntry: rejectSymlinkEntries,
  });
}
