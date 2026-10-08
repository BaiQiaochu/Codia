import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

describe("server auth TypeScript boundary", () => {
  it("keeps the core auth service inside type checking", () => {
    const source = fs.readFileSync(path.join(ROOT, "core", "server-auth.ts"), "utf8");

    expect(source).not.toMatch(/^\/\/ @ts-nocheck/m);
  });
});
