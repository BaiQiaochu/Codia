import { CloudWorkspaceService } from '../../cloud-workspace/service.ts';
import { CloudWorkspaceError, type CloudActor } from '../../cloud-workspace/store.ts';
import type { ResourceRef, ResourceVersion, ResourceWriteExpectedVersionResult } from '../types.ts';
/** Request-scoped adapter; never attach a user's instance to global engine state. */
export class CloudWorkspaceProvider {
  readonly id = 'resource' as const;
  declare service: CloudWorkspaceService;
  declare actor: CloudActor;
  constructor(service: CloudWorkspaceService, actor: CloudActor) { this.service = service; this.actor = Object.freeze({ ...actor }); }
  capabilities() { return { stat: true, read: true, writeExpectedVersion: true, write: false, materialize: false }; }
  private file(ref: ResourceRef) {
    if (ref.kind !== 'resource' || !ref.resourceId.startsWith('cloud-file:')) throw new CloudWorkspaceError('invalid_cloud_resource');
    return this.service.store.file(this.actor, ref.resourceId.slice('cloud-file:'.length));
  }
  private descriptor(file: Record<string, any>) { return { kind: 'resource' as const, resourceId: `cloud-file:${file.id}`, provider: 'cloud_workspace', displayName: file.name }; }
  async stat(ref: ResourceRef) {
    const file = await this.file(ref); const version = await this.service.store.version(this.actor, file.current_version);
    return { resourceKey: `resource:cloud-file:${file.id}`, resource: this.descriptor(file), exists: true, isDirectory: false, version: { etag: version.id, size: version.size, sha256: version.sha256 } };
  }
  async read(ref: ResourceRef) {
    const file = await this.file(ref); const { bytes, version } = await this.service.read(this.actor, file.current_version);
    return { resourceKey: `resource:cloud-file:${file.id}`, resource: this.descriptor(file), content: bytes, version: { etag: version.id, size: version.size, sha256: version.sha256 } };
  }
  async writeExpectedVersion(ref: ResourceRef, content: string | Buffer, expected: ResourceVersion): Promise<ResourceWriteExpectedVersionResult> {
    const file = await this.file(ref);
    try {
      const result = await this.service.upload(this.actor, file.workspace_id, file.name, Buffer.isBuffer(content) ? content : Buffer.from(content), file.id, expected?.etag);
      return { changeType: 'modified', resourceKey: `resource:cloud-file:${file.id}`, resource: this.descriptor(file), version: { etag: result.version.id, size: result.version.size, sha256: result.version.sha256 } };
    } catch (err) {
      if (err instanceof CloudWorkspaceError && err.code === 'version_conflict') {
        const current = await this.stat(ref);
        return { ok: false, conflict: true, resourceKey: current.resourceKey, resource: current.resource, version: current.version };
      }
      throw err;
    }
  }
}
