import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicLocalWrite } from '../lib/resource-io/atomic-file-write.ts';
import { LocalFsProvider } from '../lib/resource-io/providers/local-fs-provider.ts';
import { withFileMutation } from '../lib/resource-io/tool-edit-context.ts';
import { saveToolOutput } from '../lib/tools/full-output.ts';
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-write-reliability-')); roots.push(root);
  return { root, file: path.join(root, '中文 空格 #.txt') };
}
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
describe('local file reliability', () => {
  it('preserves the old file and removes its temporary file when replacement fails', () => {
    const { root, file } = fixture(); fs.writeFileSync(file, 'original');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('sharing violation'); });
    expect(() => atomicLocalWrite(file, 'new')).toThrow('sharing violation');
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
    expect(fs.readdirSync(root)).toEqual([path.basename(file)]);
  });
  it('refuses conflicting content even when size and timestamp are unchanged', async () => {
    const { root, file } = fixture(); fs.writeFileSync(file, 'before');
    const provider = new LocalFsProvider({ cwd: root, guard: { check: () => ({ allowed: true }) } });
    const ref = { kind: 'local-file', path: file };
    const read = await provider.read(ref);
    const stat = fs.statSync(file); fs.writeFileSync(file, 'edited'); fs.utimesSync(file, stat.atime, stat.mtime);
    const result = await provider.writeExpectedVersion(ref, 'should not replace', read.version!);
    expect(result).toMatchObject({ conflict: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('edited');
  });
  it('serializes writes to one path and supports nested checkpoint locks', async () => {
    const { file } = fixture(); const trace: string[] = [];
    await Promise.all([
      withFileMutation(file, async () => { trace.push('first'); await new Promise(r => setTimeout(r, 10)); await withFileMutation(file, async () => { trace.push('nested'); }); }),
      withFileMutation(file, async () => { trace.push('second'); }),
    ]);
    expect(trace).toEqual(['first', 'nested', 'second']);
  });
  it('rechecks the target immediately before replacing the file', () => {
    const { file } = fixture(); fs.writeFileSync(file, 'original');
    expect(() => atomicLocalWrite(file, 'new', () => { throw new Error('conflict'); })).toThrow('conflict');
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });
  it('keeps a bounded full-result reference with explicit truncation', () => {
    const { root } = fixture();
    const result = saveToolOutput('x'.repeat(3 * 1024 * 1024), path.join(root, 'session.jsonl'));
    expect(result.fullOutputTruncated).toBe(true);
    expect(fs.statSync(result.fullOutputPath).size).toBe(2 * 1024 * 1024);
  });
});
