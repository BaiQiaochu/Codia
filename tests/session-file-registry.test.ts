// @ts-nocheck
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFileRegistry, sessionFilesCacheDir } from "../lib/session-files/session-file-registry.js";
import watermark from "../shared/dark-watermark.cjs";

const { extractInvisibleWatermarks } = watermark;

describe("SessionFileRegistry", () => {
  let tmpDir = null;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  function ensureTempDir() {
    if (!tmpDir) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codia-session-file-"));
    return tmpDir;
  }

  function makeTempFile(name, content = "hello") {
    const dir = ensureTempDir();
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function makeSessionPath(name = "main.jsonl") {
    const dir = path.join(ensureTempDir(), "agents", "codia", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    const sessionPath = path.join(dir, name);
    fs.writeFileSync(sessionPath, "{}\n");
    return sessionPath;
  }

  function readSidecar(sessionPath) {
    return JSON.parse(fs.readFileSync(`${sessionPath}.files.json`, "utf-8"));
  }

  it("persists file metadata in a per-session sidecar and hydrates it by sessionPath", () => {
    const filePath = makeTempFile("note.md", "# hello\n");
    const sessionPath = makeSessionPath();
    const registry = new SessionFileRegistry({ now: () => 1234 });

    const file = registry.registerFile({
      sessionPath,
      filePath,
      label: "Reading note",
      origin: "stage_files",
      storageKind: "external",
    });

    const raw = readSidecar(sessionPath);
    expect(raw.version).toBe(1);
    expect(raw.sessionPath).toBe(sessionPath);
    expect(raw.files[file.id]).toMatchObject({
      id: file.id,
      sessionPath,
      filePath,
      origin: "stage_files",
      storageKind: "external",
      status: "available",
    });
    expect(raw.refs).toEqual([
      expect.objectContaining({ fileId: file.id, origin: "stage_files" }),
    ]);

    const reloaded = new SessionFileRegistry({ now: () => 9999 });
    expect(reloaded.get(file.id, { sessionPath })).toEqual(file);
    expect(reloaded.list(sessionPath)).toEqual([file]);
  });

  it("uses sessionId as the stable owner for new file ids and managed cache dirs", () => {
    const filePath = makeTempFile("note.md", "# hello\n");
    const firstSessionPath = makeSessionPath("first.jsonl");
    const movedSessionPath = makeSessionPath("moved.jsonl");
    const registry = new SessionFileRegistry({ now: () => 1234 });

    const first = registry.registerFile({
      sessionId: "sess_files_1",
      sessionPath: firstSessionPath,
      filePath,
      origin: "stage_files",
      sourceKey: "source:stable",
    });
    const moved = registry.registerFile({
      sessionId: "sess_files_1",
      sessionPath: movedSessionPath,
      filePath,
      origin: "stage_files",
      sourceKey: "source:stable",
    });

    expect(moved.id).toBe(first.id);
    expect(first.sessionId).toBe("sess_files_1");
    expect(readSidecar(firstSessionPath).sessionId).toBe("sess_files_1");
    expect(readSidecar(movedSessionPath).sessionId).toBe("sess_files_1");
    expect(sessionFilesCacheDir(ensureTempDir(), { sessionId: "sess_files_1", sessionPath: firstSessionPath })).toBe(
      sessionFilesCacheDir(ensureTempDir(), { sessionId: "sess_files_1", sessionPath: movedSessionPath }),
    );
  });

  it("indexes loaded sidecars by sessionId while accepting moved path locators", () => {
    const filePath = makeTempFile("moved-id-sidecar/a.txt", "a");
    const oldSessionPath = makeSessionPath("old-id-owner.jsonl");
    const newSessionPath = makeSessionPath("new-id-owner.jsonl");
    const writer = new SessionFileRegistry({ now: () => 1234 });
    const entry = writer.registerFile({
      sessionId: "sess_files_moved",
      sessionPath: oldSessionPath,
      filePath,
      origin: "stage_files",
    });

    fs.renameSync(`${oldSessionPath}.files.json`, `${newSessionPath}.files.json`);
    const registry = new SessionFileRegistry({
      now: () => 5678,
      getSessionIdForPath: (sessionPath) => (
        sessionPath === oldSessionPath || sessionPath === newSessionPath
          ? "sess_files_moved"
          : null
      ),
    });

    expect(registry.list(newSessionPath)).toEqual([entry]);
    expect(registry._idsBySession.has("sess_files_moved")).toBe(true);
    expect(registry._idsBySession.has(oldSessionPath)).toBe(false);
    expect(registry._idsBySession.has(newSessionPath)).toBe(false);
    expect(registry.get(entry.id, { sessionPath: oldSessionPath })).toEqual(entry);
  });

  it("marks managed cache files expired when their session is cold for 72 hours", () => {
    const sessionPath = makeSessionPath("cold.jsonl");
    const managedPath = makeTempFile("managed/paste.png", "png-bytes");
    const externalPath = makeTempFile("external/note.txt", "keep");
    const old = (Date.now() - 73 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(sessionPath, old, old);
    const registry = new SessionFileRegistry({ now: () => Date.now() });

    const managed = registry.registerFile({
      sessionPath,
      filePath: managedPath,
      label: "paste.png",
      origin: "user_upload",
      storageKind: "managed_cache",
    });
    const external = registry.registerFile({
      sessionPath,
      filePath: externalPath,
      label: "note.txt",
      origin: "stage_files",
      storageKind: "external",
    });

    const result = registry.cleanupColdSessionFiles({ sessionPath });

    expect(result).toMatchObject({ sessionPath, cold: true, expired: 1, deleted: 1 });
    expect(fs.existsSync(managedPath)).toBe(false);
    expect(fs.existsSync(externalPath)).toBe(true);
    expect(registry.get(managed.id, { sessionPath })).toMatchObject({
      id: managed.id,
      status: "expired",
      storageKind: "managed_cache",
    });
    expect(registry.get(external.id, { sessionPath })).toMatchObject({
      id: external.id,
      status: "available",
      storageKind: "external",
    });
    expect(readSidecar(sessionPath).files[managed.id].status).toBe("expired");
  });

  it("keeps managed cache bytes while the session is still warm", () => {
    const sessionPath = makeSessionPath("warm.jsonl");
    const managedPath = makeTempFile("warm/paste.png", "png-bytes");
    const warm = (Date.now() - 71 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(sessionPath, warm, warm);
    const registry = new SessionFileRegistry({ now: () => Date.now() });

    const managed = registry.registerFile({
      sessionPath,
      filePath: managedPath,
      label: "paste.png",
      origin: "user_upload",
      storageKind: "managed_cache",
    });

    const result = registry.cleanupColdSessionFiles({ sessionPath });

    expect(result).toMatchObject({ sessionPath, cold: false, expired: 0, deleted: 0 });
    expect(fs.existsSync(managedPath)).toBe(true);
    expect(registry.get(managed.id, { sessionPath })).toMatchObject({ status: "available" });
  });

  it("adds dark provenance to managed text outputs without watermarking external files", () => {
    const sessionPath = makeSessionPath("watermark.jsonl");
    const managedPath = makeTempFile("managed/report.md", "# report\n");
    const externalPath = makeTempFile("external/reference.md", "# reference\n");
    const registry = new SessionFileRegistry({ now: () => 1234 });

    const managed = registry.registerFile({
      sessionPath,
      filePath: managedPath,
      label: "report.md",
      origin: "agent_artifact",
      storageKind: "managed_cache",
    });
    const external = registry.registerFile({
      sessionPath,
      filePath: externalPath,
      label: "reference.md",
      origin: "stage_files",
      storageKind: "external",
    });

    const managedText = fs.readFileSync(managedPath, "utf-8");
    expect(managedText).not.toBe("# report\n");
    expect(extractInvisibleWatermarks(managedText)).toEqual([
      expect.objectContaining({
        product: "Codia",
        source: "agent_artifact",
        sessionPath,
        filePath: fs.realpathSync(managedPath),
        origin: "agent_artifact",
      }),
    ]);
    expect(fs.readFileSync(externalPath, "utf-8")).toBe("# reference\n");

    const sidecar = readSidecar(sessionPath);
    expect(sidecar.files[managed.id].provenance).toMatchObject({
      product: "Codia",
      source: "agent_artifact",
      origin: "agent_artifact",
      applied: true,
      method: "text-invisible",
    });
    expect(sidecar.files[external.id].provenance).toMatchObject({
      product: "Codia",
      source: "stage_files",
      origin: "stage_files",
      applied: false,
      method: "session-sidecar",
    });
  });

  it("refuses to delete managed cache entries outside the configured session-files root", () => {
    const sessionPath = makeSessionPath("guard.jsonl");
    const outsidePath = makeTempFile("outside/paste.png", "png-bytes");
    const old = (Date.now() - 73 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(sessionPath, old, old);
    const registry = new SessionFileRegistry({
      now: () => Date.now(),
      managedCacheRoot: path.join(ensureTempDir(), "session-files"),
    });

    registry.registerFile({
      sessionPath,
      filePath: outsidePath,
      label: "paste.png",
      origin: "user_upload",
      storageKind: "managed_cache",
    });

    expect(() => registry.cleanupColdSessionFiles({ sessionPath }))
      .toThrow(/outside session-files root/);
    expect(fs.existsSync(outsidePath)).toBe(true);
  });

  it("reports corrupt sidecars instead of silently forgetting staged files", () => {
    const sessionPath = makeSessionPath("corrupt.jsonl");
    fs.writeFileSync(`${sessionPath}.files.json`, "{bad-json", "utf-8");
    const registry = new SessionFileRegistry();

    expect(() => registry.list(sessionPath)).toThrow(/failed to read session file sidecar/);
  });

  it("registers a file with a stable session-owned id and metadata", () => {
    const filePath = makeTempFile("note.md", "# hello\n");
    const sessionPath = makeSessionPath("stable.jsonl");
    const registry = new SessionFileRegistry({ now: () => 1234 });

    const first = registry.registerFile({
      sessionPath,
      filePath,
      label: "Reading note",
      origin: "stage_files",
    });
    const second = registry.registerFile({
      sessionPath,
      filePath,
      label: "Reading note",
      origin: "stage_files",
    });

    expect(first.id).toMatch(/^sf_[a-f0-9]{16}$/);
    expect(second.id).toBe(first.id);
    expect(first.sessionPath).toBe(sessionPath);
    expect(first.origin).toBe("stage_files");
    expect(first.filePath).toBe(filePath);
    expect(first.realPath).toBe(fs.realpathSync(filePath));
    expect(first.displayName).toBe("Reading note");
    expect(first.filename).toBe("note.md");
    expect(first.ext).toBe("md");
    expect(first.mime).toBe("text/markdown");
    expect(first.size).toBe(Buffer.byteLength("# hello\n"));
    expect(first.kind).toBe("document");
    expect(first.createdAt).toBe(1234);
    expect(registry.get(first.id)).toEqual(first);
    expect(registry.list(sessionPath)).toEqual([first]);
  });

  it("unloads one session file sidecar from runtime indexes without deleting the sidecar", () => {
    const fileA = makeTempFile("a.txt", "a");
    const fileB = makeTempFile("b.txt", "b");
    const sessionA = makeSessionPath("a.jsonl");
    const sessionB = makeSessionPath("b.jsonl");
    const registry = new SessionFileRegistry({ now: () => 1234 });
    const entryA = registry.registerFile({ sessionPath: sessionA, filePath: fileA, origin: "stage_files" });
    const entryB = registry.registerFile({ sessionPath: sessionB, filePath: fileB, origin: "stage_files" });

    expect(registry.unloadSession(sessionA)).toBe(true);

    expect(registry.get(entryA.id)).toBeNull();
    expect(registry.get(entryB.id)).toEqual(entryB);
    expect(fs.existsSync(`${sessionA}.files.json`)).toBe(true);
    expect(registry.get(entryA.id, { sessionPath: sessionA })).toEqual(entryA);
  });

  it("keeps one session file for the same truth source even when cache paths differ", () => {
    const firstCachePath = makeTempFile("cache/voice-a.weba", "audio bytes");
    const secondCachePath = makeTempFile("cache/voice-b.weba", "audio bytes");
    const sessionPath = makeSessionPath("source-key.jsonl");
    const registry = new SessionFileRegistry({ now: () => 1234 });
    const sourceKey = "upload:blob-content:v1:abc123";

    const first = registry.registerFile({
      sessionPath,
      filePath: firstCachePath,
      label: "voice 1.weba",
      origin: "voice_input",
      storageKind: "managed_cache",
      presentation: "voice-input",
      listed: false,
      sourceKey,
    });
    const second = registry.registerFile({
      sessionPath,
      filePath: secondCachePath,
      label: "voice 1.weba",
      origin: "voice_input",
      storageKind: "managed_cache",
      presentation: "voice-input",
      listed: false,
      sourceKey,
    });

    expect(second.id).toBe(first.id);
    expect(second.filePath).toBe(firstCachePath);
    expect(second.realPath).toBe(fs.realpathSync(firstCachePath));
    expect(registry.list(sessionPath)).toHaveLength(1);
    expect(readSidecar(sessionPath).files[first.id]).toMatchObject({
      id: first.id,
      filePath: firstCachePath,
      sourceKey,
    });

    const reloaded = new SessionFileRegistry({ now: () => 9999 });
    expect(reloaded.getBySourceKey(sourceKey, { sessionPath })).toMatchObject({
      id: first.id,
      filePath: firstCachePath,
      sourceKey,
    });
  });

  it("rejects registration without an explicit sessionPath", () => {
    const filePath = makeTempFile("a.txt", "a");
    const registry = new SessionFileRegistry();

    expect(() => registry.registerFile({ filePath, origin: "stage_files" }))
      .toThrow(/sessionPath is required/);
  });
});
