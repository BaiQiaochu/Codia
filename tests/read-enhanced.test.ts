import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { createEnhancedReadFile } from "../lib/sandbox/read-enhanced.js";

const fixturePath = path.join(process.cwd(), "tests", "fixtures", "sample.xlsx");

describe("createEnhancedReadFile xlsx handling", () => {
  it("returns readable xlsx text through the sandbox readFile adapter", async () => {
    expect(fs.existsSync(fixturePath)).toBe(true);

    const readFile = createEnhancedReadFile();
    const text = (await readFile(fixturePath)).toString("utf-8");

    expect(text).toContain("[Sheet: People]");
    expect(text).toContain("Rows: 3");
    expect(text).toContain("Columns: 2");
    expect(text).toContain("Alice");
    expect(text).toContain("Bob");
    expect(text).not.toContain("xlsx parse failed");
    expect(text).not.toContain("Preview");
    expect(text).not.toContain("[truncated:");
  });
});
