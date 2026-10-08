import { createHash } from 'node:crypto';
import { CloudWorkspaceError, validName, type CloudRow } from './store.ts';

export const CLOUD_RESUMABLE_UPLOAD_LIMIT = 32 * 1024 * 1024;
export const CLOUD_UPLOAD_CHUNK_SIZE = 1024 * 1024;
export const CLOUD_UPLOAD_TTL = 24 * 60 * 60 * 1000;
export const CLOUD_UPLOAD_ACTIVE_LIMIT = 8;
export const CLOUD_UPLOAD_ACTIVE_BYTES = 128 * 1024 * 1024;
// Cancellation cannot reclaim this rolling reservation: immutable chunks remain.
export const CLOUD_UPLOAD_RETAINED_LIMIT = 32;
export const CLOUD_UPLOAD_RETAINED_BYTES = 512 * 1024 * 1024;
export type CreateCloudUpload = { name: string; size: number; sha256: string; requestKey: string; fileId?: string; expectedVersion?: string };
export type CloudUploadChunk = { index: number; size: number; sha256: string };
export type CloudUploadState = { session: CloudRow; chunks: CloudUploadChunk[]; version: CloudRow };
export const uploadHash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export function normalizeUpload(input: CreateCloudUpload) {
  if (!input || typeof input !== 'object') throw new CloudWorkspaceError('invalid_upload');
  const name = validName(input.name);
  if (!Number.isSafeInteger(input.size) || input.size < 0) throw new CloudWorkspaceError('invalid_upload_size');
  if (input.size > CLOUD_RESUMABLE_UPLOAD_LIMIT) throw new CloudWorkspaceError('file_too_large', 413);
  if (!/^[a-f0-9]{64}$/.test(input.sha256 || '')) throw new CloudWorkspaceError('invalid_upload_hash');
  uploadRequestKey(input.requestKey);
  if ((input.fileId !== undefined || input.expectedVersion !== undefined) &&
      (typeof input.fileId !== 'string' || !input.fileId || typeof input.expectedVersion !== 'string' || !input.expectedVersion)) throw new CloudWorkspaceError('expected_version_required');
  return { name, size: input.size, sha256: input.sha256, fileId: input.fileId ?? null, expectedVersion: input.expectedVersion ?? null };
}
export function uploadRequestKey(key: unknown) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new CloudWorkspaceError('invalid_request_key');
}
export function sameUpload(spec: unknown, expected: unknown) { const value = typeof spec === 'string' ? JSON.parse(spec) : spec; return !!value && Object.entries(expected as Record<string, unknown>).every(([key,item]) => (value as Record<string, unknown>)[key] === item); }
export function uploadChunkSize(session: CloudRow, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(Number(session.size) / CLOUD_UPLOAD_CHUNK_SIZE)) throw new CloudWorkspaceError('invalid_chunk_index');
  return Math.min(CLOUD_UPLOAD_CHUNK_SIZE, Number(session.size) - index * CLOUD_UPLOAD_CHUNK_SIZE);
}
export function validateUploadChunk(session: CloudRow, chunk: CloudUploadChunk) {
  if (chunk.size !== uploadChunkSize(session, chunk.index)) throw new CloudWorkspaceError('invalid_chunk_size');
  if (!/^[a-f0-9]{64}$/.test(chunk.sha256 || '')) throw new CloudWorkspaceError('invalid_chunk_hash');
}
export function uploadManifest(session: CloudRow, chunks: CloudUploadChunk[]) {
  if (chunks.length !== Math.ceil(Number(session.size) / CLOUD_UPLOAD_CHUNK_SIZE)) throw new CloudWorkspaceError('upload_incomplete', 409);
  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  ordered.forEach((chunk, index) => { if (chunk.index !== index) throw new CloudWorkspaceError('upload_incomplete', 409); validateUploadChunk(session, chunk); });
  return uploadHash(JSON.stringify({ size: Number(session.size), sha256: session.sha256, chunks: ordered.map(({index,size,sha256}) => ({index,size,sha256})) }));
}
export function publicUpload({ session: row, chunks }: CloudUploadState) {
  return { id: row.id, workspace_id: row.workspace_id, name: row.name, size: Number(row.size), sha256: row.sha256, state: row.state,
    chunk_size: CLOUD_UPLOAD_CHUNK_SIZE, received_chunks: chunks.map(c => c.index).sort((a,b) => a-b), received_bytes: chunks.reduce((sum,c) => sum+c.size,0),
    expires_at: new Date(Number(row.expires_at)).toISOString(), revision: Number(row.revision), file_id: row.file_id, expected_version: row.expected_version,
    version_id: row.version_id, manifest_sha256: row.manifest_sha256 ?? null };
}
export function activeUpload(row: CloudRow) { return row.state === 'uploading' || row.state === 'completing'; }
export function assertUploadActive(row: CloudRow) {
  if (row.state === 'expired') throw new CloudWorkspaceError('upload_expired', 410);
  if (!activeUpload(row)) throw new CloudWorkspaceError('upload_not_pending', 409);
}
export function uploadChunkKey(session: CloudRow, index: number) { return `workspaces/${session.workspace_id}/uploads/${session.id}/chunks/${index}`; }
