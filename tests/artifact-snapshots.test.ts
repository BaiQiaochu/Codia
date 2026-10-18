import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactSnapshotStore, ARTIFACT_SNAPSHOT_LIMITS, compareArtifactSnapshots, readSnapshotSource, getArtifactSnapshotCapabilities } from '../lib/session-files/artifact-snapshots.ts';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(limits = ARTIFACT_SNAPSHOT_LIMITS, ext = 'txt') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-snapshots-')); dirs.push(home);
  const filePath = path.join(home, `source.${ext}`); fs.writeFileSync(filePath, 'first\n');
  const store = new ArtifactSnapshotStore(home, limits);
  let counter = 0;
  const register = vi.fn((_path: string, _name: string) => ({ id: `sf_copy_${++counter}` }));
  const source = { id: 'sf_source', realPath: filePath, displayName: 'Source', ext };
  const capture = () => store.capture({ sessionPath: '/session-a', source, contentPath: filePath, register });
  return { home, filePath, source, store, register, capture };
}
describe('immutable artifact snapshots', () => {
  it('retains actual bytes after source mutation, persists history and records hash lineage', () => {
    const x = setup();
    const first = x.capture().snapshot;
    fs.writeFileSync(x.filePath, 'second\n');
    const second = x.capture().snapshot;
    const restarted = new ArtifactSnapshotStore(x.home);
    expect(restarted.read('/session-a', first).toString()).toBe('first\n');
    expect(restarted.read('/session-a', second).toString()).toBe('second\n');
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatchObject({ parentId: first.id, sequence: 2, sourceFileId: 'sf_source' });
    expect(second.sha256).not.toBe(first.sha256);
    expect(restarted.list('/session-a')).toHaveLength(2);
    expect(restarted.list('/session-b')).toHaveLength(0);
    expect(() => restarted.read('/session-b', first)).toThrow('snapshot_not_found');
    expect(x.capture().created).toBe(false);
    expect(x.register).toHaveBeenCalledTimes(2);
  });
  it('supports JSON payloads without confusing them with metadata', () => {
    const x = setup(ARTIFACT_SNAPSHOT_LIMITS, 'json');
    fs.writeFileSync(x.filePath, '{"a":1}');
    const snapshot = x.capture().snapshot;
    expect(x.store.list('/session-a')).toEqual([snapshot]);
    expect(x.store.read('/session-a', snapshot).toString()).toBe('{"a":1}');
  });
  it('does not collide with internal metadata when a source has a pending extension', () => {
    const x = setup(ARTIFACT_SNAPSHOT_LIMITS, 'pending');
    const snapshot = x.capture().snapshot;
    expect(x.store.read('/session-a', snapshot).toString()).toBe('first\n');
  });
  it('keeps incomplete saves unlisted while accounting for their bytes and count', () => {
    const x = setup({ ...ARTIFACT_SNAPSHOT_LIMITS, maxSnapshotsPerSession: 2 });
    const first = x.capture().snapshot;
    fs.writeFileSync(x.filePath, 'second');
    x.register.mockImplementationOnce(() => { throw new Error('registration failed'); });
    expect(() => x.capture()).toThrow('registration failed');
    expect(x.store.list('/session-a')).toEqual([first]);
    expect(x.store.read('/session-a', first).toString()).toBe('first\n');
    expect(() => x.capture()).toThrow('snapshot_count_limit');
  });
  it('rejects source symlinks, redirected parents and hardlinks', () => {
    const x = setup();
    const other = path.join(x.home, 'private.txt'); fs.writeFileSync(other, 'private');
    fs.unlinkSync(x.filePath); fs.symlinkSync(other, x.filePath);
    expect(() => x.capture()).toThrow('snapshot_path_changed');
    fs.unlinkSync(x.filePath); fs.linkSync(other, x.filePath);
    expect(() => x.capture()).toThrow('snapshot_not_regular_file');
    expect(x.register).not.toHaveBeenCalled();
  });
  it('rejects a symlinked snapshot store without writing through it', () => {
    const x = setup();
    const outside = path.join(x.home, 'outside'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(x.home, 'artifact-snapshots'), 'dir');
    expect(() => x.capture()).toThrow('snapshot_store_unsafe');
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects a transient parent-directory swap before reading outside bytes', () => {
    const x = setup();
    const allowed = path.join(x.home, 'allowed');
    const parked = path.join(x.home, 'parked');
    const outside = path.join(x.home, 'outside');
    fs.mkdirSync(allowed); fs.mkdirSync(outside);
    const source = path.join(allowed, 'result.txt');
    fs.writeFileSync(source, 'allowed'); fs.writeFileSync(path.join(outside, 'result.txt'), 'outside-private');
    const realpath = fs.realpathSync.bind(fs), lstat = fs.lstatSync.bind(fs);
    let switched = false, sourceStats = 0;
    vi.spyOn(fs, 'realpathSync').mockImplementation(((file, ...args) => {
      const result = realpath(file, ...args);
      if (file === source && !switched) {
        fs.renameSync(allowed, parked); fs.symlinkSync(outside, allowed, 'dir'); switched = true;
      }
      return result;
    }) as typeof fs.realpathSync);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file, ...args) => {
      const result = lstat(file, ...args);
      // This interleaving made the old pathname-only checks accept outside bytes:
      // both lstat calls see outside, but the final realpath sees restored inside.
      if (file === source && ++sourceStats === 2) {
        fs.unlinkSync(allowed); fs.renameSync(parked, allowed);
      }
      return result;
    }) as typeof fs.lstatSync);
    const read = vi.spyOn(fs, 'readSync');
    expect(() => readSnapshotSource(source, source, 1024)).toThrow('snapshot_path_changed');
    expect(read).not.toHaveBeenCalled();
  });
  it('anchors snapshot creation to a verified directory descriptor', () => {
    const x = setup(); x.capture(); fs.writeFileSync(x.filePath, 'second');
    const outside = path.join(x.home, 'outside'); fs.mkdirSync(outside);
    const storeDir = path.dirname(x.register.mock.calls[0][0] as unknown as string);
    const parked = path.join(x.home, 'parked-store');
    const originalOpen = fs.openSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((file, flags, ...args) => {
      if (!swapped && file === storeDir && typeof flags === 'number' && (flags & fs.constants.O_DIRECTORY)) {
        fs.renameSync(storeDir, parked); fs.symlinkSync(outside, storeDir, 'dir'); swapped = true;
      }
      return originalOpen(file, flags, ...args);
    }) as typeof fs.openSync);
    expect(() => x.capture()).toThrow();
    expect(swapped).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it('fails closed when descriptor verification is unavailable or platform is unsupported', () => {
    const x = setup();
    vi.spyOn(fs, 'readlinkSync').mockImplementation(() => { throw new Error('procfs unavailable'); });
    expect(() => x.capture()).toThrow('snapshot_fd_verification_unavailable');
    vi.restoreAllMocks();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(() => x.capture()).toThrow('snapshot_platform_unsupported');
    expect(x.register).not.toHaveBeenCalled();
  });

  it('preserves allowlisted metadata on unsupported platforms without enabling payload reads', () => {
    const x = setup(); const snapshot = x.capture().snapshot;
    const dir = path.dirname(x.register.mock.calls[0][0] as unknown as string);
    const metadata = path.join(dir, `${snapshot.id}.json`);
    fs.chmodSync(metadata, 0o600);
    fs.writeFileSync(metadata, JSON.stringify({ ...snapshot, rawPrompt: 'private-source-text' }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(getArtifactSnapshotCapabilities()).toEqual({ platform: 'win32', snapshotAvailable: false, reason: 'snapshot_platform_unsupported' });
    expect(x.store.list('/session-a')).toEqual([snapshot]);
    expect(JSON.stringify(x.store.list('/session-a'))).not.toContain('private-source-text');
    expect(() => x.store.read('/session-a', snapshot)).toThrow('snapshot_platform_unsupported');
  });

  it('detects changed bytes instead of silently presenting tampered history', () => {
    const x = setup(); const snapshot = x.capture().snapshot;
    const payload = x.register.mock.calls[0][0] as unknown as string;
    fs.chmodSync(payload, 0o600); fs.writeFileSync(payload, 'altered\n');
    expect(() => x.store.read('/session-a', snapshot)).toThrow('snapshot_integrity_failed');
  });
  it('rejects oversize input before registration', () => {
    const x = setup({ ...ARTIFACT_SNAPSHOT_LIMITS, maxFileBytes: 3 });
    expect(() => x.capture()).toThrow('snapshot_file_too_large');
    expect(x.register).not.toHaveBeenCalled();
  });
  it('rejects new versions at retention limit and preserves every saved version and the source', () => {
    const x = setup({ ...ARTIFACT_SNAPSHOT_LIMITS, maxVersionsPerFile: 2 });
    const first = x.capture().snapshot;
    fs.writeFileSync(x.filePath, 'second'); const second = x.capture().snapshot;
    fs.writeFileSync(x.filePath, 'third');
    expect(() => x.capture()).toThrow('snapshot_version_limit');
    expect(x.store.read('/session-a', first).toString()).toBe('first\n');
    expect(x.store.read('/session-a', second).toString()).toBe('second');
    expect(fs.readFileSync(x.filePath, 'utf8')).toBe('third');
    expect(x.store.list('/session-a')).toHaveLength(2);
  });
  it('enforces per-session count and byte quotas independently', () => {
    const count = setup({ ...ARTIFACT_SNAPSHOT_LIMITS, maxSnapshotsPerSession: 1 });
    count.capture(); fs.writeFileSync(count.filePath, 'next');
    expect(() => count.capture()).toThrow('snapshot_count_limit');
    const bytes = setup({ ...ARTIFACT_SNAPSHOT_LIMITS, maxSessionBytes: 8 });
    bytes.capture(); fs.writeFileSync(bytes.filePath, 'next');
    expect(() => bytes.capture()).toThrow('snapshot_storage_limit');
  });
  it('returns bounded real line differences and honest binary/large text fallback', () => {
    const diff = compareArtifactSnapshots(Buffer.from('a\nold\nz\n'), Buffer.from('a\nnew\nz\n'));
    expect(diff).toMatchObject({ kind: 'text', identical: false, lines: expect.arrayContaining([{kind: 'equal', text: 'a'}, {kind: 'removed', text: 'old'}, {kind: 'added', text: 'new'}]) });
    expect(compareArtifactSnapshots(Buffer.from([0, 1]), Buffer.from([0, 2]))).toMatchObject({ kind: 'metadata', reason: 'binary_or_non_utf8', identical: false, sizeDelta: 0 });
    expect(compareArtifactSnapshots(Buffer.from('x'.repeat(65537)), Buffer.from('y'))).toMatchObject({ kind: 'metadata', reason: 'text_size_limit' });
    expect(compareArtifactSnapshots(Buffer.from('\n'.repeat(301)), Buffer.from('y'))).toMatchObject({ kind: 'metadata', reason: 'text_line_limit' });
    expect(compareArtifactSnapshots(Buffer.from('a'), Buffer.from('a\n'))).toMatchObject({ kind: 'text', identical: false, lines: [{ kind: 'equal', text: 'a' }, { kind: 'added', text: '' }] });
  });
});
