import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("web reader jsdom cleanup", () => {
  it("closes the jsdom window after markdown extraction", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "lib/tools/web-reader.ts"), "utf8");

    expect(source).toContain("try {");
    expect(source).toContain("dom.window.close();");
  });
});
