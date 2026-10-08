import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const REBUILD_COMMAND = "npm rebuild better-sqlite3 --ignore-scripts=false --foreground-scripts";

describe("better-sqlite3 native addon guardrail", () => {
  it("loads the native addon and opens an in-memory database", () => {
    let Database: any;
    try {
      Database = require("better-sqlite3");
    } catch (err: any) {
      throw new Error(
        `Failed to load better-sqlite3 native addon.\n` +
        `Install scripts may have been skipped or the addon may target a different Node ABI.\n\n` +
        `Rebuild with:\n  ${REBUILD_COMMAND}\n\n` +
        `Original error: ${err.message}`,
      );
    }

    let db: any;
    try {
      db = new Database(":memory:");
      expect(db.prepare("select 1 as ok").get()).toEqual({ ok: 1 });
    } catch (err: any) {
      throw new Error(
        `better-sqlite3 loaded but cannot open an in-memory database.\n\n` +
        `Rebuild with:\n  ${REBUILD_COMMAND}\n\n` +
        `Original error: ${err.message}`,
      );
    } finally {
      try { db?.close(); } catch { /* best effort */ }
    }
  });
});
