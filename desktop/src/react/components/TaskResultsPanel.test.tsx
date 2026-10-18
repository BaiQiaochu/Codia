// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), preview: vi.fn() }));
vi.mock('../hooks/use-codia-fetch', () => ({ codiaFetch: mocks.fetch, codiaUrl: (s: string) => s }));
vi.mock('../utils/remote-file-preview', () => ({ openFileRefPreview: mocks.preview }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({}) } }));
vi.mock('../services/server-connection', () => ({ resolveServerConnection: () => null }));
import { TaskResultsPanel } from './TaskResultsPanel';
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const resource = (id: string) => ({ resourceId: id, studioId: 's', links: { self: `/api/resources/${id}`, content: `/api/resources/${id}/content` } });
const snapshot = (sequence: number) => ({ id: `snap${sequence}`, sourceFileId: 'sf_a', parentId: sequence === 1 ? null : 'snap1', sequence, sha256: `${sequence}`.repeat(64), size: 10 * sequence, createdAt: 1000 * sequence, file: { id: `sf_snapshot${sequence}`, filePath: `/history/${sequence}.md`, displayName: 'Brief', ext: 'md', resource: resource(`snapshot${sequence}`) } });
const file = { id: 'sf_a', filePath: '/project/a.md', displayName: 'Brief', ext: 'md', origin: 'tool', size: 10, resource: resource('a'), snapshots: [] as ReturnType<typeof snapshot>[] };
const ok = (data: Record<string, unknown>) => ({ ok: true, json: async () => ({ capabilities: { snapshotAvailable: true, platform: 'linux' }, ...data }) });
describe('registered task artifact history', () => {
  it('reuses resource-backed previews and export, and only captures after an explicit click', async () => {
    mocks.fetch.mockResolvedValueOnce(ok({ files: [file] })).mockResolvedValueOnce(ok({ created: true, snapshot: snapshot(1) }));
    render(<TaskResultsPanel sessionPath="session" />);
    await screen.findByText('Brief');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByText('尚未保存历史快照。')).toBeTruthy();
    fireEvent.click(screen.getByText('预览'));
    expect(mocks.preview).toHaveBeenCalledWith(expect.objectContaining({ id: 'sf_a', path: '', resource: resource('a') }), { origin: 'session', sessionPath: 'session' });
    expect(screen.getByText('导出文件').getAttribute('href')).toContain('/api/resources/a/content');
    fireEvent.click(screen.getByRole('button', { name: '保存 Brief 的内容快照' }));
    expect(await screen.findByText('已保存独立内容快照。之后修改原文件不会改变此版本。')).toBeTruthy();
    expect(mocks.fetch).toHaveBeenLastCalledWith('/api/task-artifacts/sf_a/snapshots?sessionPath=session', { method: 'POST' });
    expect(screen.getByText('导出版本 1').getAttribute('href')).toContain('/api/resources/snapshot1/content');
    fireEvent.click(screen.getByLabelText('预览 Brief 版本 1'));
    expect(mocks.preview).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'sf_snapshot1', path: '', resource: resource('snapshot1') }), { origin: 'session', sessionPath: 'session' });
  });
  it('shows actual stored line changes rather than comparing live file metadata', async () => {
    mocks.fetch.mockResolvedValueOnce(ok({ files: [{ ...file, snapshots: [snapshot(1), snapshot(2)] }] })).mockResolvedValueOnce(ok({ kind: 'text', identical: false, sizeDelta: 10, lines: [{ kind: 'removed', text: '<script>old</script>' }, { kind: 'added', text: 'new result' }] }));
    render(<TaskResultsPanel sessionPath="session" />);
    await screen.findByText('Brief');
    const button = screen.getByText('比较历史内容') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Brief 旧版本'), { target: { value: 'snap1' } });
    fireEvent.change(screen.getByLabelText('Brief 新版本'), { target: { value: 'snap2' } });
    fireEvent.click(button);
    expect(await screen.findByText('保存的内容不同')).toBeTruthy();
    expect(screen.getByText('-<script>old</script>')).toBeTruthy();
    expect(screen.getByText('+new result')).toBeTruthy();
    expect(screen.getByText('大小差：10 bytes')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(mocks.fetch).toHaveBeenLastCalledWith('/api/task-artifacts/sf_a/compare?sessionPath=session&before=snap1&after=snap2');
  });
  it('labels binary comparison honestly and preserves history when the source expires', async () => {
    mocks.fetch.mockResolvedValueOnce(ok({ files: [{ ...file, status: 'expired', snapshots: [snapshot(1), snapshot(2)] }] })).mockResolvedValueOnce(ok({ kind: 'metadata', reason: 'binary_or_non_utf8', identical: false, sizeDelta: 0 }));
    render(<TaskResultsPanel sessionPath="session" />);
    await screen.findByText('Brief');
    expect(screen.queryByText('保存内容快照')).toBeNull();
    expect(screen.queryByText('导出文件')).toBeNull();
    expect(screen.getByText('导出版本 1')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Brief 旧版本'), { target: { value: 'snap1' } });
    fireEvent.change(screen.getByLabelText('Brief 新版本'), { target: { value: 'snap2' } });
    fireEvent.click(screen.getByText('比较历史内容'));
    expect(await screen.findByText(/二进制或非 UTF-8 文件/)).toBeTruthy();
    expect(screen.queryByLabelText('文本差异')).toBeNull();
  });
  it('reports retention refusal without removing existing versions or claiming success', async () => {
    mocks.fetch.mockResolvedValueOnce(ok({ files: [{ ...file, snapshots: [snapshot(1)] }] })).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'snapshot_version_limit' }) });
    render(<TaskResultsPanel sessionPath="session" />); await screen.findByText('Brief');
    fireEvent.click(screen.getByText('保存内容快照'));
    expect((await screen.findByRole('alert')).textContent).toContain('现有版本已保留');
    expect(screen.getByText('导出版本 1')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('ignores a previous session response after navigation', async () => {
    let resolveOld: (value: unknown) => void = () => {};
    mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce(ok({ files: [] }));
    const view = render(<TaskResultsPanel sessionPath="old" />);
    view.rerender(<TaskResultsPanel sessionPath="new" />);
    await screen.findByText('尚无已登记文件。');
    resolveOld(ok({ files: [file] }));
    await waitFor(() => expect(screen.queryByText('Brief')).toBeNull());
  });
  it('shows read failure instead of claiming an empty successful result', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'session_forbidden' }) });
    render(<TaskResultsPanel sessionPath="session" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('尚无已登记文件。')).toBeNull();
  });
});

 it('disables unsupported Windows snapshot bytes while preserving metadata and original preview', async () => {
  mocks.fetch.mockResolvedValueOnce(ok({ capabilities: { snapshotAvailable: false, platform: 'win32' }, files: [{ ...file, snapshots: [snapshot(1), snapshot(2)] }] }));
  render(<TaskResultsPanel sessionPath="session" />);
  await screen.findByText('Brief');
  expect(screen.getByRole('note').textContent).toContain('win32');
  expect((screen.getByText('内容快照不可用') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByText('比较历史内容') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText('导出版本 1')).toBeNull();
  expect(screen.getByText('导出文件')).toBeTruthy();
  expect(screen.getByText(/SHA-256：1/)).toBeTruthy();
  fireEvent.click(screen.getByText('预览'));
  expect(mocks.preview).toHaveBeenCalledOnce();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
