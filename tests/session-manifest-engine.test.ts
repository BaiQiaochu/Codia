import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodiaEngine } from "../core/engine.ts";
import { SessionManifestResolver } from "../core/session-manifest/resolver.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";
import { SessionFileRegistry } from "../lib/session-files/session-file-registry.ts";

describe("CodiaEngine session manifest facade", () => {
  let tmpDir;
  let store;
  let engine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-manifest-engine-"));
    store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => "sess_engine_0001",
      now: () => "2026-06-18T05:00:00.000Z",
    });
    engine = Object.create(CodiaEngine.prototype);
    engine._sessionManifestStore = store;
    engine._sessionManifestResolver = new SessionManifestResolver({ store });
    engine._sessionFiles = new SessionFileRegistry({
      now: () => 1234,
      getSessionIdForPath: (sessionPath) => engine.getSessionIdForPath(sessionPath),
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves session refs without exposing the store implementation", () => {
    const sessionPath = path.join(tmpDir, "agents", "codia", "sessions", "alpha.jsonl");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    const manifest = store.createForPath({ sessionPath, ownerAgentId: "codia" });

    expect(engine.resolveSessionRef({ sessionPath }).sessionId).toBe(manifest.sessionId);
    expect(engine.getSessionManifest(manifest.sessionId)?.currentLocator.path).toBe(fs.realpathSync.native(sessionPath));
    expect(engine.getSessionIdForPath(sessionPath)).toBe(manifest.sessionId);
  });

  it("adds sessionId to session file registrations when callers still pass only sessionPath", () => {
    const sessionPath = path.join(tmpDir, "agents", "codia", "sessions", "alpha.jsonl");
    const filePath = path.join(tmpDir, "report.md");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    fs.writeFileSync(filePath, "# report\n");
    const manifest = store.createForPath({ sessionPath, ownerAgentId: "codia" });

    const file = engine.registerSessionFile({
      sessionPath,
      filePath,
      origin: "stage_files",
    });

    expect(file.sessionId).toBe(manifest.sessionId);
  });

  it("resolves session files by sessionId through the manifest current locator", () => {
    const sessionPath = path.join(tmpDir, "agents", "codia", "sessions", "alpha.jsonl");
    const filePath = path.join(tmpDir, "report.md");
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    fs.writeFileSync(filePath, "# report\n");
    const manifest = store.createForPath({ sessionPath, ownerAgentId: "codia" });
    const file = engine.registerSessionFile({
      sessionPath,
      filePath,
      origin: "stage_files",
    });
    engine._sessionFiles = new SessionFileRegistry({
      now: () => 5678,
      getSessionIdForPath: (lookupPath) => engine.getSessionIdForPath(lookupPath),
    });

    const restored = engine.getSessionFile(file.fileId || file.id, { sessionId: manifest.sessionId });

    expect(restored).toMatchObject({
      id: file.id,
      sessionId: manifest.sessionId,
      sessionPath,
      filePath,
    });
  });
});
