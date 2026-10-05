import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("local startup contract", () => {
  it("keeps workspace output helper statically bundleable in packaged runtime", () => {
    const source = fs.readFileSync(path.join(ROOT, "shared", "workspace-output.ts"), "utf-8");

    expect(source).toContain('from "./workspace-output.cjs"');
    expect(source).not.toContain("createRequire");
    expect(source).not.toContain('require("./workspace-output.cjs")');
  });

  it("includes workspace output helper files in the Electron package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
    const files = pkg.build?.files || [];

    expect(files).toContain("shared/workspace-output.ts");
    expect(files).toContain("shared/workspace-output.cjs");
  });

  it("server dependency install explicitly enables native package scripts", () => {
    const buildServer = fs.readFileSync(path.join(ROOT, "scripts", "build-server.mjs"), "utf-8");

    expect(buildServer).toContain("--ignore-scripts=false");
    expect(buildServer).toContain("runBetterSqliteRuntimeSmokeIfNeeded()");
  });
});
