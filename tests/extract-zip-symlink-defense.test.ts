import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import { isSymlinkEntry } from "../lib/extract-zip.js";

const IFMT = 0o170000;
const IFLNK = 0o120000;
const IFREG = 0o100000;

function attrsForMode(mode) {
  return mode << 16;
}

describe("lib/extract-zip symlink defense", () => {
  it("detects zip symlink entries from external file attributes", () => {
    expect(isSymlinkEntry({ externalFileAttributes: attrsForMode(IFLNK | 0o777) })).toBe(true);
    expect(isSymlinkEntry({ externalFileAttributes: attrsForMode(IFREG | 0o644) })).toBe(false);
    expect(isSymlinkEntry({ externalFileAttributes: 0 })).toBe(false);
    expect(isSymlinkEntry(null)).toBe(false);
  });

  it("keeps search tool zip downloads on the hardened wrapper", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib", "pi-sdk", "search-tools.ts"),
      "utf-8",
    );

    expect(source).toContain('import { extractZip } from "../extract-zip.ts";');
    expect(source).not.toContain('from "extract-zip"');
    expect(source).toContain("await extractZip(archivePath, extractDir);");
  });
});
