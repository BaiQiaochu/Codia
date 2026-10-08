import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManifestResolver } from "../core/session-manifest/resolver.ts";
import { SessionManifestStore } from "../core/session-manifest/store.ts";

describe("SessionManifestResolver", () => {
  let tmpDir;
  let store;
  let resolver;
  let nextId;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-session-resolver-"));
    nextId = 1;
    store = new SessionManifestStore({
      dbPath: path.join(tmpDir, "session-manifest.db"),
      idGenerator: () => `sess_resolver_${String(nextId++).padStart(4, "0")}`,
      now: () => "2026-06-18T01:00:00.000Z",
    });
    resolver = new SessionManifestResolver({ store });
  });

  afterEach(() => {
    store?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSessionFile(name) {
    const sessionPath = path.join(tmpDir, "agents", "gsap", "sessions", `${name}.jsonl`);
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fs.writeFileSync(sessionPath, [
      JSON.stringify({ type: "session", version: 3, id: name, timestamp: "2026-06-18T01:00:00.000Z", cwd: tmpDir }),
      "",
    ].join("\n"));
    return sessionPath;
  }

  it("resolves stable identity by sessionId or legacy sessionPath", () => {
    const sessionPath = createSessionFile("alpha");
    const manifest = store.createForPath({ sessionPath, domain: "desktop" });

    expect(resolver.resolve({ sessionId: manifest.sessionId }).sessionId).toBe(manifest.sessionId);
    expect(resolver.resolve({ sessionPath }).sessionId).toBe(manifest.sessionId);
    expect(resolver.resolve({ path: sessionPath }).sessionId).toBe(manifest.sessionId);
  });

  it("lets sessionId win when a legacy path field is stale", () => {
    const sessionPath = createSessionFile("primary");
    const stalePath = createSessionFile("stale");
    const manifest = store.createForPath({ sessionPath, domain: "desktop" });
    const stale = store.createForPath({ sessionPath: stalePath, domain: "desktop" });

    expect(resolver.resolve({ sessionId: manifest.sessionId, sessionPath: stalePath }).sessionId).toBe(
      manifest.sessionId,
    );
    expect(stale.sessionId).not.toBe(manifest.sessionId);
  });

  it("returns an explicit SessionRef with legacy path provenance", () => {
    const sessionPath = createSessionFile("ref-primary");
    const stalePath = createSessionFile("ref-stale");
    const manifest = store.createForPath({ sessionPath, domain: "desktop" });
    store.createForPath({ sessionPath: stalePath, domain: "desktop" });

    expect(resolver.resolveRef({ sessionId: manifest.sessionId, sessionPath: stalePath })).toEqual({
      sessionId: manifest.sessionId,
      sessionPath: manifest.currentLocator.path,
      legacySessionPath: stalePath,
    });
    expect(resolver.resolveRef({ sessionPath })).toEqual({
      sessionId: manifest.sessionId,
      sessionPath: manifest.currentLocator.path,
      legacySessionPath: sessionPath,
    });
  });

  it("creates a manifest on demand only for an existing legacy JSONL session", () => {
    const sessionPath = createSessionFile("legacy");

    const manifest = resolver.resolve({ sessionPath }, {
      createOnDemand: true,
      manifestDefaults: { domain: "desktop", ownerAgentId: "gsap" },
    });

    expect(manifest.sessionId).toBe("sess_resolver_0001");
    expect(manifest.ownerAgentId).toBe("gsap");
    expect(store.resolveByLocatorPath(sessionPath)?.sessionId).toBe(manifest.sessionId);
  });

  it("rejects missing legacy paths instead of silently inventing a session", () => {
    const missingPath = path.join(tmpDir, "agents", "gsap", "sessions", "missing.jsonl");

    expect(() => resolver.resolve({ sessionPath: missingPath })).toThrow(
      expect.objectContaining({
        code: "session_manifest_not_found",
      }),
    );
  });

  it("surfaces repairable locator conflicts", () => {
    const firstPath = createSessionFile("first");
    const secondPath = createSessionFile("second");
    const first = store.createForPath({ sessionPath: firstPath, domain: "desktop" });
    const second = store.createForPath({ sessionPath: secondPath, domain: "desktop" });
    store.db.prepare(`
      INSERT INTO session_locator_history (
        session_id,
        locator_type,
        locator_path,
        locator_key,
        reason,
        created_at
      ) VALUES (?, 'jsonl', ?, ?, 'test-conflict', '2026-06-18T01:00:00.000Z')
    `).run(second.sessionId, first.currentLocator.path, first.currentLocator.key);

    expect(() => resolver.resolve({ sessionPath: firstPath })).toThrow(
      expect.objectContaining({
        code: "session_locator_conflict",
      }),
    );
  });
});
