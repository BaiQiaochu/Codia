import { createSessionManifestCheckpoint } from "./checkpoint.ts";
import { migrateLegacySessions } from "./legacy-migration.ts";

export const LEGACY_SESSION_MANIFEST_MIGRATION_KEY = "legacy-session-manifest-scan-v1";

function sanitizeTimestamp(value) {
  return String(value).replace(/:/g, "-").replace(/\./g, "-");
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
  };
}

function resolveGsapHome(opts: any = {}) {
  return opts.gsapHome || opts.hanaHome || null;
}

export function ensureLegacySessionManifestMigration(opts: any = {}) {
  const gsapHome = resolveGsapHome(opts);
  if (!gsapHome) throw new Error("ensureLegacySessionManifestMigration requires gsapHome");
  if (!opts.store) throw new Error("ensureLegacySessionManifestMigration requires store");

  const key = opts.stateKey || LEGACY_SESSION_MANIFEST_MIGRATION_KEY;
  const existing = typeof opts.store.getState === "function" ? opts.store.getState(key) : null;
  if (existing?.completedAt) {
    try {
      const scannedAt = opts.scannedAt || new Date().toISOString();
      const migrate = opts.migrate || migrateLegacySessions;
      const result = migrate({
        gsapHome,
        store: opts.store,
        migratedAt: scannedAt,
        stopOnError: opts.stopOnError,
      });
      const state = {
        ...existing,
        lastScannedAt: scannedAt,
        lastResult: result,
      };
      opts.store.setState(key, state);
      return { status: "rescanned", result, state };
    } catch (error) {
      const state = {
        ...existing,
        lastFailedAt: opts.failedAt || new Date().toISOString(),
        error: serializeError(error),
      };
      try {
        opts.store.setState(key, state);
      } catch (stateError) {
        if (opts.throwOnFailure) throw stateError;
      }
      if (opts.throwOnFailure) throw error;
      return { status: "failed", error, state };
    }
  }

  const startedAt = opts.startedAt || new Date().toISOString();
  const checkpointId = opts.checkpointId || `legacy-session-manifest-${sanitizeTimestamp(startedAt)}`;
  const createCheckpoint = opts.createCheckpoint || createSessionManifestCheckpoint;
  const migrate = opts.migrate || migrateLegacySessions;
  let checkpoint = null;

  try {
    checkpoint = createCheckpoint({
      gsapHome,
      appVersion: opts.appVersion,
      gitAnchors: opts.gitAnchors,
      createdAt: startedAt,
      id: checkpointId,
      ...(opts.checkpointRoot ? { checkpointRoot: opts.checkpointRoot } : {}),
      ...(opts.includes ? { includes: opts.includes } : {}),
    });

    const result = migrate({
      gsapHome,
      store: opts.store,
      migratedAt: startedAt,
      stopOnError: opts.stopOnError,
    });
    const state = {
      startedAt,
      completedAt: opts.completedAt || startedAt,
      checkpointDirectory: checkpoint.directory,
      checkpointId: checkpoint.id,
      result,
    };
    opts.store.setState(key, state);
    return { status: "completed", checkpoint, result, state };
  } catch (error) {
    const state = {
      startedAt,
      failedAt: opts.failedAt || startedAt,
      checkpointDirectory: checkpoint?.directory || null,
      checkpointId: checkpoint?.id || checkpointId,
      error: serializeError(error),
    };
    try {
      opts.store.setState(key, state);
    } catch (stateError) {
      if (opts.throwOnFailure) throw stateError;
    }
    if (opts.throwOnFailure) throw error;
    return { status: "failed", error, state };
  }
}
