import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_SESSION_MANIFEST_MIGRATION_KEY,
  ensureLegacySessionManifestMigration,
} from "../core/session-manifest/startup-migration.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("session manifest startup migration", () => {
  let gsapHome;
  let store;
  let nextId;

  beforeEach(() => {
    gsapHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-manifest-startup-"));
    nextId = 1;
    store = new SessionManifestStore({
      dbPath: path.join(gsapHome, "session-manifest.db"),
      idGenerator: () => `sess_startup_${String(nextId++).padStart(4, "0")}`,
      now: () => "2026-06-18T06:00:00.000Z",
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(gsapHome, { recursive: true, force: true });
  });

  function writeLegacySession(agentId, fileName) {
    const sessionDir = path.join(gsapHome, "agents", agentId, "sessions");
    const sessionPath = path.join(sessionDir, fileName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionPath, `${JSON.stringify({
      type: "session",
      id: fileName,
      timestamp: "2026-06-18T06:00:00.000Z",
    })}\n`);
    return sessionPath;
  }

  it("creates a rollback checkpoint before migrating legacy sessions once", () => {
    const sessionPath = writeLegacySession("gsap", "alpha.jsonl");

    const first = ensureLegacySessionManifestMigration({
      gsapHome,
      store,
      appVersion: "9.9.9",
      startedAt: "2026-06-18T06:01:00.000Z",
      checkpointId: "startup-test",
    });

    expect(first.status).toBe("completed");
    expect(first.result).toEqual({ scanned: 1, created: 1, existing: 0, skipped: 0 });
    expect(store.resolveByLocatorPath(sessionPath)?.sessionId).toBe("sess_startup_0001");
    expect(fs.existsSync(path.join(first.checkpoint.directory, "checkpoint.json"))).toBe(true);
    expect(store.getState(LEGACY_SESSION_MANIFEST_MIGRATION_KEY)).toMatchObject({
      checkpointDirectory: first.checkpoint.directory,
      completedAt: "2026-06-18T06:01:00.000Z",
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });

    const secondCheckpoint = vi.fn();
    const secondMigration = vi.fn(() => ({ scanned: 1, created: 0, existing: 1, skipped: 0 }));
    const second = ensureLegacySessionManifestMigration({
      gsapHome,
      store,
      createCheckpoint: secondCheckpoint,
      migrate: secondMigration,
    });

    expect(second.status).toBe("rescanned");
    expect(secondCheckpoint).not.toHaveBeenCalled();
    expect(secondMigration).toHaveBeenCalledWith({
      gsapHome,
      store,
      migratedAt: expect.any(String),
      stopOnError: undefined,
    });
    expect(store.getState(LEGACY_SESSION_MANIFEST_MIGRATION_KEY)).toMatchObject({
      checkpointDirectory: first.checkpoint.directory,
      completedAt: "2026-06-18T06:01:00.000Z",
      lastScannedAt: expect.any(String),
      lastResult: { scanned: 1, created: 0, existing: 1, skipped: 0 },
    });
  });

  it("records startup migration failures without throwing", () => {
    const failure = ensureLegacySessionManifestMigration({
      gsapHome,
      store,
      startedAt: "2026-06-18T06:02:00.000Z",
      createCheckpoint: () => {
        throw Object.assign(new Error("checkpoint denied"), { code: "EACCES" });
      },
    });

    expect(failure.status).toBe("failed");
    expect(failure.error.message).toBe("checkpoint denied");
    expect(store.getState(LEGACY_SESSION_MANIFEST_MIGRATION_KEY)).toMatchObject({
      failedAt: "2026-06-18T06:02:00.000Z",
      error: {
        code: "EACCES",
        message: "checkpoint denied",
      },
    });
  });
});
