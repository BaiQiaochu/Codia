import path from 'node:path';
import { ArtifactSnapshotStore, readSnapshotSource } from '../../lib/session-files/artifact-snapshots.ts';
import { createHash } from 'node:crypto';
import { resourceIdForSessionFileId, fileIdFromSessionFileResourceId } from '../../lib/resources/resource-envelope.ts';
import { isValidSessionPath, isDesktopSessionPath } from '../../core/message-utils.ts';
import type { CompanyDelivery, DeliveryArtifact } from '../../shared/task-console/delivery.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const str = (v: unknown) => typeof v === 'string' ? v : '';
const array = (v: unknown): any[] => Array.isArray(v) ? v : [];
export const DELIVERY_VERSION_MAX_BYTES = 64 * 1024 * 1024;
function sessionFor(engine: any, sessionPath: unknown, context: any): string | null {
  if (typeof sessionPath !== 'string' || !engine.agentsDir || !isValidSessionPath(sessionPath, engine.agentsDir) || !isDesktopSessionPath(sessionPath, engine.agentsDir)) return null;
  return context.authorize('sessions.read', { kind: 'session', sessionPath, sessionId: engine.getSessionIdForPath?.(sessionPath) || undefined }).allowed ? sessionPath : null;
}
function contentVersion(content: any, registeredRealPath: unknown) {
  // Reuse snapshot's canonical-path + opened-FD binding before reading bytes.
  // Never re-resolve a changed ancestor into a new authorized path, nor substitute
  // portable pathname checks for descriptor identity on unsupported platforms.
  if (typeof registeredRealPath !== 'string' || !registeredRealPath) throw new Error('registered_canonical_path_unavailable');
  const { bytes } = readSnapshotSource(content.filePath, registeredRealPath, DELIVERY_VERSION_MAX_BYTES);
  return createHash('sha256').update(bytes).digest('hex');
}
export function buildCompanyDelivery(engine: any, task: any, context: any): CompanyDelivery {
  const access = engine.getResourceAccessService?.() || engine.resourceAccess;
  const artifacts: DeliveryArtifact[] = array(task.artifacts).map((input, index) => {
    const ref = typeof input === 'string' ? { path: input } : input || {};
    const reference = str(ref.fileId || ref.resourceId || ref.path || ref.uri || ref.url || ref.id);
    const key = `artifact-${index}`;
    let fileId = str(ref.fileId) || fileIdFromSessionFileResourceId(ref.resourceId) || fileIdFromSessionFileResourceId(ref.path) || (/^sf_[A-Za-z0-9_-]+$/.test(str(ref.id || ref.path)) ? ref.id || ref.path : '');
    const declaredSession = sessionFor(engine, ref.sessionPath || task.sessionPath, context);
    if (!fileId && declaredSession && typeof ref.path === 'string') {
      const cwd = engine.getSessionCwd?.(declaredSession);
      const expectedPath = path.isAbsolute(ref.path) ? ref.path : typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd, ref.path) : null;
      const match = (engine.listSessionFiles?.(declaredSession) || []).find((file: any) => file.listed !== false && expectedPath && file.filePath === expectedPath);
      fileId = match?.id || (/^sf_[A-Za-z0-9_-]+$/.test(ref.path) ? ref.path : '');
    }
    if (!fileId || !resourceIdForSessionFileId(fileId)) return { key, reference, state: 'unregistered', reason: '尚未关联已登记资源；不会直接打开路径或外部网址。' };
    try {
      if (!access) throw Object.assign(new Error('resource_service_unavailable'), { status: 503 });
      const resource = access.getMetadata(resourceIdForSessionFileId(fileId), context);
      if (!resource) return { key, reference, state: 'missing', reason: '资源不存在或已移除。' };
      if (resource.lifecycle?.status !== 'available' || resource.isDirectory) return { key, reference, state: 'missing', reason: `资源不可交付（${resource.lifecycle?.status || 'directory'}）。` };
      // Content authorization can be narrower than metadata authorization.
      const content = access.resolveContent(resource.resourceId, context);
      const file = engine.getSessionFile?.(fileId, declaredSession ? { sessionPath: declaredSession } : undefined);
      const sessionPath = sessionFor(engine, file?.sessionPath || declaredSession, context);
      let sha256: string;
      if (resource.origin === 'artifact_snapshot') {
        if (!file?.sessionPath) throw new Error('snapshot_session_unavailable');
        const snapshots = new ArtifactSnapshotStore(engine.codiaHome);
        const snapshot = snapshots.list(file.sessionPath).find(item => item.snapshotFileId === fileId);
        if (!snapshot) throw new Error('snapshot_not_found');
        sha256 = createHash('sha256').update(snapshots.read(file.sessionPath, snapshot)).digest('hex');
      } else { sha256 = contentVersion(content, file?.realPath); }
      return { key, reference, fileId, state: 'available', name: resource.displayName || resource.filename || fileId, ext: resource.ext,
        resource, sessionPath, sha256, size: content.size ?? resource.size };
    } catch (error: any) {
      if (error?.code === 'snapshot_platform_unsupported' || error?.code === 'snapshot_fd_verification_unavailable') return { key, reference, state: 'unversioned', reason: '当前平台缺少安全文件句柄校验，无法核对内容版本或记录通过；原会话登记产物仍可按现有权限查看。' };
      if (error?.code === 'snapshot_path_changed') return { key, reference, state: 'unversioned', reason: '登记路径或已打开文件身份发生变化，已停止内容读取；请核对并重新登记资源。' };
      if (error?.status === 403) return { key, reference, state: 'forbidden', reason: '当前身份无权读取该资源。' };
      if (error?.status === 404 || error?.code === 'ENOENT') return { key, reference, state: 'missing', reason: '资源不存在或已移除。' };
      return { key, reference, state: 'unversioned', reason: '无法安全核对当前内容版本（最多 64 MiB；文件可能正在变化）。请检查后刷新。' };
    }
  });
  const criteria = array(task.acceptanceCriteria).filter(v => typeof v === 'string').map(criterion => {
    const result = array(task.acceptanceResults).find(r => r?.criterion === criterion);
    return { criterion, selfReport: result ? { passed: typeof result.passed === 'boolean' ? result.passed : null, evidence: str(result.evidence) } : null };
  });
  const version = digest({ report: task.report || '', criteria, artifacts: array(task.artifacts),
    observed: artifacts.map(a => ({ reference: a.reference, state: a.state, sha256: a.sha256 || null })), revision: task.deliveryRevision || 0 });
  const review = task.humanReview;
  return { taskId: task.id, version, revision: task.deliveryRevision || 0, report: task.report || '', status: task.status, dueAt: task.dueAt || null,
    criteria, artifacts, review: review ? { state: review.version === version ? 'current' : 'stale', reviewedAt: review.reviewedAt, items: review.items, version: review.version } : { state: 'unreviewed' },
    note: '执行方自报只是结构化报告；人工复核单独记录并绑定本报告、验收标准和可读取产物的 SHA-256。文件或报告变化后旧复核失效。预览、导出与会话导航不会对外分享或派发任务。' };
}
