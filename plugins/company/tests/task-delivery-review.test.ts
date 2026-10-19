import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompanyStore } from '../lib/company-store';
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); dirs.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
function setup() { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-review-')); dirs.push(p); return Object.assign(new CompanyStore(p), { dataDir: p }); }
describe('company delivery boundaries', () => {
  it('records observed lifecycle transitions once and never mistakes report edits for finish time', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T10:00:00Z'));
    const store = setup(); await store.addTasks([{ id: 't', status: 'assigned', report: '', artifacts: [] }]);
    expect((await store.listTasks(undefined))[0].startedAt).toBeUndefined();
    const started = await store.updateTask('t', { status: 'in_progress' });
    expect(started.startedAt).toBe('2026-10-19T10:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-19T11:00:00Z'));
    const reported = await store.updateTask('t', { status: 'reported', report: 'done' });
    expect(reported.finishedAt ?? null).toBeNull();
    const finished = await store.updateTask('t', { status: 'completed' });
    expect(finished.finishedAt).toBe('2026-10-19T11:00:00.000Z');
    vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
    const edited = await store.updateTask('t', { report: 'corrected', startedAt: 'forged', finishedAt: 'forged' });
    expect(edited.startedAt).toBe(started.startedAt); expect(edited.finishedAt).toBe(finished.finishedAt);
    expect(edited.deliveryRevision).toBeGreaterThan(finished.deliveryRevision);
  });
  it('leaves legacy terminal dates unknown when a report changes', async () => {
    const store = setup(); await store.addTasks([{ id: 'legacy', status: 'failed', createdAt: 'old', updatedAt: 'recent' }]);
    const edited = await store.updateTask('legacy', { report: 'edit' });
    expect(edited.startedAt ?? null).toBeNull(); expect(edited.finishedAt ?? null).toBeNull();
  });
});
it('binds reporting to the trusted runtime session rather than a caller-supplied session path', async () => {
  const { createCompanyService } = await import('../lib/company-service');
  const { execute } = await import('../tools/report');
  const store = setup(); const ctx: any = { dataDir: store.dataDir, sessionPath: '/trusted/session', _company: {} };
  const service = createCompanyService(ctx); ctx._company.service = service;
  await service.store.addTasks([{ id: 't', companyId: 'company_default', status: 'assigned', acceptanceCriteria: [] }]);
  const result = await execute({ taskId: 't', status: 'reported', report: 'result', sessionPath: '/forged' }, ctx);
  expect(result.details.task.sessionPath).toBe('/trusted/session');
});
