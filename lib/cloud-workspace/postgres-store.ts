import { randomUUID } from 'node:crypto';
import { normalizeUpload, sameUpload, uploadRequestKey, uploadManifest, publicUpload, activeUpload, assertUploadActive, validateUploadChunk, CLOUD_UPLOAD_TTL, CLOUD_UPLOAD_ACTIVE_LIMIT, CLOUD_UPLOAD_ACTIVE_BYTES, CLOUD_UPLOAD_RETAINED_LIMIT, CLOUD_UPLOAD_RETAINED_BYTES, type CreateCloudUpload, type CloudUploadChunk, type CloudUploadState } from './uploads.ts';
import { CLOUD_DOCUMENT_INPUT_LIMIT, CLOUD_AGENT_INPUT_LIMIT } from './input-limits.ts';
import { CloudWorkspaceError, validName, type CloudActor, type CloudRow } from './store.ts';
import { PostgresWorkspaceDatabase, type PgPool, type PgQueryable } from './postgres.ts';
import type { CloudOperation, CloudOutput, CloudWorkspaceRepository, StagedCloudVersion, EnqueueCloudRun, CreateCloudSchedule } from './repository.ts';
import { validateObjectKey } from './object-store.ts';
import { normalizeSchedule, sameScheduleSpecification, nextScheduleOccurrence, scheduleTimestamp, scheduleLimit, scheduleRevision, scheduleDispatchRejection } from './schedules.ts';

const schema = 'codia_workspace';
const id = () => randomUUID();
const stripScope = (row: CloudRow): CloudRow => {
  const { owner_user: _owner, studio_id: _studio, ...result } = row;
  for (const [key, value] of Object.entries(result)) {
    if (value instanceof Date) result[key] = value.toISOString();
    if (['size', 'version_count', 'lease_until', 'next_run_at', 'interval_ms', 'revision'].includes(key) && value !== null) result[key] = Number(value);
  }
  return result;
};
const publicRun = (row: CloudRow) => { const { lease_until: _lease, request_key: _key, ...result } = stripScope(row); return result; };
const publicSchedule = (row: CloudRow) => { const { creation_spec: _spec, ...result } = stripScope(row); return result; };
const publicVersion = (row: CloudRow) => ({ id: row.id, size: Number(row.size), sha256: row.sha256, created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at });
const publicEvent = (row: CloudRow) => ({ id: Number(row.id), kind: row.kind, payload: row.payload, created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at });
function actorContext(actor: CloudActor) {
  if (![actor?.userId, actor?.studioId].every(value => typeof value === 'string' && value.trim() && value.length <= 128 && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) {
    throw new CloudWorkspaceError('authenticated_identity_required', 401);
  }
  return { tenantId: actor.studioId, actorId: actor.userId };
}
function uuid(value: string) { if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new CloudWorkspaceError('not_found', 404); return value; }
function metadata(size: number, sha256: string) { if (!Number.isSafeInteger(size) || size < 0 || size > 2147483647 || !/^[a-f0-9]{64}$/.test(sha256)) throw new CloudWorkspaceError('invalid_version_metadata'); }
function duration(value: number) { if (!Number.isInteger(value) || value < 1 || value > 300_000) throw new CloudWorkspaceError('invalid_lease'); return value; }

/** Complete async authority. Each operation owns one connection and transaction.
 * Database credentials are trusted-server only, never browser/RLS client tokens.
 * Worker context is internal capability, not protection from arbitrary SQL access.
 */
export class PostgresWorkspaceStore implements CloudWorkspaceRepository {
  readonly kind = 'postgres';
  readonly database: PostgresWorkspaceDatabase;
  readonly #close?: () => Promise<void>;
  constructor(pool: PgPool, options: {closePool?: () => Promise<void>} = {}) { this.database = new PostgresWorkspaceDatabase(pool); this.#close = options.closePool; }
  async #uploadsReady(tx: PgQueryable) {
    try {
      const result = await tx.query(`SELECT version FROM ${schema}.schema_version WHERE version=5 AND to_regclass('${schema}.uploads') IS NOT NULL AND to_regclass('${schema}.upload_chunks') IS NOT NULL`);
      if (result.rows.length !== 1) throw new CloudWorkspaceError('cloud_database_migration_required', 503);
    } catch (error) {
      if (['42P01','3F000'].includes(String((error as {code?:string}).code))) throw new CloudWorkspaceError('cloud_database_migration_required',503);
      throw error;
    }
  }
  async #uploadState(tx: PgQueryable, actor: CloudActor, uploadId: string, lock = false): Promise<CloudUploadState> {
    await this.#uploadsReady(tx);
    const session = (await tx.query(`SELECT * FROM ${schema}.uploads WHERE id=$1 AND owner_user=$2 AND studio_id=$3${lock ? ' FOR UPDATE' : ''}`, [uuid(uploadId),actor.userId,actor.studioId])).rows[0];
    if (!session) throw new CloudWorkspaceError('not_found',404);
    const chunks = (await tx.query(`SELECT chunk_index AS index,size,sha256 FROM ${schema}.upload_chunks WHERE upload_id=$1 ORDER BY chunk_index`,[uploadId])).rows.map(row => ({index:Number(row.index),size:Number(row.size),sha256:String(row.sha256)}));
    const version = (await tx.query(`SELECT * FROM ${schema}.versions WHERE id=$1`,[session.version_id])).rows[0];
    return {session:stripScope(session),chunks,version:stripScope(version)};
  }
  async #expireUploads(tx: PgQueryable, actor: CloudActor) {
    const expired = (await tx.query(`SELECT id,version_id FROM ${schema}.uploads WHERE owner_user=$1 AND studio_id=$2 AND state IN ('uploading','completing') AND expires_at<=floor(extract(epoch from clock_timestamp())*1000)::bigint ORDER BY id FOR UPDATE SKIP LOCKED`,[actor.userId,actor.studioId])).rows;
    for (const row of expired) {
      await tx.query(`UPDATE ${schema}.uploads SET state='expired',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,[row.id]);
      await this.#reject(tx,String(row.version_id));
    }
  }
  async createUpload(actor: CloudActor, workspaceId: string, input: CreateCloudUpload) {
    const spec = normalizeUpload(input);
    try {
      return await this.#tx(actor, async tx => {
        await this.#uploadsReady(tx);
        const workspace = await this.#workspace(tx,actor,workspaceId);
        // Owner-wide reservation fence applies across different workspaces.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['codia-upload-quota',actor.studioId,actor.userId])]);
        await this.#expireUploads(tx,actor);
        const old = (await tx.query(`SELECT * FROM ${schema}.uploads WHERE workspace_id=$1 AND request_key=$2`,[workspaceId,input.requestKey])).rows[0];
        if (old) { if (!sameUpload(old.creation_spec,spec)) throw new CloudWorkspaceError('idempotency_conflict',409); return this.#uploadState(tx,actor,String(old.id)); }
        const quota = (await tx.query(`SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM ${schema}.uploads WHERE owner_user=$1 AND studio_id=$2 AND state IN ('uploading','completing')`,[actor.userId,actor.studioId])).rows[0];
        if (Number(quota.count)>=CLOUD_UPLOAD_ACTIVE_LIMIT || Number(quota.bytes)+spec.size>CLOUD_UPLOAD_ACTIVE_BYTES) throw new CloudWorkspaceError('upload_quota_exceeded',429);
        const retained=(await tx.query(`SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM ${schema}.uploads WHERE owner_user=$1 AND studio_id=$2 AND expires_at>floor(extract(epoch from clock_timestamp())*1000)::bigint`,[actor.userId,actor.studioId])).rows[0];
        if (Number(retained.count)>=CLOUD_UPLOAD_RETAINED_LIMIT || Number(retained.bytes)+spec.size>CLOUD_UPLOAD_RETAINED_BYTES) throw new CloudWorkspaceError('upload_retention_quota_exceeded',429);
        let file: CloudRow;
        if (spec.fileId) {
          file = await this.#file(tx,actor,spec.fileId,true);
          if (file.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found',404);
          if (file.current_version !== spec.expectedVersion) throw new CloudWorkspaceError('version_conflict',409);
          if (file.name !== spec.name) throw new CloudWorkspaceError('upload_name_mismatch');
        } else file = (await tx.query(`INSERT INTO ${schema}.files(id,workspace_id,owner_user,studio_id,name) VALUES($1,$2,$3,$4,$5) RETURNING *`,[id(),workspaceId,workspace.owner_user,workspace.studio_id,spec.name])).rows[0];
        const versionId=id(),uploadId=id(),objectKey=`workspaces/${workspaceId}/files/${file.id}/versions/${versionId}`;
        await tx.query(`INSERT INTO ${schema}.versions(id,file_id,workspace_id,owner_user,studio_id,object_key,size,sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'staging')`,[versionId,file.id,workspaceId,actor.userId,actor.studioId,objectKey,spec.size,spec.sha256]);
        await tx.query(`INSERT INTO ${schema}.uploads(id,workspace_id,owner_user,studio_id,name,size,sha256,request_key,creation_spec,file_id,expected_version,version_id,state,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,'uploading',floor(extract(epoch from clock_timestamp())*1000)::bigint+$13)`,
        [uploadId,workspaceId,actor.userId,actor.studioId,spec.name,spec.size,spec.sha256,input.requestKey,JSON.stringify(spec),file.id,file.current_version,versionId,CLOUD_UPLOAD_TTL]);
        return this.#uploadState(tx,actor,uploadId);
      });
    } catch (error) { if ((error as {code?:string}).code==='23505') throw new CloudWorkspaceError('file_name_exists',409); throw error; }
  }
  async uploadSession(actor: CloudActor, uploadId: string) {
    return this.#tx(actor,async tx => { await this.#uploadState(tx,actor,uploadId); await this.#expireUploads(tx,actor); return this.#uploadState(tx,actor,uploadId); });
  }
  async listUploads(actor: CloudActor, workspaceId: string) {
    return this.#tx(actor,async tx => {
      await this.#uploadsReady(tx); await this.#workspace(tx,actor,workspaceId); await this.#expireUploads(tx,actor);
      const rows = (await tx.query(`SELECT id FROM ${schema}.uploads WHERE workspace_id=$1 ORDER BY created_at DESC,id LIMIT 100`,[workspaceId])).rows;
      const result: CloudUploadState[]=[]; for (const row of rows) result.push(await this.#uploadState(tx,actor,String(row.id))); return result;
    });
  }
  async recordUploadChunk(actor: CloudActor, uploadId: string, chunk: CloudUploadChunk) {
    await this.uploadSession(actor,uploadId);
    return this.#tx(actor,async tx => {
      const state=await this.#uploadState(tx,actor,uploadId,true); assertUploadActive(state.session); validateUploadChunk(state.session,chunk);
      if (Number(state.session.expires_at)<=await this.#now(tx)) throw new CloudWorkspaceError('upload_expired',410);
      const old=state.chunks.find(item=>item.index===chunk.index);
      if (old) { if (old.size!==chunk.size || old.sha256!==chunk.sha256) throw new CloudWorkspaceError('chunk_conflict',409); return state; }
      if (state.session.state!=='uploading') throw new CloudWorkspaceError('upload_not_pending',409);
      await tx.query(`INSERT INTO ${schema}.upload_chunks(upload_id,workspace_id,owner_user,studio_id,chunk_index,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`,[uploadId,state.session.workspace_id,actor.userId,actor.studioId,chunk.index,chunk.size,chunk.sha256]);
      await tx.query(`UPDATE ${schema}.uploads SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,[uploadId]);
      return this.#uploadState(tx,actor,uploadId);
    });
  }
  async beginUploadCompletion(actor: CloudActor, uploadId: string) {
    await this.uploadSession(actor,uploadId);
    return this.#tx(actor,async tx => {
      const state=await this.#uploadState(tx,actor,uploadId,true);
      if (state.session.state==='completed') return state;
      assertUploadActive(state.session);
      if (Number(state.session.expires_at)<=await this.#now(tx)) throw new CloudWorkspaceError('upload_expired',410);
      const manifest=uploadManifest(state.session,state.chunks);
      if (state.session.state==='uploading') await tx.query(`UPDATE ${schema}.uploads SET state='completing',manifest_sha256=$1,revision=revision+1,updated_at=clock_timestamp() WHERE id=$2`,[manifest,uploadId]);
      else if (state.session.manifest_sha256!==manifest) throw new CloudWorkspaceError('upload_manifest_mismatch',409);
      return this.#uploadState(tx,actor,uploadId);
    });
  }
  async finalizeUpload(actor: CloudActor, uploadId: string, manifest: string) {
    await this.uploadSession(actor,uploadId);
    return this.#tx(actor,async tx => {
      const state=await this.#uploadState(tx,actor,uploadId,true),row=state.session;
      if (row.manifest_sha256!==manifest || uploadManifest(row,state.chunks)!==manifest) throw new CloudWorkspaceError('upload_manifest_mismatch',409);
      if (row.state==='completed') return {file:await this.#summary(tx,actor,String(row.file_id)),version:publicVersion(state.version),upload:publicUpload(state)};
      assertUploadActive(row);
      if (row.state!=='completing') throw new CloudWorkspaceError('upload_not_pending',409);
      if (Number(row.expires_at)<=await this.#now(tx)) throw new CloudWorkspaceError('upload_expired',410);
      const file=await this.#file(tx,actor,String(row.file_id),true);
      const version=(await tx.query(`SELECT * FROM ${schema}.versions WHERE id=$1 FOR UPDATE`,[row.version_id])).rows[0];
      if (!version || version.status!=='staging') throw new CloudWorkspaceError('upload_not_pending',409);
      if (file.current_version!==row.expected_version) throw new CloudWorkspaceError('version_conflict',409);
      const changed=await tx.query(`UPDATE ${schema}.files SET current_version=$1 WHERE id=$2 AND current_version IS NOT DISTINCT FROM $3::uuid RETURNING id`,[row.version_id,row.file_id,row.expected_version]);
      if (changed.rowCount!==1) throw new CloudWorkspaceError('version_conflict',409);
      await tx.query(`UPDATE ${schema}.versions SET status='ready' WHERE id=$1`,[row.version_id]);
      await tx.query(`UPDATE ${schema}.uploads SET state='completed',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,[uploadId]);
      await this.#event(tx,file,null,'file.version_ready',{fileId:row.file_id,versionId:row.version_id});
      return {file:await this.#summary(tx,actor,String(row.file_id)),version:publicVersion(version),upload:publicUpload(await this.#uploadState(tx,actor,uploadId))};
    });
  }
  async cancelUpload(actor: CloudActor, uploadId: string) {
    await this.uploadSession(actor,uploadId);
    return this.#tx(actor,async tx => {
      const state=await this.#uploadState(tx,actor,uploadId,true);
      if (activeUpload(state.session)) {
        await tx.query(`UPDATE ${schema}.uploads SET state='cancelled',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`,[uploadId]);
        await this.#reject(tx,String(state.session.version_id));
      }
      return this.#uploadState(tx,actor,uploadId);
    });
  }
  async retryRun(actor: CloudActor, runId: string, requestKey: string) {
    uploadRequestKey(requestKey);
    return this.#tx(actor,async tx => {
      await this.#uploadsReady(tx);
      const source=(await tx.query(`SELECT * FROM ${schema}.runs WHERE id=$1 AND owner_user=$2 AND studio_id=$3 FOR UPDATE`,[uuid(runId),actor.userId,actor.studioId])).rows[0];
      if (!source) throw new CloudWorkspaceError('not_found',404);
      if (source.operation==='agent-conversation') throw new CloudWorkspaceError('run_not_retryable',409);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`codia-run:${source.workspace_id}:${requestKey}`]);
      const old=(await tx.query(`SELECT * FROM ${schema}.runs WHERE workspace_id=$1 AND request_key=$2`,[source.workspace_id,requestKey])).rows[0];
      if (old) { if (old.retry_of!==runId || old.input_version!==source.input_version || old.operation!==source.operation) throw new CloudWorkspaceError('idempotency_conflict',409); return publicRun(old); }
      if (source.status!=='failed') throw new CloudWorkspaceError('run_not_retryable',409);
      const run=await this.#createRun(tx,actor,String(source.workspace_id),String(source.input_version),requestKey,source.operation as CloudOperation);
      const retried=(await tx.query(`UPDATE ${schema}.runs SET retry_of=$1 WHERE id=$2 RETURNING *`,[runId,run.id])).rows[0];
      await this.#event(tx,source,String(run.id),'run.retried',{runId:run.id,retryOf:runId});
      return publicRun(retried);
    });
  }
  async close() { await this.#close?.(); }
  async #tx<T>(actor: CloudActor | null, work: (tx: PgQueryable) => Promise<T>): Promise<T> {
    const context = actor ? actorContext(actor) : { tenantId: '__internal_worker__', actorId: '__internal_worker__' };
    return this.database.transaction(context, async tx => {
      await tx.query("SELECT set_config('codia.trusted_worker',$1,true)", [actor ? 'off' : 'on']);
      await tx.query("SET LOCAL statement_timeout = '15s'");
      await tx.query("SET LOCAL lock_timeout = '10s'");
      return work(tx);
    });
  }
  async verifySchema() {
    await this.#tx(null, async tx => {
      await this.#schedulesReady(tx);
      await this.#uploadsReady(tx);
      const role = (await tx.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
      if (!role || role.rolsuper || role.rolbypassrls) throw new CloudWorkspaceError('cloud_database_runtime_role_must_enforce_rls', 503);
    });
  }
  async #schedulesReady(tx: PgQueryable) {
    try {
      const result = await tx.query(`SELECT version FROM ${schema}.schema_version WHERE version=4 AND to_regclass('${schema}.schedules') IS NOT NULL`);
      if (result.rows.length !== 1) throw new CloudWorkspaceError('cloud_database_migration_required', 503);
    } catch (error) {
      if (['42P01', '3F000'].includes(String((error as {code?: string}).code))) throw new CloudWorkspaceError('cloud_database_migration_required', 503);
      throw error;
    }
  }
  async #now(tx: PgQueryable, timestamp?: number) {
    if (timestamp !== undefined) { if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new CloudWorkspaceError('invalid_timestamp'); return timestamp; }
    const result = await tx.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now');
    return Number(result.rows[0].now);
  }
  async #workspace(tx: PgQueryable, actor: CloudActor, workspaceId: string, lock = false): Promise<CloudRow> {
    const result = await tx.query(`SELECT * FROM ${schema}.workspaces WHERE id=$1 AND owner_user=$2 AND studio_id=$3${lock ? ' FOR UPDATE' : ''}`, [uuid(workspaceId), actor.userId, actor.studioId]);
    if (!result.rows[0]) throw new CloudWorkspaceError('not_found', 404);
    return result.rows[0];
  }
  async #file(tx: PgQueryable, actor: CloudActor, fileId: string, lock = false): Promise<CloudRow> {
    const result = await tx.query(`SELECT * FROM ${schema}.files WHERE id=$1 AND owner_user=$2 AND studio_id=$3${lock ? ' FOR UPDATE' : ''}`, [uuid(fileId), actor.userId, actor.studioId]);
    if (!result.rows[0]) throw new CloudWorkspaceError('not_found', 404);
    return result.rows[0];
  }
  async #version(tx: PgQueryable, actor: CloudActor, versionId: string): Promise<CloudRow> {
    const result = await tx.query(`SELECT v.*,f.name FROM ${schema}.versions v JOIN ${schema}.files f ON f.id=v.file_id WHERE v.id=$1 AND v.owner_user=$2 AND v.studio_id=$3 AND v.status='ready'`, [uuid(versionId), actor.userId, actor.studioId]);
    if (!result.rows[0]) throw new CloudWorkspaceError('not_found', 404);
    return result.rows[0];
  }
  async #summary(tx: PgQueryable, actor: CloudActor, fileId: string): Promise<CloudRow> {
    const result = await tx.query(`SELECT f.*,v.size,v.sha256,(SELECT COUNT(*)::integer FROM ${schema}.versions v2 WHERE v2.file_id=f.id AND v2.status='ready') AS version_count FROM ${schema}.files f JOIN ${schema}.versions v ON v.id=f.current_version AND v.status='ready' WHERE f.id=$1 AND f.owner_user=$2 AND f.studio_id=$3`, [uuid(fileId), actor.userId, actor.studioId]);
    if (!result.rows[0]) throw new CloudWorkspaceError('not_found', 404);
    return stripScope(result.rows[0]);
  }
  async #event(tx: PgQueryable, scope: CloudRow, runId: string | null, kind: string, payload: unknown) {
    // A sequence alone does not follow commit order. Serialize allocation per
    // workspace so a reconnect cursor cannot skip a lower ID committed later.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`codia-event:${scope.workspace_id ?? scope.id}`]);
    await tx.query(`INSERT INTO ${schema}.outbox(workspace_id,owner_user,studio_id,run_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [scope.workspace_id ?? scope.id, scope.owner_user, scope.studio_id, runId, kind, JSON.stringify(payload)]);
  }
  async workspace(actor: CloudActor, workspaceId: string) { return this.#tx(actor, async tx => stripScope(await this.#workspace(tx, actor, workspaceId))); }
  async listWorkspaces(actor: CloudActor) { return this.#tx(actor, async tx => (await tx.query(`SELECT id,name,created_at FROM ${schema}.workspaces WHERE owner_user=$1 AND studio_id=$2 ORDER BY created_at,id`, [actor.userId, actor.studioId])).rows.map(stripScope)); }
  async createWorkspace(actor: CloudActor, name: string) {
    const normalized = validName(name);
    return this.#tx(actor, async tx => stripScope((await tx.query(`INSERT INTO ${schema}.workspaces(id,owner_user,studio_id,name) VALUES($1,$2,$3,$4) RETURNING id,name,created_at`, [id(), actor.userId, actor.studioId, normalized])).rows[0]));
  }
  async file(actor: CloudActor, fileId: string) { return this.#tx(actor, async tx => stripScope(await this.#file(tx, actor, fileId))); }
  async version(actor: CloudActor, versionId: string) { return this.#tx(actor, async tx => stripScope(await this.#version(tx, actor, versionId))); }
  async listFiles(actor: CloudActor, workspaceId: string) {
    return this.#tx(actor, async tx => {
      await this.#workspace(tx, actor, workspaceId);
      return (await tx.query(`SELECT f.*,v.size,v.sha256,(SELECT COUNT(*)::integer FROM ${schema}.versions v2 WHERE v2.file_id=f.id AND v2.status='ready') AS version_count FROM ${schema}.files f JOIN ${schema}.versions v ON v.id=f.current_version AND v.status='ready' WHERE f.workspace_id=$1 AND f.owner_user=$2 AND f.studio_id=$3 ORDER BY f.created_at,f.id`, [workspaceId, actor.userId, actor.studioId])).rows.map(stripScope);
    });
  }
  async fileSummary(actor: CloudActor, fileId: string) { return this.#tx(actor, tx => this.#summary(tx, actor, fileId)); }
  async versions(actor: CloudActor, fileId: string) {
    return this.#tx(actor, async tx => { await this.#file(tx, actor, fileId); return (await tx.query(`SELECT id,size,sha256,created_at FROM ${schema}.versions WHERE file_id=$1 AND owner_user=$2 AND studio_id=$3 AND status='ready' ORDER BY created_at,id`, [fileId, actor.userId, actor.studioId])).rows.map(publicVersion); });
  }
  async stageVersion(actor: CloudActor, workspaceId: string, name: string, size: number, sha256: string, fileId?: string, expectedVersion?: string): Promise<StagedCloudVersion> {
    metadata(size, sha256);
    try {
      return await this.#tx(actor, async tx => {
        const workspace = await this.#workspace(tx, actor, workspaceId);
        const stale = (await tx.query(`SELECT id FROM ${schema}.versions v WHERE status='staging' AND NOT EXISTS(SELECT 1 FROM ${schema}.uploads u WHERE u.version_id=v.id AND u.state IN ('uploading','completing')) AND created_at<clock_timestamp()-interval '5 minutes' ORDER BY file_id,id LIMIT 200`)).rows;
        for (const row of stale) await this.#reject(tx, String(row.id));
        let file: CloudRow;
        if (fileId) {
          file = await this.#file(tx, actor, fileId, true);
          if (file.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
          if (!expectedVersion || file.current_version !== expectedVersion) throw new CloudWorkspaceError('version_conflict', 409);
        } else {
          file = (await tx.query(`INSERT INTO ${schema}.files(id,workspace_id,owner_user,studio_id,name) VALUES($1,$2,$3,$4,$5) RETURNING *`, [id(), workspaceId, workspace.owner_user, workspace.studio_id, validName(name)])).rows[0];
        }
        const versionId = id(), objectKey = `workspaces/${workspaceId}/files/${file.id}/versions/${versionId}`;
        const version = (await tx.query(`INSERT INTO ${schema}.versions(id,file_id,workspace_id,owner_user,studio_id,object_key,size,sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'staging') RETURNING *`, [versionId, file.id, workspaceId, workspace.owner_user, workspace.studio_id, objectKey, size, sha256])).rows[0];
        return { file: stripScope(file), version: stripScope(version), expected: file.current_version };
      });
    } catch (error) { if ((error as {code?: string}).code === '23505') throw new CloudWorkspaceError('file_name_exists', 409); throw error; }
  }
  async finalizeVersion(actor: CloudActor, versionId: string, expected: string | null, enqueue?: EnqueueCloudRun) {
    return this.#tx(actor, async tx => {
      // File first everywhere: competing finalize/reject/reconcile cannot deadlock.
      const found = (await tx.query(`SELECT file_id FROM ${schema}.versions WHERE id=$1 AND owner_user=$2 AND studio_id=$3`, [uuid(versionId), actor.userId, actor.studioId])).rows[0];
      if (!found) throw new CloudWorkspaceError('not_found', 404);
      const file = await this.#file(tx, actor, String(found.file_id), true);
      const version = (await tx.query(`SELECT * FROM ${schema}.versions WHERE id=$1 FOR UPDATE`, [versionId])).rows[0];
      if (!version || version.status !== 'staging') throw new CloudWorkspaceError('upload_not_pending', 409);
      if (file.current_version !== expected) throw new CloudWorkspaceError('version_conflict', 409);
      const changed = await tx.query(`UPDATE ${schema}.files SET current_version=$1 WHERE id=$2 AND current_version IS NOT DISTINCT FROM $3::uuid RETURNING id`, [versionId, file.id, expected]);
      if (changed.rowCount !== 1) throw new CloudWorkspaceError('version_conflict', 409);
      await tx.query(`UPDATE ${schema}.versions SET status='ready' WHERE id=$1 AND status='staging'`, [versionId]);
      await this.#event(tx, file, null, 'file.version_ready', { fileId: file.id, versionId });
      const run = enqueue ? await this.#createRun(tx, actor, file.workspace_id, versionId, enqueue.requestKey, enqueue.operation) : undefined;
      return { file: await this.#summary(tx, actor, file.id), version: publicVersion(version), ...(run ? {run} : {}) };
    });
  }
  async #reject(tx: PgQueryable, versionId: string) {
    const found = (await tx.query(`SELECT file_id FROM ${schema}.versions WHERE id=$1 AND status='staging'`, [uuid(versionId)])).rows[0];
    if (!found) return;
    await tx.query(`SELECT id FROM ${schema}.files WHERE id=$1 FOR UPDATE`, [found.file_id]);
    const rejected = await tx.query(`UPDATE ${schema}.versions SET status='rejected' WHERE id=$1 AND status='staging' RETURNING file_id`, [versionId]);
    // Internal names contain '/', which validName forbids for public files.
    // Keep the row/history, release its original name, and never rename a ready file.
    if (rejected.rowCount) await tx.query(`UPDATE ${schema}.files SET name='.rejected/' || id::text WHERE id=$1 AND current_version IS NULL AND NOT EXISTS(SELECT 1 FROM ${schema}.versions WHERE file_id=$1 AND status='staging')`, [found.file_id]);
  }
  async rejectVersion(versionId: string) { await this.#tx(null, tx => this.#reject(tx, versionId)); }
  async reconcileStaging(timestamp?: number, graceMs = 300_000) {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new CloudWorkspaceError('invalid_staging_grace');
    return this.#tx(null, async tx => {
      const now = await this.#now(tx, timestamp);
      const stale = (await tx.query(`SELECT id FROM ${schema}.versions v WHERE status='staging' AND NOT EXISTS(SELECT 1 FROM ${schema}.uploads u WHERE u.version_id=v.id AND u.state IN ('uploading','completing')) AND created_at<to_timestamp($1/1000.0) ORDER BY file_id,id LIMIT 200`, [now - graceMs])).rows;
      for (const row of stale) await this.#reject(tx, String(row.id));
      return stale.length;
    });
  }
  async createRun(actor: CloudActor, workspaceId: string, inputVersion: string, requestKey: string, operation: CloudOperation = 'document-summary') {
    if (typeof requestKey === 'string' && requestKey.startsWith('schedule_')) throw new CloudWorkspaceError('reserved_request_key');
    return this.#tx(actor, tx => this.#createRun(tx, actor, workspaceId, inputVersion, requestKey, operation));
  }
  async #createRun(tx: PgQueryable, actor: CloudActor, workspaceId: string, inputVersion: string, requestKey: string, operation: CloudOperation, scheduled = false) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey || '')) throw new CloudWorkspaceError('invalid_request_key');
    if (!scheduled && requestKey.startsWith('schedule_')) throw new CloudWorkspaceError('reserved_request_key');
    if (!['document-summary','agent-summary','agent-conversation','agent-task'].includes(operation)) throw new CloudWorkspaceError('unsupported_operation');
    if (operation === 'agent-task') await this.#schedulesReady(tx);
      const workspace = await this.#workspace(tx, actor, workspaceId);
      const input = await this.#version(tx, actor, inputVersion);
      if (input.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
      if (Number(input.size) > (operation === 'document-summary' ? CLOUD_DOCUMENT_INPUT_LIMIT : CLOUD_AGENT_INPUT_LIMIT)) throw new CloudWorkspaceError(operation === 'document-summary' ? 'document_input_too_large' : 'agent_input_too_large',413);
      // Serialize only this idempotency key, without serializing the entire queue.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`codia-run:${workspaceId}:${requestKey}`]);
      const old = (await tx.query(`SELECT * FROM ${schema}.runs WHERE workspace_id=$1 AND request_key=$2`, [workspaceId, requestKey])).rows[0];
      if (old) { if (old.input_version !== inputVersion || old.operation !== operation) throw new CloudWorkspaceError('idempotency_conflict', 409); return publicRun(old); }
      const run = (await tx.query(`INSERT INTO ${schema}.runs(id,workspace_id,owner_user,studio_id,input_version,operation,request_key,status) VALUES($1,$2,$3,$4,$5,$6,$7,'queued') RETURNING *`, [id(), workspaceId, workspace.owner_user, workspace.studio_id, inputVersion, operation, requestKey])).rows[0];
      await this.#event(tx, run, String(run.id), 'run.queued', { runId: run.id });
      return publicRun(run);
  }
  async cancelRun(actor: CloudActor, runId: string) {
    return this.#tx(actor, async tx => {
      const run = (await tx.query(`SELECT * FROM ${schema}.runs WHERE id=$1 AND owner_user=$2 AND studio_id=$3 FOR UPDATE`, [uuid(runId), actor.userId, actor.studioId])).rows[0];
      if (!run) throw new CloudWorkspaceError('not_found', 404);
      if (run.status !== 'queued' && run.status !== 'running') return publicRun(run);
      const cancelled = (await tx.query(`UPDATE ${schema}.runs SET status='failed',error='cancelled',lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`, [runId])).rows[0];
      await this.#event(tx, run, runId, 'run.cancelled', { runId });
      return publicRun(cancelled);
    });
  }
  async listSchedules(actor: CloudActor, workspaceId: string) {
    return this.#tx(actor, async tx => {
      await this.#schedulesReady(tx);
      await this.#workspace(tx, actor, workspaceId);
      return (await tx.query(`SELECT * FROM ${schema}.schedules WHERE workspace_id=$1 AND owner_user=$2 AND studio_id=$3 ORDER BY created_at,id`, [workspaceId, actor.userId, actor.studioId])).rows.map(publicSchedule);
    });
  }
  async schedule(actor: CloudActor, scheduleId: string) {
    return this.#tx(actor, async tx => {
      await this.#schedulesReady(tx);
      const row = (await tx.query(`SELECT * FROM ${schema}.schedules WHERE id=$1 AND owner_user=$2 AND studio_id=$3`, [uuid(scheduleId), actor.userId, actor.studioId])).rows[0];
      if (!row) throw new CloudWorkspaceError('not_found', 404);
      return publicSchedule(row);
    });
  }
  async createSchedule(actor: CloudActor, workspaceId: string, input: CreateCloudSchedule) {
    return this.#tx(actor, async tx => {
      await this.#schedulesReady(tx);
      const workspace = await this.#workspace(tx, actor, workspaceId);
      const spec = normalizeSchedule(input);
      const version = await this.#version(tx, actor, spec.inputVersion);
      if (version.workspace_id !== workspaceId) throw new CloudWorkspaceError('not_found', 404);
      if (Number(version.size) > (spec.operation === 'document-summary' ? CLOUD_DOCUMENT_INPUT_LIMIT : CLOUD_AGENT_INPUT_LIMIT)) throw new CloudWorkspaceError(spec.operation === 'document-summary' ? 'document_input_too_large' : 'agent_input_too_large',413);
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`codia-schedule:${workspaceId}:${input.requestKey}`]);
      const old = (await tx.query(`SELECT * FROM ${schema}.schedules WHERE workspace_id=$1 AND request_key=$2`, [workspaceId, input.requestKey])).rows[0];
      if (old) {
        if (!sameScheduleSpecification(old.creation_spec, spec)) throw new CloudWorkspaceError('idempotency_conflict', 409);
        return publicSchedule(old);
      }
      const schedule = (await tx.query(`INSERT INTO ${schema}.schedules(id,workspace_id,owner_user,studio_id,input_version,operation,name,request_key,state,next_run_at,interval_ms,creation_spec)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) RETURNING *`,
      [id(), workspaceId, workspace.owner_user, workspace.studio_id, spec.inputVersion, spec.operation, spec.name,
        input.requestKey, spec.enabled ? 'enabled' : 'paused', spec.firstRunAt, spec.intervalMs, JSON.stringify(spec)])).rows[0];
      await this.#event(tx, schedule, null, 'schedule.created', { scheduleId: schedule.id, state: schedule.state, revision: 1 });
      return publicSchedule(schedule);
    });
  }
  async setScheduleEnabled(actor: CloudActor, scheduleId: string, expectedRevision: number, enabled: boolean) {
    return this.#tx(actor, async tx => {
      await this.#schedulesReady(tx);
      const schedule = (await tx.query(`SELECT * FROM ${schema}.schedules WHERE id=$1 AND owner_user=$2 AND studio_id=$3 FOR UPDATE`, [uuid(scheduleId), actor.userId, actor.studioId])).rows[0];
      if (!schedule) throw new CloudWorkspaceError('not_found', 404);
      scheduleRevision(expectedRevision, enabled);
      if (Number(schedule.revision) !== expectedRevision) throw new CloudWorkspaceError('schedule_conflict', 409);
      if (schedule.state === 'completed') {
        if (enabled) throw new CloudWorkspaceError('schedule_completed', 409);
        return publicSchedule(schedule);
      }
      const state = enabled ? 'enabled' : 'paused';
      if (schedule.state === state) return publicSchedule(schedule);
      const changed = (await tx.query(`UPDATE ${schema}.schedules SET state=$1,revision=revision+1,updated_at=clock_timestamp() WHERE id=$2 AND revision=$3 RETURNING *`, [state, scheduleId, expectedRevision])).rows[0];
      if (!changed) throw new CloudWorkspaceError('schedule_conflict', 409);
      await this.#event(tx, schedule, null, enabled ? 'schedule.enabled' : 'schedule.paused', { scheduleId, revision: expectedRevision + 1 });
      return publicSchedule(changed);
    });
  }
  async dispatchDueSchedules(timestamp?: number, limit = 100) {
    if (timestamp !== undefined) scheduleTimestamp(timestamp);
    scheduleLimit(limit);
    let count = 0;
    // Each occurrence is one short atomic transaction. This also avoids taking
    // per-workspace event locks in differing orders across dispatcher batches.
    for (let index = 0; index < limit; index += 1) {
      const result = await this.#tx(null, async tx => {
        await this.#schedulesReady(tx);
        const now = scheduleTimestamp(await this.#now(tx, timestamp));
        const schedule = (await tx.query(`SELECT * FROM ${schema}.schedules WHERE state='enabled' AND next_run_at<=$1 ORDER BY next_run_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now])).rows[0];
        if (!schedule) return null;
        const due = Number(schedule.next_run_at), interval = schedule.interval_ms === null ? null : Number(schedule.interval_ms);
        const active = schedule.last_run_id && (await tx.query(`SELECT id FROM ${schema}.runs WHERE id=$1 AND status IN ('queued','running')`, [schedule.last_run_id])).rows[0];
        let run: CloudRow | null = null;
        if (!active) {
          await tx.query('SAVEPOINT schedule_occurrence');
          try {
            run = await this.#createRun(tx, {userId: String(schedule.owner_user), studioId: String(schedule.studio_id)}, String(schedule.workspace_id),
              String(schedule.input_version), `schedule_${schedule.id}_${due}`, schedule.operation as CloudOperation, true);
          } catch (error) {
            const rejection = scheduleDispatchRejection(error);
            if (!rejection) throw error;
            // Keep the selected schedule lock but discard all occurrence writes.
            // Pause and diagnostic outbox entry then commit together.
            await tx.query('ROLLBACK TO SAVEPOINT schedule_occurrence');
            await tx.query('RELEASE SAVEPOINT schedule_occurrence');
            await tx.query(`UPDATE ${schema}.schedules SET state='paused',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [schedule.id]);
            await this.#event(tx, schedule, null, 'schedule.paused', {
              scheduleId: schedule.id, dueAt: due, revision: Number(schedule.revision) + 1,
              reason: 'dispatch_rejected', error: rejection,
            });
            return false;
          }
          await tx.query('RELEASE SAVEPOINT schedule_occurrence');
        }
        const next = nextScheduleOccurrence(due, interval, now), state = interval === null ? 'completed' : 'enabled';
        await tx.query(`UPDATE ${schema}.schedules SET state=$1,next_run_at=$2,revision=revision+1,last_run_id=$3,updated_at=clock_timestamp() WHERE id=$4`, [state, next, run?.id ?? schedule.last_run_id, schedule.id]);
        await this.#event(tx, schedule, run?.id ?? schedule.last_run_id as string | null, active ? 'schedule.skipped' : 'schedule.dispatched', {
          scheduleId: schedule.id, dueAt: due, nextRunAt: next, revision: Number(schedule.revision) + 1,
          ...(active ? { reason: 'overlap', runId: schedule.last_run_id } : { runId: run!.id }),
        });
        return !!run;
      });
      if (result === null) break;
      if (result) count += 1;
    }
    return count;
  }
  async listRuns(actor: CloudActor, workspaceId: string) { return this.#tx(actor, async tx => { await this.#workspace(tx, actor, workspaceId); return (await tx.query(`SELECT * FROM ${schema}.runs WHERE workspace_id=$1 AND owner_user=$2 AND studio_id=$3 ORDER BY created_at DESC,id`, [workspaceId, actor.userId, actor.studioId])).rows.map(publicRun); }); }
  async #publish(tx: PgQueryable) {
    // Publisher lock preserves event visibility order between concurrent API/worker publishers.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('codia-outbox-publisher',0))");
    await tx.query(`WITH pending AS (SELECT * FROM ${schema}.outbox WHERE NOT published ORDER BY id LIMIT 2000 FOR UPDATE), inserted AS (INSERT INTO ${schema}.events(id,workspace_id,owner_user,studio_id,run_id,kind,payload,created_at) SELECT id,workspace_id,owner_user,studio_id,run_id,kind,payload,created_at FROM pending ON CONFLICT(id) DO NOTHING RETURNING id) UPDATE ${schema}.outbox SET published=true WHERE id IN(SELECT id FROM pending)`);
  }
  async publishOutbox() { await this.#tx(null, tx => this.#publish(tx)); }
  async run(actor: CloudActor, runId: string) {
    return this.#tx(actor, async tx => {
      const run = (await tx.query(`SELECT * FROM ${schema}.runs WHERE id=$1 AND owner_user=$2 AND studio_id=$3`, [uuid(runId), actor.userId, actor.studioId])).rows[0];
      if (!run) throw new CloudWorkspaceError('not_found', 404);
      await this.#publish(tx);
      return { run: publicRun(run), events: (await tx.query(`SELECT * FROM ${schema}.events WHERE run_id=$1 ORDER BY id`, [runId])).rows.map(publicEvent), artifacts: (await tx.query(`SELECT a.id,a.run_id,a.file_id,a.version_id,f.name,v.size FROM ${schema}.artifacts a JOIN ${schema}.files f ON f.id=a.file_id JOIN ${schema}.versions v ON v.id=a.version_id WHERE a.run_id=$1`, [runId])).rows.map(stripScope) };
    });
  }
  async events(actor: CloudActor, workspaceId: string, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new CloudWorkspaceError('invalid_event_cursor');
    return this.#tx(actor, async tx => { await this.#workspace(tx, actor, workspaceId); await this.#publish(tx); const events = (await tx.query(`SELECT * FROM ${schema}.events WHERE workspace_id=$1 AND owner_user=$2 AND studio_id=$3 AND id>$4 ORDER BY id LIMIT 200`, [workspaceId, actor.userId, actor.studioId, after])).rows.map(publicEvent); return { events, cursor: events.at(-1)?.id ?? after }; });
  }
  async claim(leaseMs = 30_000, timestamp?: number): Promise<CloudRow | null> {
    duration(leaseMs);
    return this.#tx(null, async tx => {
      const now = await this.#now(tx, timestamp);
      const exhausted = (await tx.query(`SELECT * FROM ${schema}.runs WHERE status='running' AND lease_until<=$1 AND attempt>=3 ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED`, [now])).rows;
      for (const run of exhausted) { await tx.query(`UPDATE ${schema}.runs SET status='failed',error='retry_limit',lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1`, [run.id]); await this.#event(tx, run, String(run.id), 'run.failed', { error: 'retry_limit' }); }
      const row = (await tx.query(`SELECT r.*,v.object_key,v.sha256,v.size,f.name FROM ${schema}.runs r JOIN ${schema}.versions v ON v.id=r.input_version JOIN ${schema}.files f ON f.id=v.file_id WHERE (r.status='queued' OR (r.status='running' AND r.lease_until<=$1)) AND r.attempt<3 ORDER BY r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`, [now])).rows[0];
      if (!row) return null;
      const attempt = Number(row.attempt) + 1, lease = (await this.#now(tx, timestamp)) + leaseMs;
      await tx.query(`UPDATE ${schema}.runs SET status='running',attempt=$1,lease_until=$2,updated_at=clock_timestamp() WHERE id=$3`, [attempt, lease, row.id]);
      await this.#event(tx, row, String(row.id), 'run.running', { attempt, recovered: Number(row.attempt) > 0 });
      return { ...row, attempt, lease_until: lease, status: 'running', size: Number(row.size) };
    });
  }
  async renewLease(run: CloudRow, leaseMs = 30_000, timestamp?: number) {
    duration(leaseMs);
    return this.#tx(null, async tx => {
      const current = (await tx.query(`SELECT lease_until FROM ${schema}.runs WHERE id=$1 AND status='running' AND attempt=$2 FOR UPDATE`, [uuid(run.id), run.attempt])).rows[0];
      const now = await this.#now(tx, timestamp);
      if (!current || Number(current.lease_until) <= now) return false;
      return (await tx.query(`UPDATE ${schema}.runs SET lease_until=GREATEST(lease_until,$1),updated_at=clock_timestamp() WHERE id=$2 AND status='running' AND attempt=$3 AND lease_until>COALESCE($4::bigint,floor(extract(epoch from clock_timestamp())*1000)::bigint) RETURNING id`, [now + leaseMs, run.id, run.attempt, timestamp ?? null])).rowCount === 1;
    });
  }
  async complete(run: CloudRow, output: CloudOutput, timestamp?: number) {
    metadata(output.size, output.sha256); validateObjectKey(output.objectKey);
    return this.#tx(null, async tx => {
      const current = (await tx.query(`SELECT * FROM ${schema}.runs WHERE id=$1 AND status='running' AND attempt=$2 FOR UPDATE`, [uuid(run.id), run.attempt])).rows[0];
      const now = await this.#now(tx, timestamp);
      if (!current || Number(current.lease_until) <= now) throw new CloudWorkspaceError('stale_executor', 409);
      // Persisted run scope is authoritative, never caller-supplied run fields.
      const fileId = id(), versionId = id(), name = current.operation === 'agent-task' ? `task-session-${current.id}.json` : `检查结果-${String(current.id)}.md`;
      const scope = [current.workspace_id, current.owner_user, current.studio_id];
      await tx.query(`INSERT INTO ${schema}.files(id,workspace_id,owner_user,studio_id,name,current_version) VALUES($1,$2,$3,$4,$5,$6)`, [fileId, ...scope, name, versionId]);
      await tx.query(`INSERT INTO ${schema}.versions(id,file_id,workspace_id,owner_user,studio_id,object_key,size,sha256,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready')`, [versionId, fileId, ...scope, output.objectKey, output.size, output.sha256]);
      await tx.query(`INSERT INTO ${schema}.artifacts(id,run_id,file_id,version_id,workspace_id,owner_user,studio_id) VALUES($1,$2,$3,$4,$5,$6,$7)`, [id(), current.id, fileId, versionId, ...scope]);
      const completed = await tx.query(`UPDATE ${schema}.runs SET status='succeeded',artifact_file_id=$1,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$2 AND status='running' AND attempt=$3 AND lease_until>COALESCE($4::bigint,floor(extract(epoch from clock_timestamp())*1000)::bigint) RETURNING id`, [fileId, current.id, run.attempt, timestamp ?? null]);
      if (completed.rowCount !== 1) throw new CloudWorkspaceError('stale_executor', 409);
      await this.#event(tx, current, String(current.id), 'run.succeeded', { fileId, versionId });
      return { fileId, versionId };
    });
  }
  async fail(run: CloudRow, code: string) {
    const safeCode = /^[a-z_]{1,100}$/.test(code) ? code : 'processing_failed';
    await this.#tx(null, async tx => {
      await tx.query(`SELECT id FROM ${schema}.runs WHERE id=$1 AND status='running' AND attempt=$2 FOR UPDATE`, [uuid(run.id), run.attempt]);
      const result = await tx.query(`UPDATE ${schema}.runs SET status='failed',error=$1,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$2 AND status='running' AND attempt=$3 AND lease_until>floor(extract(epoch from clock_timestamp())*1000)::bigint RETURNING *`, [safeCode, run.id, run.attempt]);
      if (result.rows[0]) await this.#event(tx, result.rows[0], run.id, 'run.failed', { error: safeCode });
    });
  }
}
