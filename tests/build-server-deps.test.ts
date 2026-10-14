import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBetterSqliteRuntimeSmokeScript,
  buildExternalPackage,
  verifyExternalEntrypoints,
} from "../scripts/build-server-deps.mjs";

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-build-server-deps-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("build-server external dependency packaging", () => {
  it("pins server externals and selected runtime transitives to the root lock versions", () => {
    const rootPkg = {
      name: "codia",
      version: "1.0.1",
      overrides: { axios: "^1.15.2" },
    };
    const rootLock = {
      packages: {
        "node_modules/jsdom": { version: "29.0.2" },
        "node_modules/lru-cache": { version: "11.2.7" },
        "node_modules/@earendil-works/pi-codemode": { version: "1.1.0" },
      },
    };

    const serverPkg = buildExternalPackage(
      rootPkg,
      { jsdom: "^29.0.2" },
      {
        rootLock,
        pinnedTransitiveDeps: ["lru-cache", "@earendil-works/pi-codemode"],
        packageName: "codia-server",
      },
    );

    expect(serverPkg).toEqual({
      name: "codia-server",
      version: "1.0.1",
      type: "module",
      dependencies: {
        jsdom: "29.0.2",
        "lru-cache": "11.2.7",
        "@earendil-works/pi-codemode": "1.1.0",
      },
      overrides: { axios: "^1.15.2" },
    });
  });

  it("generates a better-sqlite3 smoke script that opens a database", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "better-sqlite3");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(packageDir, "index.js"), [
      "module.exports = class Database {",
      "  constructor(filename) { if (filename !== ':memory:') throw new Error('unexpected filename'); }",
      "  prepare(sql) {",
      "    if (sql !== 'select 1 as ok') throw new Error('unexpected sql');",
      "    return { get: () => ({ ok: 1 }) };",
      "  }",
      "  close() { this.closed = true; }",
      "}",
    ].join("\n"));
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "better-sqlite3",
      main: "index.js",
    }));

    const scriptPath = path.join(outDir, ".better-sqlite3-smoke.mjs");
    fs.writeFileSync(scriptPath, buildBetterSqliteRuntimeSmokeScript());

    expect(() => execFileSync(process.execPath, [scriptPath], { cwd: outDir }))
      .not.toThrow();
  });

  it("fails fast when an installed external package export resolves to a missing file", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "bad-export-package");
    fs.mkdirSync(path.join(packageDir, "dist", "commonjs"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "dist", "commonjs", "index.min.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "bad-export-package",
      version: "1.0.0",
      exports: {
        ".": {
          require: {
            node: {
              default: "./dist/commonjs/node/index.min.js",
            },
            default: "./dist/commonjs/index.min.js",
          },
        },
      },
    }));

    expect(() => verifyExternalEntrypoints(outDir, ["bad-export-package"])).toThrow(
      /bad-export-package.*dist[\\/]commonjs[\\/]node[\\/]index\.min\.js/s,
    );
  });

  it("accepts import-only package exports when the runtime target exists", () => {
    const outDir = makeTempDir();
    const packageDir = path.join(outDir, "node_modules", "esm-only-package");
    fs.mkdirSync(path.join(packageDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "dist", "index.js"), "export const ok = true;\n");
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: "esm-only-package",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          source: "./src/index.ts",
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      },
    }));

    expect(() => verifyExternalEntrypoints(outDir, ["esm-only-package"])).not.toThrow();
  });
});
