import fs from "fs";
import path from "path";
import { normalizeSessionPermissionMode } from "../session-permission-mode.ts";
import {
  readDirectoryLikeDirentsSync,
  readFileLikePathsSync,
} from "../../shared/link-aware-fs.ts";

function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function listDirectories(directory) {
  try {
    return readDirectoryLikeDirentsSync(directory).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listJsonlFiles(directory) {
  try {
    return readFileLikePathsSync(directory, { extension: ".jsonl" });
  } catch {
    return [];
  }
}

function resolveCodiaHome(opts: any = {}) {
  return opts.codiaHome || opts.codiaHome || null;
}

function hasLegacyPermissionFields(metaEntry) {
  return typeof metaEntry?.permissionMode === "string"
    || typeof metaEntry?.accessMode === "string"
    || typeof metaEntry?.planMode === "boolean";
}

function legacyMemoryPolicy(metaEntry) {
  if (metaEntry?.memoryEnabled === true) {
    return { mode: "enabled", inheritedFrom: "legacy_session_meta" };
  }
  if (metaEntry?.memoryEnabled === false) {
    return { mode: "disabled", inheritedFrom: "legacy_session_meta" };
  }
  return { mode: "inherit", inheritedFrom: "agent_default" };
}

function legacyWorkspaceScope(metaEntry) {
  const workspaceScope: any = {};
  if (Array.isArray(metaEntry?.workspaceFolders)) {
    workspaceScope.workspaceFolders = metaEntry.workspaceFolders.filter((item) => typeof item === "string");
  }
  if (Array.isArray(metaEntry?.authorizedFolders)) {
    workspaceScope.authorizedFolders = metaEntry.authorizedFolders.filter((item) => typeof item === "string");
  }
  if (typeof metaEntry?.primaryCwd === "string") {
    workspaceScope.primaryCwd = metaEntry.primaryCwd;
  }
  const mountId = typeof metaEntry?.workspaceMountId === "string"
    ? metaEntry.workspaceMountId
    : (typeof metaEntry?.mountId === "string" ? metaEntry.mountId : null);
  if (mountId) {
    workspaceScope.workspaceMount = {
      mountId,
      ...(typeof metaEntry?.workspaceLabel === "string" ? { label: metaEntry.workspaceLabel } : {}),
    };
  }
  return workspaceScope;
}

function legacyPlugin(metaEntry) {
  const plugin = metaEntry?.plugin && typeof metaEntry.plugin === "object" ? metaEntry.plugin : null;
  if (!plugin) return null;
  return {
    ownerPluginId: typeof plugin.ownerPluginId === "string" ? plugin.ownerPluginId : null,
    kind: typeof plugin.kind === "string" ? plugin.kind : null,
    visibility: typeof plugin.visibility === "string" ? plugin.visibility : "public",
  };
}

function legacyTitleFor(titles, sessionDir, sessionPath) {
  const activePath = path.join(sessionDir, path.basename(sessionPath));
  return titles[sessionPath] || titles[activePath] || titles[path.basename(sessionPath)] || null;
}

function buildLegacyManifestInput({
  agentId,
  sessionDir,
  sessionPath,
  lifecycle,
  meta,
  titles,
  migratedAt,
}) {
  const metaEntry = meta[path.basename(sessionPath)] && typeof meta[path.basename(sessionPath)] === "object"
    ? meta[path.basename(sessionPath)]
    : {};
  const plugin = legacyPlugin(metaEntry);
  const permissionHasLegacySource = hasLegacyPermissionFields(metaEntry);
  return {
    sessionPath,
    ownerAgentId: agentId,
    domain: "desktop",
    kind: plugin?.kind || "chat",
    lifecycle,
    memoryPolicy: legacyMemoryPolicy(metaEntry),
    permissionModeSnapshot: {
      mode: normalizeSessionPermissionMode(metaEntry),
      source: permissionHasLegacySource ? "legacy_session_meta" : "migration_default",
      capturedAt: migratedAt,
    },
    thinkingLevel: typeof metaEntry?.thinkingLevel === "string" ? metaEntry.thinkingLevel : null,
    pinnedAt: typeof metaEntry?.pinnedAt === "string" ? metaEntry.pinnedAt : null,
    workspaceScope: legacyWorkspaceScope(metaEntry),
    plugin,
    provenance: {
      legacyAgentId: agentId,
      legacyLifecycle: lifecycle,
      legacyTitle: legacyTitleFor(titles, sessionDir, sessionPath),
    },
    migration: {
      legacySessionPath: sessionPath,
      source: "legacy_scan",
      migratedAt,
    },
    locatorReason: "legacy_scan",
  };
}

export function migrateLegacySessions(opts: any = {}) {
  const inputHome = resolveCodiaHome(opts);
  if (!inputHome) throw new Error("migrateLegacySessions requires codiaHome");
  if (!opts.store) throw new Error("migrateLegacySessions requires store");

  const codiaHome = path.resolve(inputHome);
  const agentsDir = path.resolve(opts.agentsDir || path.join(codiaHome, "agents"));
  const migratedAt = opts.migratedAt || new Date().toISOString();
  const result = { scanned: 0, created: 0, existing: 0, skipped: 0 };

  for (const agentId of listDirectories(agentsDir)) {
    const sessionDir = path.join(agentsDir, agentId, "sessions");
    if (!fs.existsSync(sessionDir)) continue;
    const meta = readJsonFile(path.join(sessionDir, "session-meta.json"), {});
    const titles = readJsonFile(path.join(sessionDir, "session-titles.json"), {});
    const sessionRows = [
      ...listJsonlFiles(sessionDir).map((sessionPath) => ({ sessionPath, lifecycle: "active" })),
      ...listJsonlFiles(path.join(sessionDir, "archived")).map((sessionPath) => ({ sessionPath, lifecycle: "archived" })),
    ];

    for (const row of sessionRows) {
      result.scanned += 1;
      const existing = opts.store.resolveByLocatorPath(row.sessionPath);
      if (existing) {
        result.existing += 1;
        continue;
      }

      try {
        opts.store.createForPath(buildLegacyManifestInput({
          agentId,
          sessionDir,
          sessionPath: row.sessionPath,
          lifecycle: row.lifecycle,
          meta,
          titles,
          migratedAt,
        }));
        result.created += 1;
      } catch (error) {
        if (opts.stopOnError === true) throw error;
        result.skipped += 1;
      }
    }
  }

  return result;
}
