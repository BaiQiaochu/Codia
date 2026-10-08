import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneServerReleaseOutput } from "../scripts/prune-server-release-output.mjs";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-server-prune-"));
  tempDirs.push(dir);
  return dir;
}

function writeFile(root: string, relativePath: string, content = "x") {
  const file = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("prune server release output", () => {
  it("removes Windows debug and linker intermediates while keeping runtime binaries", () => {
    const root = makeTempDir();
    const outDir = path.join(root, "dist-server", "win-x64");

    writeFile(outDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.node", "native");
    writeFile(outDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.pdb", "debug");
    writeFile(outDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.iobj", "debug");
    writeFile(outDir, "node_modules/better-sqlite3/build/Release/sqlite3.lib", "link");
    writeFile(outDir, "node_modules/node-pty/prebuilds/win32-x64/conpty.dll", "runtime");
    writeFile(outDir, "node_modules/node-pty/prebuilds/win32-x64/conpty.pdb", "debug");

    const result = pruneServerReleaseOutput(outDir, { logger: { log: () => {} } });

    expect(result.filesRemoved).toBe(4);
    expect(fs.existsSync(path.join(outDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "node_modules/node-pty/prebuilds/win32-x64/conpty.dll"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.pdb"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "node_modules/better-sqlite3/build/Release/better_sqlite3.iobj"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "node_modules/better-sqlite3/build/Release/sqlite3.lib"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "node_modules/node-pty/prebuilds/win32-x64/conpty.pdb"))).toBe(false);
  });
});
