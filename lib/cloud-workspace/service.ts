import crypto from 'node:crypto';
import { CloudWorkspaceError, CloudWorkspaceStore, type CloudActor, type CloudRow } from './store.ts';
import { asAsyncWorkspaceRepository, type CloudWorkspaceRepository, type EnqueueCloudRun } from './repository.ts';
import type { CloudAgentExecutor } from './agent-executor.ts';
import { ObjectAlreadyExistsError, type ObjectStore } from './object-store.ts';
import { publicUpload, uploadHash, uploadChunkKey, uploadChunkSize, assertUploadActive, CLOUD_RESUMABLE_UPLOAD_LIMIT, type CreateCloudUpload } from './uploads.ts';
export const CLOUD_UPLOAD_LIMIT = 2 * 1024 * 1024;
// Process-wide admission bounds duplicate/completing buffers; durable correctness
// remains in the database and therefore also covers independent API processes.
const uploadCompletions = new Map<string, Promise<{file: CloudRow; version: CloudRow; upload: CloudRow}>>();
const CLOUD_COMPLETION_CONCURRENCY = 2;
export class CloudWorkspaceService {
  declare store: CloudWorkspaceRepository;
  declare agentExecutor?: CloudAgentExecutor;
  declare objects: ObjectStore;
  constructor(store: CloudWorkspaceStore | CloudWorkspaceRepository, objects: ObjectStore, agentExecutor?: CloudAgentExecutor) { this.store = asAsyncWorkspaceRepository(store); this.objects = objects; this.agentExecutor = agentExecutor; }
  async upload(actor: CloudActor, workspaceId: string, name: string, bytes: Buffer, fileId?: string, expectedVersion?: string, enqueue?: EnqueueCloudRun) {
    if (bytes.length > CLOUD_UPLOAD_LIMIT) throw new CloudWorkspaceError('file_too_large', 413);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const staged = await this.store.stageVersion(actor, workspaceId, name, bytes.length, sha256, fileId, expectedVersion);
    try {
      const saved = await this.objects.putImmutable(staged.version.object_key, bytes);
      if (saved.size !== bytes.length || saved.sha256 !== sha256) throw new CloudWorkspaceError('object_integrity_mismatch', 500);
      const persisted = await this.objects.get(staged.version.object_key);
      if (persisted.length !== bytes.length || crypto.createHash('sha256').update(persisted).digest('hex') !== sha256) throw new CloudWorkspaceError('object_integrity_mismatch', 500);
      return await this.store.finalizeVersion(actor, staged.version.id, staged.expected, enqueue);
    } catch (error) {
      await this.store.rejectVersion(staged.version.id);
      throw error;
    }
  }
  async createUpload(actor: CloudActor, workspaceId: string, input: CreateCloudUpload) { return publicUpload(await this.store.createUpload(actor,workspaceId,input)); }
  async uploadStatus(actor: CloudActor, uploadId: string) { return publicUpload(await this.store.uploadSession(actor,uploadId)); }
  async listUploads(actor: CloudActor, workspaceId: string) { return (await this.store.listUploads(actor,workspaceId)).map(publicUpload); }
  async cancelUpload(actor: CloudActor, uploadId: string) { return publicUpload(await this.store.cancelUpload(actor,uploadId)); }
  async #verifiedImmutable(key: string, bytes: Buffer, sha256: string) {
    try {
      const saved = await this.objects.putImmutable(key,bytes);
      if (saved.size!==bytes.length || saved.sha256!==sha256) throw new CloudWorkspaceError('object_integrity_mismatch',500);
    } catch (error) {
      // A prior uncertain PUT or competing identical completion may own the key.
      // Existence alone is never proof: every path verifies persisted bytes.
      if (!(error instanceof ObjectAlreadyExistsError)) throw error;
    }
    const persisted=await this.objects.get(key);
    if (persisted.length!==bytes.length || uploadHash(persisted)!==sha256) throw new CloudWorkspaceError('object_integrity_mismatch',409);
  }
  async uploadChunk(actor: CloudActor, uploadId: string, index: number, input: Buffer, claimedHash: string) {
    const bytes=Buffer.from(input),state=await this.store.uploadSession(actor,uploadId);
    assertUploadActive(state.session);
    if (bytes.length!==uploadChunkSize(state.session,index)) throw new CloudWorkspaceError('invalid_chunk_size');
    if (!/^[a-f0-9]{64}$/.test(claimedHash || '') || uploadHash(bytes)!==claimedHash) throw new CloudWorkspaceError('chunk_hash_mismatch');
    const old=state.chunks.find(item=>item.index===index);
    if (old && (old.size!==bytes.length || old.sha256!==claimedHash)) throw new CloudWorkspaceError('chunk_conflict',409);
    if (!old && state.session.state!=='uploading') throw new CloudWorkspaceError('upload_not_pending',409);
    await this.#verifiedImmutable(uploadChunkKey(state.session,index),bytes,claimedHash);
    return publicUpload(await this.store.recordUploadChunk(actor,uploadId,{index,size:bytes.length,sha256:claimedHash}));
  }
  async completeUpload(actor: CloudActor, uploadId: string) {
    // Authorize before consulting process-local dedupe so guessed IDs reveal nothing.
    const authorized=await this.store.uploadSession(actor,uploadId);
    if (authorized.session.state==='completed') return this.store.finalizeUpload(actor,uploadId,authorized.session.manifest_sha256);
    const key=JSON.stringify([actor.studioId,actor.userId,uploadId]);
    const existing=uploadCompletions.get(key); if (existing) return existing;
    if (uploadCompletions.size>=CLOUD_COMPLETION_CONCURRENCY) throw new CloudWorkspaceError('upload_completion_busy',503);
    const pending=this.#completeUpload(actor,uploadId).finally(()=>{uploadCompletions.delete(key);});
    uploadCompletions.set(key,pending); return pending;
  }
  async #completeUpload(actor: CloudActor, uploadId: string) {
    const state=await this.store.beginUploadCompletion(actor,uploadId);
    if (state.session.state==='completed') return this.store.finalizeUpload(actor,uploadId,state.session.manifest_sha256);
    const size=Number(state.session.size);
    if (!Number.isSafeInteger(size) || size<0 || size>CLOUD_RESUMABLE_UPLOAD_LIMIT) throw new CloudWorkspaceError('file_too_large',413);
    // The assembly buffer is at most 32 MiB, plus one chunk. Object adapters
    // additionally buffer writes/integrity reads; this is not S3 multipart
    // streaming. No transaction spans object I/O.
    const bytes=Buffer.alloc(size);
    for (const chunk of state.chunks) {
      const value=await this.objects.get(uploadChunkKey(state.session,chunk.index));
      if (value.length!==chunk.size || uploadHash(value)!==chunk.sha256) throw new CloudWorkspaceError('chunk_integrity_mismatch',409);
      value.copy(bytes,chunk.index*1024*1024);
    }
    if (uploadHash(bytes)!==state.session.sha256) throw new CloudWorkspaceError('upload_hash_mismatch',409);
    await this.#verifiedImmutable(state.version.object_key,bytes,state.session.sha256);
    // Do not reject on transient errors: this same frozen version can be retried.
    return this.store.finalizeUpload(actor,uploadId,state.session.manifest_sha256);
  }
  async read(actor: CloudActor, versionId: string) {
    const version = await this.store.version(actor, versionId);
    const bytes = await this.objects.get(version.object_key);
    if (bytes.length !== version.size || crypto.createHash('sha256').update(bytes).digest('hex') !== version.sha256) throw new CloudWorkspaceError('object_integrity_mismatch', 500);
    return { bytes, version };
  }
}
