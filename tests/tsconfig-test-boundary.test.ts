import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

describe("test TypeScript config boundary", () => {
  it("includes renderer TypeScript tests migrated under desktop/src/react", () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, "tsconfig.test.json"), "utf8"));

    expect(config.include).toContain("desktop/src/react/**/*.test.ts");
    expect(config.include).toContain("desktop/src/react/**/*.test.tsx");
    expect(config.include).toContain("desktop/src/assets.d.ts");
  });
});
