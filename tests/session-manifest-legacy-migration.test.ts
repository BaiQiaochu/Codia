import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateLegacySessions } from "../core/session-manifest/legacy-migration.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("session manifest legacy migration", () => {
  let gsapHome;
  let store;
  let nextId;

  beforeEach(() => {
    gsapHome = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-manifest-migration-"));
    nextId = 1;
    store = new SessionManifestStore({
      dbPath: path.join(gsapHome, "session-manifest.db"),
      idGenerator: () => `sess_migrate_${String(nextId++).padStart(4, "0")}`,
      now: () => "2026-06-18T03:00:00.000Z",
    });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(gsapHome, { recursive: true, force: true });
  });

  function writeSession(agentId, fileName, { archived = false } = {}) {
    const sessionDir = path.join(gsapHome, "agents", agentId, "sessions");
    const targetDir = archived ? path.join(sessionDir, "archived") : sessionDir;
    const sessionPath = path.join(targetDir, fileName);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: fileName, timestamp: "2026-06-18T03:00:00.000Z", cwd: gsapHome }),
      "",
    ].join("\n"));
    return { sessionDir, sessionPath };
  }

  it("creates manifests for active and archived legacy sessions with sidecar semantics", () => {
    const active = writeSession("gsap", "active.jsonl");
    const archived = writeSession("gsap", "old.jsonl", { archived: true });
    fs.writeFileSync(path.join(active.sessionDir, "session-meta.json"), JSON.stringify({
      "active.jsonl": {
        pinnedAt: "2026-06-18T03:01:00.000Z",
        memoryEnabled: false,
        permissionMode: "auto",
        thinkingLevel: "high",
        workspaceFolders: ["/workspace/a"],
        plugin: {
          ownerPluginId: "image-gen",
          kind: "media",
          visibility: "private",
        },
      },
      "old.jsonl": {
        memoryEnabled: true,
        accessMode: "read_only",
      },
    }, null, 2));
    fs.writeFileSync(path.join(active.sessionDir, "session-titles.json"), JSON.stringify({
      [active.sessionPath]: "Active title",
      [path.join(active.sessionDir, "old.jsonl")]: "Archived title",
    }, null, 2));

    const result = migrateLegacySessions({
      gsapHome,
      store,
      migratedAt: "2026-06-18T03:02:00.000Z",
    });

    expect(result).toEqual({ scanned: 2, created: 2, existing: 0, skipped: 0 });
    const activeManifest = store.resolveByLocatorPath(active.sessionPath);
    const archivedManifest = store.resolveByLocatorPath(archived.sessionPath);

    expect(activeManifest).toMatchObject({
      sessionId: "sess_migrate_0001",
      ownerAgentId: "gsap",
      domain: "desktop",
      kind: "media",
      lifecycle: "active",
      pinnedAt: "2026-06-18T03:01:00.000Z",
      memoryPolicy: { mode: "disabled", inheritedFrom: "legacy_session_meta" },
      permissionModeSnapshot: {
        mode: "auto",
        source: "legacy_session_meta",
        capturedAt: "2026-06-18T03:02:00.000Z",
      },
      thinkingLevel: "high",
      workspaceScope: {
        workspaceFolders: ["/workspace/a"],
      },
      plugin: {
        ownerPluginId: "image-gen",
        kind: "media",
        visibility: "private",
      },
      provenance: {
        legacyTitle: "Active title",
        legacyAgentId: "gsap",
      },
      migration: {
        legacySessionPath: active.sessionPath,
        source: "legacy_scan",
      },
    });
    expect(archivedManifest).toMatchObject({
      sessionId: "sess_migrate_0002",
      ownerAgentId: "gsap",
      lifecycle: "archived",
      memoryPolicy: { mode: "enabled", inheritedFrom: "legacy_session_meta" },
      permissionModeSnapshot: {
        mode: "read_only",
        source: "legacy_session_meta",
      },
      provenance: {
        legacyTitle: "Archived title",
      },
    });
  });

  it("is idempotent when rerun over the same legacy files", () => {
    const active = writeSession("gsap", "active.jsonl");

    const first = migrateLegacySessions({ gsapHome, store, migratedAt: "2026-06-18T03:02:00.000Z" });
    const second = migrateLegacySessions({ gsapHome, store, migratedAt: "2026-06-18T03:03:00.000Z" });

    expect(first).toEqual({ scanned: 1, created: 1, existing: 0, skipped: 0 });
    expect(second).toEqual({ scanned: 1, created: 0, existing: 1, skipped: 0 });
    expect(store.resolveByLocatorPath(active.sessionPath)?.sessionId).toBe("sess_migrate_0001");
    expect(store.list()).toHaveLength(1);
  });
});
