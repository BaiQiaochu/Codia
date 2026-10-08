import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CORE_ENTRY_FILES = [
  "server/index.ts",
  "server/routes/chat.ts",
  "server/routes/sessions.ts",
  "core/engine.ts",
  "core/session-coordinator.ts",
];

describe("core entry TypeScript boundary", () => {
  it("keeps core server/session entrypoints under TypeScript checking", () => {
    for (const rel of CORE_ENTRY_FILES) {
      const source = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(source, rel).not.toMatch(/^\/\/\s*@ts-nocheck/m);
    }
  });
});
