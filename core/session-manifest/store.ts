import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { generateSessionId } from "./id.ts";
import { normalizeSessionLocatorPath, sessionLocatorKey } from "./path-normalizer.ts";

export const SESSION_MANIFEST_SCHEMA_VERSION = 1;
export const SESSION_MANIFEST_DB_USER_VERSION = 1;

const require = createRequire(import.meta.url);
let BetterSqliteDatabase = null;

export function loadBetterSqliteDatabase() {
  if (!BetterSqliteDatabase) {
    const mod = require("better-sqlite3");
    BetterSqliteDatabase = mod?.default || mod;
  }
  return BetterSqliteDatabase;
}

export class SessionManifestError extends Error {
  declare code: string;
  declare details: any;

  constructor(code, message, details = {}) {
    super(message);
    this.name = "SessionManifestError";
    this.code = code;
    this.details = details;
  }
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJson(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function pickString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function defaultMemoryPolicy(input: any = {}) {
  return {
    mode: input.mode || "inherit",
    inheritedFrom: input.inheritedFrom || "agent_default",
  };
}

function defaultPermissionModeSnapshot(input: any = {}, capturedAt) {
  return {
    mode: input.mode || "ask",
    source: input.source || "global_default_at_create",
    capturedAt: input.capturedAt || capturedAt,
  };
}

function toRowManifest(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schema_version,
    sessionId: row.session_id,
    ownerAgentId: row.owner_agent_id || null,
    domain: row.domain,
    kind: row.kind,
    lifecycle: row.lifecycle,
    health: row.health,
    currentLocator: {
      type: row.current_locator_type,
      path: row.current_locator_path,
      key: row.current_locator_key,
      reason: row.current_locator_reason || null,
      updatedAt: row.locator_updated_at || row.updated_at,
    },
    memoryPolicy: parseJson(row.memory_policy_json, defaultMemoryPolicy()),
    permissionModeSnapshot: parseJson(
      row.permission_mode_snapshot_json,
      defaultPermissionModeSnapshot({}, row.created_at),
    ),
    thinkingLevel: row.thinking_level || null,
    pinnedAt: row.pinned_at || null,
    workspaceScope: parseJson(row.workspace_scope_json, {}),
    plugin: parseJson(row.plugin_json, null),
    provenance: parseJson(row.provenance_json, {}),
    migration: parseJson(row.migration_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

function toHistoryLocator(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    type: row.locator_type,
    path: row.locator_path,
    key: row.locator_key,
    reason: row.reason || null,
    createdAt: row.created_at,
  };
}

export class SessionManifestStore {
  declare db: any;
  declare _stmts: any;
  declare _now: any;
  declare _idGenerator: any;

  constructor(opts: any = {}) {
    if (!opts.dbPath) {
      throw new Error("SessionManifestStore requires dbPath");
    }

    fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    const Database = opts.Database || loadBetterSqliteDatabase();
    this.db = new Database(opts.dbPath);
    this._now = opts.now || (() => new Date().toISOString());
    this._idGenerator = opts.idGenerator || (() => generateSessionId());

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -16000");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("mmap_size = 30000000");
    this._initSchema();
    this._migrate();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_manifests (
        session_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        owner_agent_id TEXT,
        domain TEXT NOT NULL,
        kind TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        health TEXT NOT NULL,
        current_locator_type TEXT NOT NULL,
        current_locator_path TEXT NOT NULL,
        current_locator_key TEXT NOT NULL UNIQUE,
        current_locator_reason TEXT,
        locator_updated_at TEXT NOT NULL,
        memory_policy_json TEXT NOT NULL,
        permission_mode_snapshot_json TEXT NOT NULL,
        thinking_level TEXT,
        pinned_at TEXT,
        workspace_scope_json TEXT NOT NULL,
        plugin_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        migration_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_session_manifests_domain
        ON session_manifests(domain, lifecycle, updated_at);
      CREATE INDEX IF NOT EXISTS idx_session_manifests_pinned
        ON session_manifests(pinned_at);
      CREATE INDEX IF NOT EXISTS idx_session_manifests_owner
        ON session_manifests(owner_agent_id);

      CREATE TABLE IF NOT EXISTS session_locator_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        locator_type TEXT NOT NULL,
        locator_path TEXT NOT NULL,
        locator_key TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(locator_key),
        FOREIGN KEY(session_id) REFERENCES session_manifests(session_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_locator_history_session
        ON session_locator_history(session_id, created_at);

      CREATE TABLE IF NOT EXISTS session_manifest_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  _migrate() {
    const current = this.db.pragma("user_version", { simple: true });
    if (current >= SESSION_MANIFEST_DB_USER_VERSION) return;

    this.db.transaction(() => {
      let version = current;
      while (version < SESSION_MANIFEST_DB_USER_VERSION) {
        switch (version) {
          case 0:
            break;
        }
        version++;
      }
      this.db.pragma(`user_version = ${SESSION_MANIFEST_DB_USER_VERSION}`);
    })();
  }

  _prepareStatements() {
    this._stmts = {
      insertManifest: this.db.prepare(`
        INSERT INTO session_manifests (
          session_id,
          schema_version,
          owner_agent_id,
          domain,
          kind,
          lifecycle,
          health,
          current_locator_type,
          current_locator_path,
          current_locator_key,
          current_locator_reason,
          locator_updated_at,
          memory_policy_json,
          permission_mode_snapshot_json,
          thinking_level,
          pinned_at,
          workspace_scope_json,
          plugin_json,
          provenance_json,
          migration_json,
          created_at,
          updated_at,
          deleted_at
        ) VALUES (
          @sessionId,
          @schemaVersion,
          @ownerAgentId,
          @domain,
          @kind,
          @lifecycle,
          @health,
          @currentLocatorType,
          @currentLocatorPath,
          @currentLocatorKey,
          @currentLocatorReason,
          @locatorUpdatedAt,
          @memoryPolicyJson,
          @permissionModeSnapshotJson,
          @thinkingLevel,
          @pinnedAt,
          @workspaceScopeJson,
          @pluginJson,
          @provenanceJson,
          @migrationJson,
          @createdAt,
          @updatedAt,
          @deletedAt
        )
      `),
      getById: this.db.prepare("SELECT * FROM session_manifests WHERE session_id = ?"),
      getByCurrentLocator: this.db.prepare("SELECT * FROM session_manifests WHERE current_locator_key = ?"),
      getByHistoryLocator: this.db.prepare(`
        SELECT m.*
        FROM session_locator_history h
        JOIN session_manifests m ON m.session_id = h.session_id
        WHERE h.locator_key = ?
      `),
      getHistoryLocator: this.db.prepare(`
        SELECT * FROM session_locator_history WHERE locator_key = ?
      `),
      listHistory: this.db.prepare(`
        SELECT * FROM session_locator_history
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC
      `),
      insertHistory: this.db.prepare(`
        INSERT INTO session_locator_history (
          session_id,
          locator_type,
          locator_path,
          locator_key,
          reason,
          created_at
        ) VALUES (
          @sessionId,
          @locatorType,
          @locatorPath,
          @locatorKey,
          @reason,
          @createdAt
        )
      `),
      deleteHistoryForLocator: this.db.prepare(`
        DELETE FROM session_locator_history
        WHERE session_id = ? AND locator_key = ?
      `),
      updateLocator: this.db.prepare(`
        UPDATE session_manifests
        SET
          current_locator_type = @currentLocatorType,
          current_locator_path = @currentLocatorPath,
          current_locator_key = @currentLocatorKey,
          current_locator_reason = @currentLocatorReason,
          locator_updated_at = @locatorUpdatedAt,
          updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      updateLocatorLifecycle: this.db.prepare(`
        UPDATE session_manifests
        SET
          lifecycle = @lifecycle,
          current_locator_type = @currentLocatorType,
          current_locator_path = @currentLocatorPath,
          current_locator_key = @currentLocatorKey,
          current_locator_reason = @currentLocatorReason,
          locator_updated_at = @locatorUpdatedAt,
          updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setPinnedAt: this.db.prepare(`
        UPDATE session_manifests
        SET pinned_at = @pinnedAt, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setPlugin: this.db.prepare(`
        UPDATE session_manifests
        SET plugin_json = @pluginJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setMemoryPolicy: this.db.prepare(`
        UPDATE session_manifests
        SET memory_policy_json = @memoryPolicyJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setPermissionModeSnapshot: this.db.prepare(`
        UPDATE session_manifests
        SET permission_mode_snapshot_json = @permissionModeSnapshotJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setThinkingLevel: this.db.prepare(`
        UPDATE session_manifests
        SET thinking_level = @thinkingLevel, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      setWorkspaceScope: this.db.prepare(`
        UPDATE session_manifests
        SET workspace_scope_json = @workspaceScopeJson, updated_at = @updatedAt
        WHERE session_id = @sessionId
      `),
      getState: this.db.prepare("SELECT value_json FROM session_manifest_state WHERE key = ?"),
      setState: this.db.prepare(`
        INSERT INTO session_manifest_state (
          key,
          value_json,
          updated_at
        ) VALUES (
          @key,
          @valueJson,
          @updatedAt
        )
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `),
      list: this.db.prepare("SELECT * FROM session_manifests ORDER BY updated_at DESC"),
    };
  }

  createForPath(input) {
    const locator = this._locatorFromPath(input.sessionPath);
    const existing = this._findByLocator(locator.key);
    if (existing) return existing;

    const createdAt = this._now();
    const memoryPolicy = defaultMemoryPolicy(input.memoryPolicy);
    const permissionModeSnapshot = defaultPermissionModeSnapshot(
      input.permissionModeSnapshot,
      createdAt,
    );

    return this.db.transaction(() => {
      const conflict = this._findByLocator(locator.key);
      if (conflict) return conflict;

      const sessionId = this._generateUniqueSessionId();
      this._stmts.insertManifest.run({
        sessionId,
        schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
        ownerAgentId: input.ownerAgentId || null,
        domain: input.domain || "home",
        kind: input.kind || "chat",
        lifecycle: input.lifecycle || "active",
        health: input.health || "ok",
        currentLocatorType: locator.type,
        currentLocatorPath: locator.path,
        currentLocatorKey: locator.key,
        currentLocatorReason: input.locatorReason || "create",
        locatorUpdatedAt: createdAt,
        memoryPolicyJson: stringifyJson(memoryPolicy, defaultMemoryPolicy()),
        permissionModeSnapshotJson: stringifyJson(
          permissionModeSnapshot,
          defaultPermissionModeSnapshot({}, createdAt),
        ),
        thinkingLevel: input.thinkingLevel || null,
        pinnedAt: input.pinnedAt || null,
        workspaceScopeJson: stringifyJson(input.workspaceScope, {}),
        pluginJson: stringifyJson(input.plugin, null),
        provenanceJson: stringifyJson(input.provenance, {}),
        migrationJson: stringifyJson(input.migration, {}),
        createdAt,
        updatedAt: createdAt,
        deletedAt: input.deletedAt || null,
      });
      return this.getBySessionId(sessionId);
    })();
  }

  getBySessionId(sessionId) {
    return toRowManifest(this._stmts.getById.get(sessionId));
  }

  resolveByLocatorPath(sessionPath) {
    const locator = this._locatorFromPath(sessionPath);
    return this._findByLocator(locator.key);
  }

  updateLocator(sessionId, nextSessionPath, reason = "update") {
    const nextLocator = this._locatorFromPath(nextSessionPath);
    return this.db.transaction(() => {
      const manifest = this.getBySessionId(sessionId);
      if (!manifest) {
        throw new SessionManifestError(
          "session_manifest_not_found",
          `Session manifest not found: ${sessionId}`,
          { sessionId },
        );
      }

      if (manifest.currentLocator.key === nextLocator.key) {
        return manifest;
      }

      this._assertLocatorAvailable(nextLocator.key, sessionId);

      const changedAt = this._now();
      this._insertHistoryLocator({
        sessionId,
        locatorType: manifest.currentLocator.type,
        locatorPath: manifest.currentLocator.path,
        locatorKey: manifest.currentLocator.key,
        reason,
        createdAt: changedAt,
      });
      this._stmts.deleteHistoryForLocator.run(sessionId, nextLocator.key);
      this._stmts.updateLocator.run({
        sessionId,
        currentLocatorType: nextLocator.type,
        currentLocatorPath: nextLocator.path,
        currentLocatorKey: nextLocator.key,
        currentLocatorReason: reason,
        locatorUpdatedAt: changedAt,
        updatedAt: changedAt,
      });
      return this.getBySessionId(sessionId);
    })();
  }

  updateLocatorLifecycle(sessionId, nextSessionPath, lifecycle, reason = "update") {
    const nextLifecycle = pickString(lifecycle);
    if (!nextLifecycle) {
      throw new SessionManifestError(
        "session_manifest_lifecycle_required",
        "Session manifest lifecycle is required.",
        { sessionId, lifecycle },
      );
    }
    const nextLocator = this._locatorFromPath(nextSessionPath);
    return this.db.transaction(() => {
      const manifest = this.getBySessionId(sessionId);
      if (!manifest) {
        throw new SessionManifestError(
          "session_manifest_not_found",
          `Session manifest not found: ${sessionId}`,
          { sessionId },
        );
      }

      if (manifest.currentLocator.key !== nextLocator.key) {
        this._assertLocatorAvailable(nextLocator.key, sessionId);
        const changedAt = this._now();
        this._insertHistoryLocator({
          sessionId,
          locatorType: manifest.currentLocator.type,
          locatorPath: manifest.currentLocator.path,
          locatorKey: manifest.currentLocator.key,
          reason,
          createdAt: changedAt,
        });
        this._stmts.deleteHistoryForLocator.run(sessionId, nextLocator.key);
        this._stmts.updateLocatorLifecycle.run({
          sessionId,
          lifecycle: nextLifecycle,
          currentLocatorType: nextLocator.type,
          currentLocatorPath: nextLocator.path,
          currentLocatorKey: nextLocator.key,
          currentLocatorReason: reason,
          locatorUpdatedAt: changedAt,
          updatedAt: changedAt,
        });
        return this.getBySessionId(sessionId);
      }

      const updatedAt = this._now();
      this._stmts.updateLocatorLifecycle.run({
        sessionId,
        lifecycle: nextLifecycle,
        currentLocatorType: nextLocator.type,
        currentLocatorPath: nextLocator.path,
        currentLocatorKey: nextLocator.key,
        currentLocatorReason: reason,
        locatorUpdatedAt: updatedAt,
        updatedAt,
      });
      return this.getBySessionId(sessionId);
    })();
  }

  getLocatorHistory(sessionId) {
    return this._stmts.listHistory.all(sessionId).map(toHistoryLocator);
  }

  setPinnedAt(sessionId, pinnedAt) {
    const updatedAt = this._now();
    this._stmts.setPinnedAt.run({
      sessionId,
      pinnedAt: pinnedAt || null,
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setPlugin(sessionId, plugin) {
    const updatedAt = this._now();
    this._stmts.setPlugin.run({
      sessionId,
      pluginJson: stringifyJson(plugin, null),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setMemoryPolicy(sessionId, memoryPolicy) {
    const updatedAt = this._now();
    this._stmts.setMemoryPolicy.run({
      sessionId,
      memoryPolicyJson: stringifyJson(defaultMemoryPolicy(memoryPolicy), defaultMemoryPolicy()),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setPermissionModeSnapshot(sessionId, snapshot) {
    const updatedAt = this._now();
    this._stmts.setPermissionModeSnapshot.run({
      sessionId,
      permissionModeSnapshotJson: stringifyJson(
        defaultPermissionModeSnapshot(snapshot, updatedAt),
        defaultPermissionModeSnapshot({}, updatedAt),
      ),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setThinkingLevel(sessionId, thinkingLevel) {
    const updatedAt = this._now();
    this._stmts.setThinkingLevel.run({
      sessionId,
      thinkingLevel: thinkingLevel || null,
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  setWorkspaceScope(sessionId, workspaceScope) {
    const updatedAt = this._now();
    this._stmts.setWorkspaceScope.run({
      sessionId,
      workspaceScopeJson: stringifyJson(workspaceScope, {}),
      updatedAt,
    });
    return this.getBySessionId(sessionId);
  }

  list() {
    return this._stmts.list.all().map(toRowManifest);
  }

  getState(key) {
    const row = this._stmts.getState.get(key);
    return parseJson(row?.value_json, null);
  }

  setState(key, value) {
    this._stmts.setState.run({
      key,
      valueJson: JSON.stringify(value ?? null),
      updatedAt: this._now(),
    });
    return this.getState(key);
  }

  close() {
    this.db?.close();
  }

  _locatorFromPath(sessionPath) {
    const locatorPath = normalizeSessionLocatorPath(sessionPath);
    return {
      type: "jsonl",
      path: locatorPath,
      key: sessionLocatorKey(locatorPath),
    };
  }

  _findByLocator(locatorKey) {
    const current = toRowManifest(this._stmts.getByCurrentLocator.get(locatorKey));
    const history = toRowManifest(this._stmts.getByHistoryLocator.get(locatorKey));
    if (current && history && current.sessionId !== history.sessionId) {
      throw new SessionManifestError(
        "session_locator_conflict",
        "Session locator is claimed by multiple manifests; repair is required before opening this session.",
        {
          locatorKey,
          currentSessionId: current.sessionId,
          historySessionId: history.sessionId,
        },
      );
    }
    return current || history || null;
  }

  _assertLocatorAvailable(locatorKey, sessionId) {
    const current = this._stmts.getByCurrentLocator.get(locatorKey);
    if (current && current.session_id !== sessionId) {
      throw this._conflict(locatorKey, sessionId, current.session_id);
    }

    const history = this._stmts.getHistoryLocator.get(locatorKey);
    if (history && history.session_id !== sessionId) {
      throw this._conflict(locatorKey, sessionId, history.session_id);
    }
  }

  _insertHistoryLocator(locator) {
    try {
      this._stmts.insertHistory.run(locator);
    } catch (error) {
      if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
        const existing = this._stmts.getHistoryLocator.get(locator.locatorKey);
        if (existing?.session_id === locator.sessionId) return;
        throw this._conflict(locator.locatorKey, locator.sessionId, existing?.session_id || null);
      }
      throw error;
    }
  }

  _conflict(locatorKey, requestedSessionId, existingSessionId) {
    return new SessionManifestError(
      "session_locator_conflict",
      "Session locator conflict; repair is required before this locator can be reassigned.",
      { locatorKey, requestedSessionId, existingSessionId },
    );
  }

  _generateUniqueSessionId() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const sessionId = this._idGenerator();
      if (!this._stmts.getById.get(sessionId)) return sessionId;
    }
    throw new SessionManifestError(
      "session_id_generation_failed",
      "Could not generate a unique session id.",
    );
  }
}
