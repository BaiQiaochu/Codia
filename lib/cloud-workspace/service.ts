import crypto from 'node:crypto';
import { CloudWorkspaceError, CloudWorkspaceStore, type CloudActor } from './store.ts';
import { asAsyncWorkspaceRepository, type CloudWorkspaceRepository, type EnqueueCloudRun } from './repository.ts';
import type { CloudAgentExecutor } from './agent-executor.ts';
import type { ObjectStore } from './object-store.ts';
export const CLOUD_UPLOAD_LIMIT = 2 * 1024 * 1024;
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
  async read(actor: CloudActor, versionId: string) {
    const version = await this.store.version(actor, versionId);
    const bytes = await this.objects.get(version.object_key);
    if (bytes.length !== version.size || crypto.createHash('sha256').update(bytes).digest('hex') !== version.sha256) throw new CloudWorkspaceError('object_integrity_mismatch', 500);
    return { bytes, version };
  }
}
