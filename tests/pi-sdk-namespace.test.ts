import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("PI SDK namespace", () => {
  it("uses the maintained @earendil-works PI packages instead of deprecated @mariozechner packages", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    expect(pkg.dependencies["@earendil-works/pi-ai"]).toBeTruthy();
    expect(pkg.dependencies["@earendil-works/pi-coding-agent"]).toBeTruthy();
    expect(pkg.dependencies["@mariozechner/pi-ai"]).toBeUndefined();
    expect(pkg.dependencies["@mariozechner/pi-coding-agent"]).toBeUndefined();

    const adapterFiles = [
      "lib/pi-sdk/index.ts",
      "lib/pi-sdk/session-options.ts",
      "lib/pi-sdk/search-tools.ts",
      "lib/pi-sdk/stream-guard.ts",
      "scripts/patch-pi-sdk.cjs",
      "vite.config.server.js",
      "eslint.config.js",
    ];
    for (const file of adapterFiles) {
      const source = fs.readFileSync(path.join(root, file), "utf-8");
      expect(source).toContain("@earendil-works");
      expect(source).not.toContain("@mariozechner");
    }
  });
});
