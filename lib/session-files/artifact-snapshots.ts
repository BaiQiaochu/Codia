import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export type ArtifactSnapshotLimits = { maxFileBytes: number; maxVersionsPerFile: number; maxSnapshotsPerSession: number; maxSessionBytes: number; maxDiffBytes: number; maxDiffLines: number };
export const ARTIFACT_SNAPSHOT_LIMITS: Readonly<ArtifactSnapshotLimits> = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxVersionsPerFile: 10,
  maxSnapshotsPerSession: 50,
  maxSessionBytes: 50 * 1024 * 1024,
  maxDiffBytes: 64 * 1024,
  maxDiffLines: 300,
});
const ID = /^[a-f0-9]{32}$/;
const FILE_ID = /^sf_[A-Za-z0-9_-]+$/;
const SHA = /^[a-f0-9]{64}$/;
const EXT = /^[a-zA-Z0-9]{1,12}$/;
export type ArtifactSnapshot = {
  id: string; sourceFileId: string; snapshotFileId: string; parentId: string | null;
  sequence: number; sha256: string; size: number; createdAt: number; ext: string;
  sourceMtimeMs: number; displayName: string;
};
export class ArtifactSnapshotError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 409) { super(code); this.code = code; this.status = status; }
}
const fail = (code: string, status = 409): never => { throw new ArtifactSnapshotError(code, status); };
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Linux exposes an authoritative opened-descriptor pathname through procfs. Node's
 * portable APIs do not expose equivalent macOS F_GETPATH / Windows handle queries.
 * Fail closed there rather than mistake a pathname recheck for descriptor identity.
 */
function assertSnapshotPlatform() {
  if (process.platform !== 'linux') fail('snapshot_platform_unsupported', 503);
}
export function getArtifactSnapshotCapabilities() {
  const platform = process.platform;
  if (platform !== 'linux') return { platform, snapshotAvailable: false, reason: 'snapshot_platform_unsupported' };
  let fd: number | undefined;
  try {
    fd = fs.openSync('/dev/null', fs.constants.O_RDONLY);
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) !== '/dev/null') throw new Error();
    return { platform, snapshotAvailable: true, reason: null };
  } catch { return { platform, snapshotAvailable: false, reason: 'snapshot_fd_verification_unavailable' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function assertDescriptorPath(fd: number, expectedPath: string) {
  assertSnapshotPlatform();
  let actual: string;
  try { actual = fs.readlinkSync(`/proc/self/fd/${fd}`); }
  catch { fail('snapshot_fd_verification_unavailable', 503); }
  // readlink examines the kernel descriptor itself, without re-resolving a mutable
  // pathname. Deleted descriptors also fail because Linux adds " (deleted)".
  if (actual !== expectedPath) fail('snapshot_path_changed', 403);
}

/** Read only a previously registered canonical regular file, never a caller-supplied path.
 * Descriptor-path binding rejects ancestor swaps; bounded reads reject growing files.
 */
export function readSnapshotSource(filePath: string, expectedRealPath: string, maxBytes: number) {
  assertSnapshotPlatform();
  return readBoundedSnapshotFile(filePath, expectedRealPath, maxBytes, true);
}

function readBoundedSnapshotFile(filePath: string, expectedRealPath: string, maxBytes: number, bindDescriptor: boolean) {
  if (!path.isAbsolute(filePath) || path.resolve(filePath) !== expectedRealPath) fail('snapshot_path_changed', 403);
  let fd: number | undefined;
  try {
    if (fs.realpathSync(filePath) !== expectedRealPath) fail('snapshot_path_changed', 403);
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('snapshot_not_regular_file', 403);
    if (before.size > maxBytes) fail('snapshot_file_too_large', 413);
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile() || opened.nlink !== 1) fail('snapshot_source_changed');
    if (bindDescriptor) assertDescriptorPath(fd, expectedRealPath); // Before reading even one content byte.
    const bytes = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(filePath);
    if (length > maxBytes) fail('snapshot_file_too_large', 413);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev
      || after.nlink !== 1 || fs.realpathSync(filePath) !== expectedRealPath) fail('snapshot_source_changed');
    if (bindDescriptor) assertDescriptorPath(fd, expectedRealPath);
    return { bytes: bytes.subarray(0, length), mtimeMs: after.mtimeMs };
  } catch (error) {
    if (error instanceof ArtifactSnapshotError) throw error;
    fail('snapshot_file_unavailable', 409);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Immutable per-session records. Quotas refuse new saves; existing versions are never evicted. */
export class ArtifactSnapshotStore {
  private root: string;
  private limits: Readonly<ArtifactSnapshotLimits>;
  constructor(codiaHome: string, limits = ARTIFACT_SNAPSHOT_LIMITS) {
    this.limits = limits;
    if (!codiaHome || !path.isAbsolute(codiaHome)) fail('snapshot_store_unavailable', 503);
    try { this.root = path.join(fs.realpathSync(codiaHome), 'artifact-snapshots'); }
    catch { fail('snapshot_store_unavailable', 503); }
  }
  private directory(sessionPath: string, create = false) {
    const dir = path.join(this.root, hash(sessionPath));
    for (const part of [this.root, dir]) {
      if (create && !fs.existsSync(part)) fs.mkdirSync(part, { mode: 0o700 });
      if (!fs.existsSync(part)) {
        // existsSync follows symlinks, including broken links; do not silently accept one.
        try { fs.lstatSync(part); fail('snapshot_store_unsafe', 403); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return null;
      }
      if (!fs.lstatSync(part).isDirectory() || fs.realpathSync(part) !== part) fail('snapshot_store_unsafe', 403);
    }
    return dir;
  }
  list(sessionPath: string): ArtifactSnapshot[] {
    const dir = this.directory(sessionPath);
    if (!dir) return [];
    const names = fs.readdirSync(dir);
    if (names.length > this.limits.maxSnapshotsPerSession * 2) fail('snapshot_store_limit');
    const snapshots: ArtifactSnapshot[] = [];
    for (const name of names.filter(name => /^[a-f0-9]{32}\.json$/.test(name))) {
      if (!ID.test(name.slice(0, -5))) fail('snapshot_store_invalid');
      const metadataPath = path.join(dir, name);
      let record: ArtifactSnapshot;
      try { record = JSON.parse(readBoundedSnapshotFile(metadataPath, metadataPath, 4096, getArtifactSnapshotCapabilities().snapshotAvailable).bytes.toString('utf8')); }
      catch (error) { if (error instanceof ArtifactSnapshotError) throw error; fail('snapshot_store_invalid'); }
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.id !== 'string' || record.id !== name.slice(0, -5)
        || typeof record.sourceFileId !== 'string' || !FILE_ID.test(record.sourceFileId)
        || typeof record.snapshotFileId !== 'string' || !FILE_ID.test(record.snapshotFileId)
        || typeof record.sha256 !== 'string' || !SHA.test(record.sha256) || (record.parentId !== null && (typeof record.parentId !== 'string' || !ID.test(record.parentId)))
        || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > this.limits.maxFileBytes
        || !Number.isSafeInteger(record.sequence) || record.sequence < 1 || record.sequence > this.limits.maxVersionsPerFile
        || !Number.isFinite(record.createdAt) || record.createdAt < 0 || record.createdAt > 8_640_000_000_000_000
        || !Number.isFinite(record.sourceMtimeMs) || record.sourceMtimeMs < 0 || record.sourceMtimeMs > 8_640_000_000_000_000
        || typeof record.ext !== 'string' || !EXT.test(record.ext) || typeof record.displayName !== 'string' || record.displayName.length > 512) fail('snapshot_store_invalid');
      // Metadata is an untrusted, bounded historical index, not proof that payload
      // bytes have been verified. Keep it readable on unsupported platforms, but
      // never expose arbitrary JSON properties or use this path for content reads.
      snapshots.push({ id: record.id, sourceFileId: record.sourceFileId, snapshotFileId: record.snapshotFileId,
        parentId: record.parentId, sequence: record.sequence, sha256: record.sha256, size: record.size,
        createdAt: record.createdAt, ext: record.ext, sourceMtimeMs: record.sourceMtimeMs, displayName: record.displayName });
    }
    return snapshots.sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence);
  }
  private payloadPath(sessionPath: string, snapshot: ArtifactSnapshot) {
    const dir = this.directory(sessionPath);
    if (!dir || !ID.test(snapshot.id) || !EXT.test(snapshot.ext)) fail('snapshot_not_found', 404);
    return path.join(dir, `${snapshot.id}.payload.${snapshot.ext}`);
  }
  read(sessionPath: string, snapshot: ArtifactSnapshot) {
    const payload = this.payloadPath(sessionPath, snapshot);
    const { bytes } = readSnapshotSource(payload, payload, this.limits.maxFileBytes);
    if (bytes.length !== snapshot.size || hash(bytes) !== snapshot.sha256) fail('snapshot_integrity_failed');
    return bytes;
  }
  capture({ sessionPath, source, contentPath, register }: {
    sessionPath: string; source: { id: string; realPath: string; displayName?: string; filename?: string; ext?: string };
    contentPath: string; register: (filePath: string, displayName: string) => { id: string };
  }) {
    if (!FILE_ID.test(source.id) || !source.realPath) fail('snapshot_unregistered_file', 404);
    const { bytes, mtimeMs } = readSnapshotSource(contentPath, source.realPath, this.limits.maxFileBytes);
    const sha256 = hash(bytes);
    const all = this.list(sessionPath);
    const history = all.filter(s => s.sourceFileId === source.id).sort((a, b) => a.sequence - b.sequence);
    const latest = history.at(-1);
    if (latest?.sha256 === sha256) { this.read(sessionPath, latest); return { snapshot: latest, created: false }; }
    if (history.length >= this.limits.maxVersionsPerFile) fail('snapshot_version_limit');
    const dir = this.directory(sessionPath, true)!;
    // Include orphaned payloads from interrupted captures in quota accounting.
    const payloadNames = fs.readdirSync(dir).filter(name => !/^[a-f0-9]{32}\.json$/.test(name));
    let totalBytes = 0;
    for (const name of payloadNames) {
      const candidate = path.join(dir, name);
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('snapshot_store_unsafe', 403);
      totalBytes += stat.size;
    }
    if (Math.max(payloadNames.length, all.length) >= this.limits.maxSnapshotsPerSession) fail('snapshot_count_limit');
    if (totalBytes + bytes.length > this.limits.maxSessionBytes) fail('snapshot_storage_limit');
    const id = randomBytes(16).toString('hex');
    const ext = EXT.test(source.ext || '') ? source.ext! : 'bin';
    const partial = { id, ext } as ArtifactSnapshot;
    const payload = this.payloadPath(sessionPath, partial);
    const displayName = (source.displayName || source.filename || source.id).slice(0, 512);
    // Exclusively create the bytes before registering them. Registration uses a non-managed
    // storage kind so provenance watermarking and cold-cache eviction cannot alter the copy.
    writeExclusive(payload, bytes, 0o444);
    const registered = register(payload, displayName);
    if (!FILE_ID.test(registered?.id)) fail('snapshot_registration_failed', 503);
    const snapshot: ArtifactSnapshot = {
      id, sourceFileId: source.id, snapshotFileId: registered.id, parentId: latest?.id || null,
      sequence: (latest?.sequence || 0) + 1, sha256, size: bytes.length, createdAt: Date.now(),
      sourceMtimeMs: mtimeMs, displayName, ext,
    };
    this.read(sessionPath, snapshot);
    const pending = path.join(dir, `${id}.pending`);
    writeExclusive(pending, Buffer.from(JSON.stringify(snapshot)), 0o444);
    // Commit the record atomically; a crash while writing it leaves an ignored,
    // quota-counted pending file instead of poisoning all existing history.
    fs.renameSync(pending, path.join(dir, `${id}.json`));
    return { snapshot, created: true };
  }
}

function writeExclusive(filePath: string, bytes: Buffer, mode: number) {
  assertSnapshotPlatform();
  const parent = path.dirname(filePath);
  let parentFd: number | undefined;
  let fd: number | undefined;
  try {
    parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    assertDescriptorPath(parentFd, parent);
    // Anchor creation to the verified directory handle, not a pathname whose
    // ancestors can be swapped for symlinks between validation and open.
    fd = fs.openSync(`/proc/self/fd/${parentFd}/${path.basename(filePath)}`,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    assertDescriptorPath(fd, filePath);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    assertDescriptorPath(fd, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (parentFd !== undefined) fs.closeSync(parentFd);
  }
}

/** Bounded LCS line diff. No rich-document or semantic comparison is implied. */
export function compareArtifactSnapshots(before: Buffer, after: Buffer) {
  const common = { identical: before.equals(after), sizeDelta: after.length - before.length };
  if (before.length > ARTIFACT_SNAPSHOT_LIMITS.maxDiffBytes || after.length > ARTIFACT_SNAPSHOT_LIMITS.maxDiffBytes) {
    return { ...common, kind: 'metadata' as const, reason: 'text_size_limit' };
  }
  const decode = (bytes: Buffer) => {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      return Array.from(text).some(char => { const code = char.charCodeAt(0); return code < 32 && code !== 9 && code !== 10 && code !== 13; }) ? null : text;
    } catch { return null; }
  };
  const left = decode(before), right = decode(after);
  if (left === null || right === null) return { ...common, kind: 'metadata' as const, reason: 'binary_or_non_utf8' };
  // Preserve CR and the terminal empty line so newline-only differences remain observable.
  const a = left.split('\n'), b = right.split('\n');
  if (Math.max(a.length, b.length) > ARTIFACT_SNAPSHOT_LIMITS.maxDiffLines) {
    return { ...common, kind: 'metadata' as const, reason: 'text_line_limit' };
  }
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    matrix[i][j] = a[i] === b[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  }
  const lines: { kind: 'equal' | 'removed' | 'added'; text: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ kind: 'equal', text: a[i++] }); j++; }
    else if (i < a.length && (j === b.length || matrix[i + 1][j] >= matrix[i][j + 1])) lines.push({ kind: 'removed', text: a[i++] });
    else lines.push({ kind: 'added', text: b[j++] });
  }
  return { ...common, kind: 'text' as const, lines };
}
