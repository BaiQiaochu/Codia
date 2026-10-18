import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { isDesktopSessionPath, isValidSessionPath } from '../../core/message-utils.ts';
import { serializeSessionFile } from '../../lib/session-files/session-file-response.ts';
import { resourceIdForSessionFileId } from '../../lib/resources/resource-envelope.ts';
import { ArtifactSnapshotError, ArtifactSnapshotStore, ARTIFACT_SNAPSHOT_LIMITS, compareArtifactSnapshots, getArtifactSnapshotCapabilities, type ArtifactSnapshot } from '../../lib/session-files/artifact-snapshots.ts';
import { createRequestContext } from '../http/boundary.ts';

/** Owner-only HTTP projection, with existing session/resource capability checks as defense
 * in depth. Inputs are registered IDs; no endpoint accepts an arbitrary content path. */
export function createTaskArtifactsRoute(engine: any) {
  const route = new Hono();
  const store = () => new ArtifactSnapshotStore(engine.codiaHome);
  const access = () => {
    const service = engine.getResourceAccessService?.() || engine.resourceAccess;
    if (!service) throw new ArtifactSnapshotError('resource_service_unavailable', 503);
    return service;
  };
  const session = (c: any, write = false) => {
    const sessionPath = c.req.query('sessionPath');
    if (!sessionPath || !isValidSessionPath(sessionPath, engine.agentsDir) || !isDesktopSessionPath(sessionPath, engine.agentsDir)) {
      throw new ArtifactSnapshotError('invalid_session_path', 403);
    }
    // Lexical containment alone permits symlink escapes into another session/sidecar.
    try {
      const root = fs.realpathSync(engine.agentsDir);
      const actual = fs.realpathSync(sessionPath);
      const relative = path.relative(root, actual);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || actual !== path.resolve(sessionPath) || !fs.lstatSync(actual).isFile()) throw new Error();
    } catch { throw new ArtifactSnapshotError('invalid_session_path', 403); }
    const context = createRequestContext(c, engine);
    const decision = context.authorize(write ? 'sessions.write' : 'sessions.read', {
      kind: 'session', sessionPath, sessionId: engine.getSessionIdForPath?.(sessionPath) || undefined,
    });
    if (!decision.allowed) throw new ArtifactSnapshotError('session_forbidden', 403);
    return { sessionPath, context };
  };
  const sourceFile = (sessionPath: string, fileId: string) => {
    const file = (engine.listSessionFiles(sessionPath) || []).find((file: any) => file.id === fileId && file.listed !== false);
    if (!file || file.sessionPath !== sessionPath || file.origin === 'artifact_snapshot') throw new ArtifactSnapshotError('artifact_not_found', 404);
    return file;
  };
  const metadata = (file: any, context: any) => {
    const resource = access().getMetadata(resourceIdForSessionFileId(file.id), context);
    if (!resource) throw new ArtifactSnapshotError('artifact_not_found', 404);
    const serialized = engine.serializeSessionFile ? engine.serializeSessionFile(file) : serializeSessionFile(file, { runtimeContext: engine.getRuntimeContext?.() || engine.runtimeContext });
    return { ...access().sanitizeSessionFile(serialized, context), resource, size: resource.size ?? file.size, status: resource.lifecycle?.status || file.status };
  };
  const snapshotFile = (sessionPath: string, snapshot: ArtifactSnapshot) => {
    const file = engine.getSessionFile?.(snapshot.snapshotFileId, { sessionPath });
    if (!file || file.sessionPath !== sessionPath || file.origin !== 'artifact_snapshot') throw new ArtifactSnapshotError('snapshot_not_found', 404);
    return file;
  };
  const publicSnapshot = (sessionPath: string, snapshot: ArtifactSnapshot, context: any) => ({
    ...snapshot, file: metadata(snapshotFile(sessionPath, snapshot), context),
  });
  const handleError = (c: any, error: any) => c.json({ error: error instanceof ArtifactSnapshotError ? error.code : 'artifact_access_failed' },
    Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500);

  route.get('/task-artifacts', c => {
    try {
      const { sessionPath, context } = session(c);
      const snapshots = store().list(sessionPath);
      const files = (engine.listSessionFiles(sessionPath) || []).filter((file: any) => file.listed !== false && file.origin !== 'artifact_snapshot').map((file: any) => ({
        ...metadata(sourceFile(sessionPath, file.id), context),
        snapshots: snapshots.filter(snapshot => snapshot.sourceFileId === file.id).map(snapshot => publicSnapshot(sessionPath, snapshot, context)),
      }));
      return c.json({ files, capabilities: getArtifactSnapshotCapabilities(), limits: ARTIFACT_SNAPSHOT_LIMITS, note: '仅在手动保存时创建内容快照。达到上限后拒绝新增；不自动删除历史版本或原文件。' });
    } catch (error) { return handleError(c, error); }
  });

  route.post('/task-artifacts/:fileId/snapshots', c => {
    try {
      const { sessionPath, context } = session(c, true);
      const capabilities = getArtifactSnapshotCapabilities();
      if (!capabilities.snapshotAvailable) throw new ArtifactSnapshotError(capabilities.reason!, 503);
      const file = sourceFile(sessionPath, c.req.param('fileId'));
      if (file.status === 'expired' || file.isDirectory) throw new ArtifactSnapshotError('artifact_unavailable');
      const content = access().resolveContent(resourceIdForSessionFileId(file.id), context);
      if (typeof engine.registerSessionFile !== 'function') throw new ArtifactSnapshotError('snapshot_store_unavailable', 503);
      const result = store().capture({
        sessionPath, source: file, contentPath: content.filePath,
        register: (filePath, displayName) => engine.registerSessionFile({
          sessionPath, filePath, label: displayName, origin: 'artifact_snapshot', storageKind: 'artifact_snapshot', listed: false,
        }),
      });
      return c.json({ ...result, snapshot: publicSnapshot(sessionPath, result.snapshot, context) }, result.created ? 201 : 200);
    } catch (error) { return handleError(c, error); }
  });

  route.get('/task-artifacts/:fileId/compare', c => {
    try {
      const { sessionPath, context } = session(c);
      const capabilities = getArtifactSnapshotCapabilities();
      if (!capabilities.snapshotAvailable) throw new ArtifactSnapshotError(capabilities.reason!, 503);
      const file = sourceFile(sessionPath, c.req.param('fileId'));
      metadata(file, context);
      const snapshots = store().list(sessionPath).filter(snapshot => snapshot.sourceFileId === file.id);
      const before = snapshots.find(snapshot => snapshot.id === c.req.query('before'));
      const after = snapshots.find(snapshot => snapshot.id === c.req.query('after'));
      if (!before || !after) throw new ArtifactSnapshotError('snapshot_not_found', 404);
      for (const snapshot of [before, after]) {
        const registered = snapshotFile(sessionPath, snapshot);
        access().resolveContent(resourceIdForSessionFileId(registered.id), context);
      }
      const comparison = compareArtifactSnapshots(store().read(sessionPath, before), store().read(sessionPath, after));
      return c.json({ before: publicSnapshot(sessionPath, before, context), after: publicSnapshot(sessionPath, after, context), ...comparison });
    } catch (error) { return handleError(c, error); }
  });
  return route;
}
