import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { CloudActor } from './store.ts';
import type { ObjectStore } from './object-store.ts';
import { CLOUD_UPLOAD_LIMIT } from './service.ts';

export type LegacyKind = 'session' | 'session-metadata' | 'workflow-journal' | 'workflow-activity' | 'business' | 'project-catalog' | 'automation';
export type LegacySelection = {
  /** An explicitly selected legacy data root. Never defaults to the user's home. */
  sourceRoot: string;
  /** Stable identifier for this installation, independent of its mount path. */
  sourceId: string;
  /** Trusted operator assignment, not an arbitrary actor supplied by a web request. */
  owner: CloudActor;
  agentIds: string[];
  /** Shared legacy stores have no reliable tenant field: explicitly opt in only after ownership review. */
  includeSharedState?: boolean;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};
export type MigrationMapping = {
  sourceKey: string; fileId: string; currentVersionId: string | null;
  importedVersionId: string | null; sha256: string | null;
};
export type MigrationBatch = { id: string; planSha256: string; state: 'applied' | 'rolled_back' };
export type MigrationSnapshot = { items: MigrationMapping[]; batches: MigrationBatch[] };
export type MigrationItem = {
  sourceKey: string; kind: LegacyKind | 'manifest'; fileId: string; versionId: string;
  name: string; objectKey: string; size: number; sha256: string;
  expectedVersionId: string | null; expectedImportedVersionId: string | null;
};
export type MigrationCommit = {
  workspaceId: string; sourceId: string; batchId: string; planSha256: string; items: MigrationItem[];
};
export type MigrationResult = { batchId: string; state: 'applied'; imported: number; unchanged: number };
export type MigrationRollback = { batchId: string; rolledBack: number; preserved: number };
/** Implementations must commit every pointer, mapping and audit event atomically under owner/tenant scope. */
export interface LegacyMigrationRepository {
  migrationSnapshot(actor: CloudActor, workspaceId: string, sourceId: string): Promise<MigrationSnapshot>;
  commitMigration(actor: CloudActor, input: MigrationCommit): Promise<MigrationResult>;
  rollbackMigration(actor: CloudActor, workspaceId: string, batchId: string): Promise<MigrationRollback>;
}
export class LegacyMigrationError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = 'LegacyMigrationError'; }
}
export type MigrationSkip = { relativePath: string; reason: string };
export type LegacyAsset = { relativePath: string; sourceKey: string; kind: LegacyKind; sourceSha256: string; modifiedAt: string; payload: unknown };
export type LegacyScan = { sourceId: string; sourceRoot: string; owner: CloudActor; assets: LegacyAsset[]; skipped: MigrationSkip[] };
export type MigrationPlan = MigrationCommit & {
  actor: CloudActor; sourceRoot: string; sources: Array<{ relativePath: string; sha256: string }>; assets: Array<MigrationItem & { bytes: Buffer; action: 'import' | 'unchanged' | 'conflict' }>;
  skipped: MigrationSkip[];
};
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function migrationUuid(...parts: string[]): string {
  const h = digest(JSON.stringify(parts));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const hasControl = (value: string) => Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function validateMigrationScope(actor: CloudActor, workspaceId: string, sourceId?: string) {
  for (const value of [actor?.userId, actor?.studioId]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || hasControl(value)) throw new LegacyMigrationError('invalid_migration_actor');
  }
  if (!uuid.test(workspaceId)) throw new LegacyMigrationError('invalid_workspace_id');
  if (sourceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceId)) throw new LegacyMigrationError('invalid_source_id');
}
function assertRelative(value: string) {
  if (!value || path.isAbsolute(value) || value.includes('\\') || hasControl(value) || value.split('/').some(x => !x || x === '.' || x === '..') || value !== value.normalize('NFC')) throw new LegacyMigrationError('unsafe_source_path');
}
const secretName = /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.git|auth(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db)(?:-wal|-shm)?)$/i;
const secretKey = /^(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?access[_-]?key|private[_-]?key|authorization|cookie|credentials?|authToken|token)$/i;
function containsSecret(value: unknown, depth = 0): boolean {
  if (depth > 100) throw new LegacyMigrationError('source_too_deep');
  if (typeof value === 'string') return /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/=.-]{12,}|(?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*["']?[^\s"',;]{8,}/i.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (secretKey.test(key) && child !== null && child !== '' && child !== false) || containsSecret(child, depth + 1));
}
function classify(relativePath: string, agents: Set<string>, shared: boolean): LegacyKind | null {
  const p = relativePath.split('/');
  if (p[0] === 'agents' && agents.has(p[1])) {
    const tail = p.slice(2).join('/');
    if (/^sessions\/(?:archived\/)?[^/]+\.jsonl$/.test(tail) || /^workflow-sessions\/[^/]+\/[^/]+\.jsonl$/.test(tail)) return 'session';
    if (/^sessions\/(?:session-meta|session-titles|titles)\.json$/.test(tail)) return 'session-metadata';
    if (/^workflow-journals\/[^/]+\.jsonl$/.test(tail)) return 'workflow-journal';
    if (tail === 'desk/cron-jobs.json' || /^desk\/cron-runs\/[^/]+\.jsonl$/.test(tail)) return 'automation';
  }
  if (shared && relativePath === 'workflow-activity.json') return 'workflow-activity';
  if (shared && relativePath === 'aftersales/tasks.json') return 'business';
  if (shared && relativePath === 'user/session-projects.json') return 'project-catalog';
  return null;
}
/** lstat every component, O_NOFOLLOW on files, bounded reads, and no writes to the source. */
async function safePath(root: string, relativePath: string): Promise<string> {
  assertRelative(relativePath);
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new LegacyMigrationError('symlink_skipped');
  }
  const resolved = await realpath(current);
  if (resolved !== current || !resolved.startsWith(`${root}${path.sep}`)) throw new LegacyMigrationError('source_outside_root');
  return resolved;
}
/** Descriptor-relative traversal prevents ancestor replacement races on the cloud's Linux filesystem. */
async function openSource(root: string, relativePath: string, directory = false): Promise<FileHandle> {
  assertRelative(relativePath);
  if (process.platform !== 'linux') throw new LegacyMigrationError('secure_source_import_requires_linux');
  const parts = [...root.split(path.sep).filter(Boolean), ...relativePath.split('/')];
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (let i = 0; i < parts.length; i++) {
      const isDirectory = i < parts.length - 1 || directory;
      const next = await open(`/proc/self/fd/${handle.fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | (isDirectory ? constants.O_DIRECTORY : constants.O_NONBLOCK));
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function readBounded(root: string, relativePath: string, limit: number): Promise<Buffer> {
  const filename = await safePath(root, relativePath);
  const handle = await openSource(root, relativePath);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new LegacyMigrationError('non_regular_source');
    if (before.size > limit) throw new LegacyMigrationError('source_too_large');
    const bytes = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!chunk.bytesRead) break;
      offset += chunk.bytesRead;
    }
    const after = await handle.stat();
    await safePath(root, relativePath);
    const current = await lstat(filename);
    if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new LegacyMigrationError('source_changed_during_read');
    if (offset > limit) throw new LegacyMigrationError('source_too_large');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
/** Discover only known record directories for the explicitly selected agents. Never follow a record's file references. */
export async function scanLegacyData(selection: LegacySelection): Promise<LegacyScan> {
  if (!selection.sourceRoot || !path.isAbsolute(selection.sourceRoot)) throw new LegacyMigrationError('absolute_source_root_required');
  validateMigrationScope(selection.owner, '00000000-0000-5000-a000-000000000000', selection.sourceId);
  const agents = new Set(selection.agentIds);
  if ((!agents.size && !selection.includeSharedState) || [...agents].some(x => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x))) throw new LegacyMigrationError('explicit_source_selection_required');
  const root = path.resolve(selection.sourceRoot);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new LegacyMigrationError('symlink_source_root');
  if (!(await lstat(root)).isDirectory()) throw new LegacyMigrationError('source_root_not_directory');
  const maxFile = selection.maxFileBytes ?? 2 * 1024 * 1024;
  const maxTotal = selection.maxTotalBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFile) || maxFile < 1 || maxFile > 32 * 1024 * 1024 || !Number.isSafeInteger(maxTotal) || maxTotal < maxFile || maxTotal > 128 * 1024 * 1024) throw new LegacyMigrationError('invalid_scan_limits');
  const skipped: MigrationSkip[] = [], candidates: string[] = [];
  let visited = 0;
  const visit = async (relativePath: string, depth = 0): Promise<void> => {
    try {
      if (++visited > 10000) throw new LegacyMigrationError('source_entry_limit');
      if (relativePath.split('/').some(p => secretName.test(p))) { skipped.push({ relativePath, reason: 'secret_filename' }); return; }
      const filename = await safePath(root, relativePath), stat = await lstat(filename);
      if (stat.isDirectory()) {
        if (depth > 3) { skipped.push({ relativePath, reason: 'directory_depth_limit' }); return; }
        const handle = await openSource(root, relativePath, true);
        let names: string[];
        try { names = await readdir(`/proc/self/fd/${handle.fd}`); } finally { await handle.close(); }
        for (const entry of names.sort()) await visit(`${relativePath}/${entry}`, depth + 1);
      } else if (classify(relativePath, agents, !!selection.includeSharedState)) candidates.push(relativePath);
      else skipped.push({ relativePath, reason: 'not_allowlisted' });
      if (candidates.length + skipped.length > 10000) throw new LegacyMigrationError('source_entry_limit');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof LegacyMigrationError && error.code !== 'source_entry_limit') skipped.push({ relativePath, reason: error.code });
      else throw error;
    }
  };
  for (const agent of [...agents].sort()) for (const dir of ['sessions', 'workflow-journals', 'workflow-sessions', 'desk/cron-runs', 'desk/cron-jobs.json']) await visit(`agents/${agent}/${dir}`);
  if (selection.includeSharedState) for (const filename of ['workflow-activity.json', 'aftersales/tasks.json', 'user/session-projects.json']) await visit(filename);
  const assets: LegacyAsset[] = [];
  let total = 0;
  for (const relativePath of [...new Set(candidates)].sort()) {
    try {
      const bytes = await readBounded(root, relativePath, maxFile);
      total += bytes.length;
      if (total > maxTotal) throw new LegacyMigrationError('source_total_limit');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const payload = relativePath.endsWith('.jsonl') ? text.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(text);
      if (!payload || typeof payload !== 'object') throw new LegacyMigrationError('invalid_record_shape');
      if (containsSecret(payload)) { skipped.push({ relativePath, reason: 'possible_credentials' }); continue; }
      const kind = classify(relativePath, agents, !!selection.includeSharedState)!;
      const modifiedAt = (await lstat(await safePath(root, relativePath))).mtime.toISOString();
      assets.push({ relativePath, modifiedAt, sourceKey: `${kind}:${relativePath}`, kind, sourceSha256: digest(bytes), payload });
    } catch (error) {
      if (error instanceof LegacyMigrationError && error.code === 'source_total_limit') throw error;
      skipped.push({ relativePath, reason: error instanceof LegacyMigrationError ? error.code : 'invalid_or_unreadable_record' });
    }
  }
  return { sourceId: selection.sourceId, sourceRoot: root, owner: { ...selection.owner }, assets, skipped };
}
/** All cloud identity is scoped and independent of a path on the source machine. */
export function planLegacyMigration(actorInput: CloudActor, workspaceId: string, scan: LegacyScan, snapshot: MigrationSnapshot, batchId?: string): MigrationPlan {
  const actor = { ...actorInput };
  validateMigrationScope(actor, workspaceId, scan.sourceId);
  if (scan.owner.userId !== actor.userId || scan.owner.studioId !== actor.studioId) throw new LegacyMigrationError('source_owner_mismatch');
  if (!scan.assets.length) throw new LegacyMigrationError('no_migratable_records');
  const scope = [actor.studioId, actor.userId, workspaceId, scan.sourceId];
  const old = new Map(snapshot.items.map(item => [item.sourceKey, item]));
  const ids = scan.assets.map(asset => ({ sourceKey: asset.sourceKey, relativePath: asset.relativePath, kind: asset.kind, fileId: migrationUuid('legacy-file-v1', ...scope, asset.sourceKey) }));
  const manifests = ids.map(item => ({ ...item, resourceId: `cloud-file:${item.fileId}` }));
  const recordKind = (kind: LegacyKind) => kind === 'session' ? 'conversation' : ['workflow-journal', 'workflow-activity', 'automation'].includes(kind) ? 'workflow' : 'business';
  const records = scan.assets.map((asset, index) => ({ sourceKey: asset.sourceKey, kind: asset.kind as LegacyKind | 'manifest', fileId: ids[index].fileId, name: `record-${recordKind(asset.kind)}-${ids[index].fileId}.json`, bytes: Buffer.from(JSON.stringify({ schemaVersion: 1, id: ids[index].fileId, kind: recordKind(asset.kind), title: asset.relativePath, data: { legacy: { sourceId: scan.sourceId, sourceKey: asset.sourceKey, relativePath: asset.relativePath, originalSha256: asset.sourceSha256, execution: 'inert-snapshot' }, content: asset.payload }, createdAt: asset.modifiedAt, updatedAt: asset.modifiedAt }) + '\n') }));
  const manifestKey = 'manifest:legacy-index';
  records.push({ sourceKey: manifestKey, kind: 'manifest', name: `legacy-manifest-${migrationUuid('legacy-file-v1', ...scope, manifestKey)}.json`, fileId: migrationUuid('legacy-file-v1', ...scope, manifestKey), bytes: Buffer.from(JSON.stringify({ schema: 'codia.legacy-manifest/v1', sourceId: scan.sourceId, execution: 'inert-snapshots-only', entries: manifests, skipped: scan.skipped }) + '\n') });
  if (records.some(record => record.bytes.length > CLOUD_UPLOAD_LIMIT)) throw new LegacyMigrationError('migration_record_too_large');
  const planSha256 = digest(JSON.stringify({ schema: 1, scope, records: records.map(x => [x.sourceKey, digest(x.bytes)]) }));
  const resolvedBatchId = batchId ?? migrationUuid('legacy-batch-v1', ...scope, planSha256);
  if (!uuid.test(resolvedBatchId)) throw new LegacyMigrationError('invalid_batch_id');
  const existing = snapshot.batches.find(batch => batch.id === resolvedBatchId);
  if (existing && existing.planSha256 !== planSha256) throw new LegacyMigrationError('migration_idempotency_conflict');
  if (existing?.state === 'rolled_back') throw new LegacyMigrationError('migration_already_rolled_back_use_new_batch_id');
  const assets = records.map(record => {
    const previous = old.get(record.sourceKey);
    if (previous && previous.fileId !== record.fileId) throw new LegacyMigrationError('migration_mapping_conflict');
    const sha256 = digest(record.bytes);
    const versionId = migrationUuid('legacy-version-v1', ...scope, resolvedBatchId, record.sourceKey, sha256);
    const action = previous?.sha256 === sha256 && previous.importedVersionId ? 'unchanged' : previous && previous.currentVersionId !== previous.importedVersionId ? 'conflict' : 'import';
    return { ...record, versionId, name: record.name, objectKey: `workspaces/${workspaceId}/files/${record.fileId}/versions/${versionId}`, size: record.bytes.length, sha256, expectedVersionId: previous?.currentVersionId ?? null, expectedImportedVersionId: previous?.importedVersionId ?? null, action } as MigrationPlan['assets'][number];
  });
  return { actor, sourceRoot: scan.sourceRoot, sources: scan.assets.map(asset => ({ relativePath: asset.relativePath, sha256: asset.sourceSha256 })), workspaceId, sourceId: scan.sourceId, batchId: resolvedBatchId, planSha256, assets, items: assets.map(({ bytes: _bytes, action: _action, ...item }) => item), skipped: scan.skipped };
}
export function migrationPlanSummary(plan: MigrationPlan) {
  return { batchId: plan.batchId, workspaceId: plan.workspaceId, sourceId: plan.sourceId, planSha256: plan.planSha256, records: plan.assets.map(({ bytes: _bytes, objectKey: _key, ...item }) => item), skipped: plan.skipped, totalBytes: plan.assets.reduce((sum, item) => sum + item.size, 0), execution: 'inert-snapshots-only' };
}
export async function applyLegacyMigration(repository: LegacyMigrationRepository, objects: ObjectStore, input: MigrationPlan): Promise<MigrationResult> {
  // Own the buffers and identity across awaits. Plans are trusted operator objects, never HTTP request bodies.
  const plan: MigrationPlan = { ...input, actor: { ...input.actor }, sources: input.sources.map(source => ({ ...source })), items: input.items.map(item => ({ ...item })), assets: input.assets.map(item => ({ ...item, bytes: Buffer.from(item.bytes) })) };
  validateMigrationScope(plan.actor, plan.workspaceId, plan.sourceId);
  const scope = [plan.actor.studioId, plan.actor.userId, plan.workspaceId, plan.sourceId];
  const computed = digest(JSON.stringify({ schema: 1, scope, records: plan.assets.map(item => [item.sourceKey, digest(item.bytes)]) }));
  const items = plan.assets.map(({ bytes: _bytes, action: _action, ...item }) => item);
  if (computed !== plan.planSha256 || JSON.stringify(items) !== JSON.stringify(plan.items)) throw new LegacyMigrationError('migration_plan_integrity_error');
  // Refresh authorization and idempotency before transmitting any bytes to object storage.
  const current = await repository.migrationSnapshot(plan.actor, plan.workspaceId, plan.sourceId);
  const batch = current.batches.find(item => item.id === plan.batchId);
  if (batch) {
    if (batch.planSha256 !== plan.planSha256) throw new LegacyMigrationError('migration_idempotency_conflict');
    if (batch.state !== 'applied') throw new LegacyMigrationError('migration_already_rolled_back_use_new_batch_id');
    return { batchId: plan.batchId, state: 'applied', imported: 0, unchanged: plan.assets.length };
  }
  for (const source of plan.sources) {
    const bytes = await readBounded(plan.sourceRoot, source.relativePath, 32 * 1024 * 1024);
    if (digest(bytes) !== source.sha256) throw new LegacyMigrationError('source_changed_after_plan');
  }
  if (plan.assets.some(item => item.action === 'conflict')) throw new LegacyMigrationError('migration_preserves_later_writes');
  for (const item of plan.assets.filter(item => item.action === 'import')) {
    if (item.size !== item.bytes.length || item.sha256 !== digest(item.bytes)) throw new LegacyMigrationError('migration_plan_integrity_error');
    try {
      const result = await objects.putImmutable(item.objectKey, item.bytes);
      if (result.sha256 !== item.sha256 || result.size !== item.size) throw new LegacyMigrationError('migration_object_integrity_error');
    } catch (error) {
      if ((error as { code?: string }).code !== 'OBJECT_EXISTS') throw error;
    }
    const stored = await objects.get(item.objectKey);
    if (stored.length !== item.size || digest(stored) !== item.sha256) throw new LegacyMigrationError('migration_object_integrity_error');
  }
  return repository.commitMigration(plan.actor, { workspaceId: plan.workspaceId, sourceId: plan.sourceId, batchId: plan.batchId, planSha256: plan.planSha256, items: plan.items });
}
