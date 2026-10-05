import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionManifestCheckpoint,
  restoreSessionManifestCheckpoint,
} from "../core/session-manifest/checkpoint.ts";

describe("session manifest migration checkpoint", () => {
  let gsapHome;

  beforeEach(() => {
    gsapHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-manifest-checkpoint-"));
  });

  afterEach(() => {
    fs.rmSync(gsapHome, { recursive: true, force: true });
  });

  function writeHomeFile(relativePath, content) {
    const fullPath = path.join(gsapHome, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
    return fullPath;
  }

  it("copies migration-owned data roots and writes a rollback receipt", () => {
    writeHomeFile("agents/gsap/sessions/alpha.jsonl", "session");
    writeHomeFile("session-files/sess_alpha/file.txt", "file");
    writeHomeFile("bridge/inbound.json", "{}");
    writeHomeFile("phone/state.json", "{}");
    writeHomeFile("plugins/plugin-a/state.json", "{}");

    const checkpoint = createSessionManifestCheckpoint({
      gsapHome,
      appVersion: "0.0.0-test",
      createdAt: "2026-06-18T02:00:00.000Z",
      gitAnchors: {
        main: "checkpoint/pre-session-manifest-main-2026-06-18",
      },
    });

    expect(checkpoint.id).toBe("2026-06-18T02-00-00-000Z");
    expect(fs.existsSync(path.join(checkpoint.directory, "agents", "gsap", "sessions", "alpha.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(checkpoint.directory, "session-files", "sess_alpha", "file.txt"))).toBe(true);
    expect(fs.existsSync(path.join(checkpoint.directory, "bridge", "inbound.json"))).toBe(true);
    expect(fs.existsSync(path.join(checkpoint.directory, "phone", "state.json"))).toBe(true);
    expect(fs.existsSync(path.join(checkpoint.directory, "plugins", "plugin-a", "state.json"))).toBe(true);

    const receipt = JSON.parse(fs.readFileSync(path.join(checkpoint.directory, "checkpoint.json"), "utf-8"));
    expect(receipt).toMatchObject({
      kind: "session-manifest-migration-checkpoint",
      schemaVersion: 1,
      appVersion: "0.0.0-test",
      createdAt: "2026-06-18T02:00:00.000Z",
      gsapHome,
      gitAnchors: {
        main: "checkpoint/pre-session-manifest-main-2026-06-18",
      },
    });
    expect(receipt.includes.map((entry) => entry.name)).toEqual([
      "agents",
      "session-files",
      "bridge",
      "phone",
      "plugins",
    ]);
  });

  it("restores checkpoint data and moves aside the current manifest database", () => {
    const sessionPath = writeHomeFile("agents/gsap/sessions/alpha.jsonl", "before");
    const checkpoint = createSessionManifestCheckpoint({
      gsapHome,
      appVersion: "0.0.0-test",
      createdAt: "2026-06-18T02:01:00.000Z",
    });
    fs.writeFileSync(sessionPath, "after");
    fs.writeFileSync(path.join(gsapHome, "session-manifest.db"), "broken-db");
    fs.writeFileSync(path.join(gsapHome, "session-manifest.db-wal"), "broken-wal");
    fs.writeFileSync(path.join(gsapHome, "session-manifest.db-shm"), "broken-shm");

    const result = restoreSessionManifestCheckpoint({
      checkpointDirectory: checkpoint.directory,
      gsapHome,
      restoredAt: "2026-06-18T02:02:00.000Z",
    });

    expect(fs.readFileSync(sessionPath, "utf-8")).toBe("before");
    expect(result.movedManifestDbTo).toBe(path.join(
      gsapHome,
      "session-manifest.db.rollback-2026-06-18T02-02-00-000Z",
    ));
    expect(fs.readFileSync(result.movedManifestDbTo, "utf-8")).toBe("broken-db");
    expect(result.movedManifestFiles).toEqual([
      {
        from: path.join(gsapHome, "session-manifest.db"),
        to: path.join(gsapHome, "session-manifest.db.rollback-2026-06-18T02-02-00-000Z"),
      },
      {
        from: path.join(gsapHome, "session-manifest.db-wal"),
        to: path.join(gsapHome, "session-manifest.db-wal.rollback-2026-06-18T02-02-00-000Z"),
      },
      {
        from: path.join(gsapHome, "session-manifest.db-shm"),
        to: path.join(gsapHome, "session-manifest.db-shm.rollback-2026-06-18T02-02-00-000Z"),
      },
    ]);
    expect(fs.readFileSync(path.join(gsapHome, "session-manifest.db-wal.rollback-2026-06-18T02-02-00-000Z"), "utf-8")).toBe("broken-wal");
    expect(fs.readFileSync(path.join(gsapHome, "session-manifest.db-shm.rollback-2026-06-18T02-02-00-000Z"), "utf-8")).toBe("broken-shm");
    expect(fs.existsSync(path.join(gsapHome, "session-manifest.db"))).toBe(false);
    expect(fs.existsSync(path.join(gsapHome, "session-manifest.db-wal"))).toBe(false);
    expect(fs.existsSync(path.join(gsapHome, "session-manifest.db-shm"))).toBe(false);
    expect(fs.existsSync(path.join(checkpoint.directory, "checkpoint.json"))).toBe(true);
  });
});
