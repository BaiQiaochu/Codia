import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplateLaunchAdmissions } from '../server/routes/task-console-admissions.ts';
const dirs: string[] = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codia-admissions-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
describe('durable launch admissions', () => {
  it('supports Windows without directory fsync while retaining exclusive claims and saved results', () => {
    const directory = root(); const store = new TemplateLaunchAdmissions(directory, 'win32');
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
      if (file === store.directory) throw Object.assign(new Error('Windows directory open unsupported'), { code: 'EPERM' });
      return (original as any)(file, ...args);
    }) as any);
    const claim = store.claim('request', 'fingerprint'); expect(claim.owned).toBe(true);
    if (claim.owned) store.complete('request', claim.token, { status: 202, body: { runId: 'original' } });
    expect(new TemplateLaunchAdmissions(directory, 'win32').claim('request', 'fingerprint')).toMatchObject({ owned: false, result: { status: 202, body: { runId: 'original' } } });
  });
  it('does not suppress real I/O errors or permit reused IDs with changed inputs', () => {
    const store = new TemplateLaunchAdmissions(root());
    store.claim('same-id', 'first');
    expect(store.claim('same-id', 'changed')).toMatchObject({ owned: false, result: { status: 409, body: { error: 'request_id_payload_mismatch' } } });
    const original = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
      if (file === store.directory) throw Object.assign(new Error('Disk unavailable'), { code: 'EIO' });
      return (original as any)(file, ...args);
    }) as any);
    expect(() => store.claim('new-id', 'fingerprint')).toThrow('Disk unavailable');
  });
});
