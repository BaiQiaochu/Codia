import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("CLI TypeScript boundary", () => {
  it("keeps local CLI source in TypeScript only", () => {
    const cliDir = path.join(ROOT, "lib", "cli");
    const jsFiles = fs
      .readdirSync(cliDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => path.join("lib", "cli", entry.name).replace(/\\/g, "/"));

    expect(jsFiles).toEqual([]);
    expect(fs.existsSync(path.join(cliDir, "main.ts"))).toBe(true);
  });

  it("launches CLI through the TypeScript entry", () => {
    const rootEntry = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
    const packageEntry = fs.readFileSync(path.join(ROOT, "scripts", "gsapctl.mjs"), "utf8");

    expect(rootEntry).toContain("./lib/cli/main.ts");
    expect(rootEntry).not.toContain("./lib/cli/main.js");
    expect(packageEntry).toContain("../lib/cli/main.ts");
    expect(packageEntry).not.toContain("../lib/cli/main.js");
  });
});
