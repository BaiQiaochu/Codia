// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), preview: vi.fn() }));
vi.mock('../hooks/use-codia-fetch', () => ({ codiaFetch: mocks.fetch, codiaUrl: (p: string) => p }));
vi.mock('../utils/remote-file-preview', () => ({ openFileRefPreview: mocks.preview }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({}) } }));
vi.mock('../services/server-connection', () => ({ resolveServerConnection: () => null }));
import { CompanyDeliveryPanel } from './CompanyDeliveryPanel';
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const ok = (data: unknown) => ({ ok: true, json: async () => data });
const delivery = { taskId: 't', version: 'v1', revision: 1, status: 'reported', report: 'actual report', dueAt: null, criteria: [{ criterion: 'accurate', selfReport: { passed: true, evidence: 'sf_a' } }], artifacts: [{ key: 'artifact-0', reference: 'sf_a', state: 'available', fileId: 'sf_a', name: 'Result', sessionPath: '/session', sha256: 'abc', resource: { resourceId: 'res_sf_a', studioId: 's', links: { self: '/api/resources/res_sf_a', content: '/api/resources/res_sf_a/content' } } }], review: { state: 'unreviewed' }, note: 'Manual review is separate' };
describe('team delivery UI', () => {
  it('keeps self-report separate, previews only resource-backed files, and does not submit before explicit review', async () => {
    mocks.fetch.mockResolvedValue(ok(delivery)); const open = vi.fn();
    render(<CompanyDeliveryPanel taskId="t" refreshToken={0} openSession={open} />);
    await screen.findByText('执行方自报：通过'); expect(screen.getByText('人工复核：尚未复核')).toBeTruthy();
    fireEvent.click(screen.getByText('预览成果')); expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ path: '', resource: delivery.artifacts[0].resource }), expect.anything());
    fireEvent.click(screen.getByText('成果原会话')); expect(open).toHaveBeenCalledWith('/session');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves review draft after refresh failure and version changes, blocking stale approval', async () => {
    mocks.fetch.mockResolvedValueOnce(ok(delivery)).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'offline' }) }).mockResolvedValueOnce(ok({ ...delivery, version: 'v2' }));
    const view = render(<CompanyDeliveryPanel taskId="t" refreshToken={0} openSession={() => {}} />); await screen.findByText('accurate');
    fireEvent.change(screen.getByLabelText('accurate 人工结论'), { target: { value: 'pass' } });
    fireEvent.change(screen.getByLabelText('accurate 复核依据'), { target: { value: 'my unsaved note' } });
    view.rerender(<CompanyDeliveryPanel taskId="t" refreshToken={1} openSession={() => {}} />); await screen.findByRole('alert');
    expect((screen.getByLabelText('accurate 复核依据') as HTMLTextAreaElement).value).toBe('my unsaved note');
    fireEvent.click(screen.getByText('刷新交付验收')); await screen.findByText(/草稿基于旧版本/);
    expect((screen.getByText('保存逐项人工复核') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('已核对新版本，保留草稿继续'));
    expect((screen.getByText('保存逐项人工复核') as HTMLButtonElement).disabled).toBe(false);
  });
  it('ignores an old task response after navigation and labels unavailable artifacts', async () => {
    let old: (v: unknown) => void = () => {};
    mocks.fetch.mockImplementationOnce(() => new Promise(r => { old = r; })).mockResolvedValueOnce(ok({ ...delivery, taskId: 'new', artifacts: [{ key: 'x', state: 'forbidden', reason: '无权读取' }] }));
    const view = render(<CompanyDeliveryPanel taskId="old" refreshToken={0} openSession={() => {}} />);
    view.rerender(<CompanyDeliveryPanel taskId="new" refreshToken={0} openSession={() => {}} />);
    await screen.findByText('无权读取'); old(ok(delivery));
    await waitFor(() => expect(screen.queryByText('预览成果')).toBeNull());
  });
});
