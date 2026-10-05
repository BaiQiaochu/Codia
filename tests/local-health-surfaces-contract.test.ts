import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

describe("local health check surface packaging contract", () => {
  it("keeps the surface package command in the skip-build health path", () => {
    const script = read("scripts/local-health-check.mjs");

    expect(script).toContain('"surface:package"');
    expect(script).toContain('"package:surfaces"');
    expect(script).toContain('"--skip-build"');
  });
});
