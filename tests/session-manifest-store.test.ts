import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_MANIFEST_DB_USER_VERSION,
  SessionManifestStore,
} from "../core/session-manifest/store.ts";
import { sessionLocatorKey } from "../core/session-manifest/path-normalizer.ts";

describe("SessionManifestStore", () => {
  let tmpDir;
  let store;
  let nextId;
  let nowIndex;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-session-manifest-"));
    nextId = 1;
    nowIndex = 0;
    store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => `sess_test_${String(nextId++).padStart(4, "0")}`,
      now: () => `2026-06-18T00:00:${String(nowIndex++).padStart(2, "0")}.000Z`,
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSessionFile(name) {
    const sessionPath = path.join(tmpDir, "sessions", `${name}.jsonl`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, "");
    return sessionPath;
  }

  it("creates one durable session identity for a session file path", () => {
    const sessionPath = createSessionFile("alpha");

    const manifest = store.createForPath({ sessionPath, domain: "home", kind: "chat" });
    const repeated = store.createForPath({ sessionPath, domain: "home", kind: "chat" });

    expect(manifest.sessionId).toBe("sess_test_0001");
    expect(repeated.sessionId).toBe(manifest.sessionId);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.domain).toBe("home");
    expect(manifest.kind).toBe("chat");
    expect(manifest.currentLocator.path).toBe(fs.realpathSync.native(sessionPath));
    expect(manifest.currentLocator.key).toBe(sessionLocatorKey(sessionPath));
    expect(manifest.memoryPolicy).toEqual({ mode: "inherit", inheritedFrom: "agent_default" });
    expect(manifest.permissionModeSnapshot.mode).toBe("ask");
    expect(store.getBySessionId(manifest.sessionId)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(sessionPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.db.pragma("user_version", { simple: true })).toBe(SESSION_MANIFEST_DB_USER_VERSION);
  });

  it("keeps previous locators resolvable when the session file moves", () => {
    const oldPath = createSessionFile("move-before");
    const nextPath = path.join(tmpDir, "archive", "move-after.jsonl");
    const manifest = store.createForPath({ sessionPath: oldPath, domain: "home" });
    const oldLocatorPath = fs.realpathSync.native(oldPath);
    fs.mkdirSync(path.dirname(nextPath), { recursive: true });
    fs.renameSync(oldPath, nextPath);

    const moved = store.updateLocator(manifest.sessionId, nextPath, "archive");

    expect(moved.currentLocator.path).toBe(fs.realpathSync.native(nextPath));
    expect(moved.currentLocator.reason).toBe("archive");
    expect(store.resolveByLocatorPath(oldPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(nextPath)?.sessionId).toBe(manifest.sessionId);
    expect(store.getLocatorHistory(manifest.sessionId)).toEqual([
      expect.objectContaining({
        path: oldLocatorPath,
        reason: "archive",
      }),
    ]);
  });

  it("updates locator and lifecycle together when a session is archived or restored", () => {
    const activePath = createSessionFile("lifecycle");
    const archivedPath = path.join(tmpDir, "sessions", "archived", "lifecycle.jsonl");
    const manifest = store.createForPath({ sessionPath: activePath, domain: "home" });
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.renameSync(activePath, archivedPath);

    const archived = store.updateLocatorLifecycle(manifest.sessionId, archivedPath, "archived", "archive");

    expect(archived).toMatchObject({
      sessionId: manifest.sessionId,
      lifecycle: "archived",
    });
    expect(archived.currentLocator.path).toBe(fs.realpathSync.native(archivedPath));
    expect(archived.currentLocator.reason).toBe("archive");
    expect(store.resolveByLocatorPath(activePath)?.sessionId).toBe(manifest.sessionId);
    expect(store.resolveByLocatorPath(archivedPath)?.lifecycle).toBe("archived");

    fs.renameSync(archivedPath, activePath);
    const restored = store.updateLocatorLifecycle(manifest.sessionId, activePath, "active", "restore");

    expect(restored.lifecycle).toBe("active");
    expect(restored.currentLocator.path).toBe(fs.realpathSync.native(activePath));
    expect(restored.currentLocator.reason).toBe("restore");
  });

  it("updates manifest-owned policy, workspace, plugin, and thinking fields by session id", () => {
    const sessionPath = createSessionFile("fields");
    const manifest = store.createForPath({ sessionPath, domain: "home", kind: "chat" });

    store.setMemoryPolicy(manifest.sessionId, { mode: "disabled", inheritedFrom: "session_override" });
    store.setPermissionModeSnapshot(manifest.sessionId, { mode: "operate", source: "session_override" });
    store.setThinkingLevel(manifest.sessionId, "high");
    store.setWorkspaceScope(manifest.sessionId, {
      primaryCwd: tmpDir,
      workspaceFolders: [path.join(tmpDir, "workspace")],
      authorizedFolders: [path.join(tmpDir, "allowed")],
    });
    store.setPlugin(manifest.sessionId, {
      ownerPluginId: "image-gen",
      kind: "media",
      visibility: "private",
    });

    expect(store.getBySessionId(manifest.sessionId)).toMatchObject({
      memoryPolicy: { mode: "disabled", inheritedFrom: "session_override" },
      permissionModeSnapshot: { mode: "operate", source: "session_override" },
      thinkingLevel: "high",
      workspaceScope: {
        primaryCwd: tmpDir,
        workspaceFolders: [path.join(tmpDir, "workspace")],
        authorizedFolders: [path.join(tmpDir, "allowed")],
      },
      plugin: {
        ownerPluginId: "image-gen",
        kind: "media",
        visibility: "private",
      },
    });
  });

  it("reports repairable conflicts instead of assigning one locator to two sessions", () => {
    const firstPath = createSessionFile("first");
    const secondPath = createSessionFile("second");
    const first = store.createForPath({ sessionPath: firstPath, domain: "home" });
    const second = store.createForPath({ sessionPath: secondPath, domain: "home" });

    expect(() => store.updateLocator(second.sessionId, firstPath, "repair")).toThrow(
      expect.objectContaining({
        code: "session_locator_conflict",
      }),
    );

    expect(store.resolveByLocatorPath(firstPath)?.sessionId).toBe(first.sessionId);
    expect(store.getBySessionId(second.sessionId)?.currentLocator.path).toBe(
      fs.realpathSync.native(secondPath),
    );
  });

  it("persists migration state in the manifest database", () => {
    expect(store.getState("legacy-session-manifest-scan-v1")).toBeNull();

    store.setState("legacy-session-manifest-scan-v1", {
      checkpointDirectory: path.join(tmpDir, "checkpoints", "one"),
      completedAt: "2026-06-18T00:01:00.000Z",
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });

    expect(store.getState("legacy-session-manifest-scan-v1")).toEqual({
      checkpointDirectory: path.join(tmpDir, "checkpoints", "one"),
      completedAt: "2026-06-18T00:01:00.000Z",
      result: { scanned: 1, created: 1, existing: 0, skipped: 0 },
    });
  });
});
