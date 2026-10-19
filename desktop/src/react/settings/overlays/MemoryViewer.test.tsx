// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), open: vi.fn(), agentId: 'alpha' }));
vi.mock('../store', () => ({ useSettingsStore: { getState: () => ({ getSettingsAgentId: () => mocks.agentId }) } }));
vi.mock('../api', async (importOriginal) => ({ ...(await importOriginal<typeof import('../api')>()), codiaFetch: mocks.fetch }));
vi.mock('../helpers', () => ({ t: (value: string) => value }));
import { CodiaFetchError } from '../api';
vi.mock('./MemoryBudgetSettings', () => ({ MemoryBudgetSettings: () => <div>后台处理预算</div> }));
import { MemoryViewer } from './MemoryViewer';
const memory = { id: 1, fact: 'Original evidence', revision: 1, updated_at: '2026-10-01T00:00:00Z', source: 'session:s1', status: 'active', scope: 'project', projectId: 'repo-alpha', sourceRefs: [{ kind: 'message', sessionId: 's1', messageId: 'm1', author: 'user' }] };
const experience = { id: 'exp-1', revision: 1, state: 'candidate', category: 'Build', content: 'Verify lockfile before retry', taskType: 'build', goal: 'Build locally', preconditions: ['Linux'], actions: ['Check lockfile'], verificationMethod: 'unit tests', risks: [], rollback: '', sourceRefs: [{ type: 'run', id: 'seed-run' }], parentMemoryIds: [], applicability: { scope: 'project', projectId: 'repo-alpha', platform: 'linux', appVersion: '1.0' }, lastVerifiedAt: null, evidence: [], stats: { retrieved: 8, injected: 2, attempted: 1, verifiedSuccess: 0, verifiedFailure: 0, unknown: 1 } };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const initial = (url: string) => response(url.includes('/experiences') ? { entries: [], enabled: true } : url.includes('/extractions') ? { jobs: [] } : { memories: [memory], projects: [{ id: 'repo-alpha', label: 'Alpha' }, { id: 'repo-beta', label: 'Beta' }] });
const openViewer = () => { render(<MemoryViewer />); act(() => { window.dispatchEvent(new Event('codia-view-memories')); }); };
const ready = async () => { await screen.findByText('Original evidence'); await waitFor(() => expect(screen.queryByText('正在加载来源与记录…')).toBeNull()); };
beforeEach(() => { mocks.agentId = 'alpha'; mocks.fetch.mockImplementation(async (url: string) => initial(url)); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('source-visible memory governance UI', () => {
  it('opens a verified same-agent source and exposes message-level provenance', async () => {
    Object.assign(window, { codia: { quickChatOpenSession: mocks.open } });
    mocks.fetch.mockImplementation(async (url: string) => url === '/api/sessions' ? response([{ sessionId: 's1', path: '/alpha/source.jsonl', agentId: 'alpha' }]) : initial(url));
    openViewer(); await ready();
    expect(screen.getByText(/消息 m1/)).toBeTruthy();
    fireEvent.click(screen.getByText('打开来源会话'));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('/alpha/source.jsonl'));
  });
  it('sends correction with revision and requires explicit forget confirmation', async () => {
    mocks.fetch.mockImplementation(async (url: string, options?: { method: string }) => options?.method === 'PATCH' ? response({ memory: { ...memory, fact: 'Corrected evidence', revision: 2 } }) : options?.method === 'DELETE' ? response({ ok: true }) : initial(url));
    openViewer(); await ready();
    fireEvent.click(screen.getByText('纠错'));
    fireEvent.change(screen.getByLabelText('纠正事实'), { target: { value: 'Corrected evidence' } });
    fireEvent.click(screen.getByText('保存纠错'));
    await screen.findByText('Corrected evidence');
    await waitFor(() => expect(screen.queryByText('取消纠错')).toBeNull());
    expect(JSON.parse(mocks.fetch.mock.calls.find(([, opts]) => opts?.method === 'PATCH')![1].body)).toEqual({ fact: 'Corrected evidence', status: 'active', expectedRevision: 1 });
    fireEvent.click(screen.getByText('忘记'));
    fireEvent.click(screen.getByText('取消忘记'));
    expect(mocks.fetch.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByText('忘记'));
    fireEvent.click(screen.getByText('确认忘记'));
    await waitFor(() => expect(screen.queryByText('Corrected evidence')).toBeNull());
    const deleteOptions = mocks.fetch.mock.calls.find(([, opts]) => opts?.method === 'DELETE')![1];
    expect(JSON.parse(deleteOptions.body)).toEqual({ expectedRevision: 2 });
  });
  it('handles real HTTP error throws, loads concurrent edit, and preserves draft', async () => {
    mocks.fetch.mockImplementation(async (url: string, options?: { method: string }) => {
      if (options?.method === 'PATCH') throw new CodiaFetchError('conflict', 409, { error: 'conflict', current: { ...memory, fact: 'Concurrent edit', revision: 2 } });
      return initial(url);
    });
    openViewer(); await ready();
    fireEvent.click(screen.getByText('纠错'));
    fireEvent.change(screen.getByLabelText('纠正事实'), { target: { value: 'My correction' } });
    fireEvent.click(screen.getByText('保存纠错'));
    expect((await screen.findByRole('alert')).textContent).toContain('已被更新');
    expect((screen.getByLabelText('纠正事实') as HTMLTextAreaElement).value).toBe('My correction');
    expect(screen.getByText('Concurrent edit')).toBeTruthy();
  });
  it('never navigates to another agent with a matching source session ID', async () => {
    Object.assign(window, { codia: { quickChatOpenSession: mocks.open } });
    mocks.fetch.mockImplementation(async (url: string) => url === '/api/sessions' ? response([{ sessionId: 's1', path: '/beta/private', agentId: 'beta' }]) : initial(url));
    openViewer(); await ready(); fireEvent.click(screen.getByText('打开来源会话'));
    expect((await screen.findByRole('alert')).textContent).toContain('不可用');
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('keeps failed sections explicit and refreshes them without hiding loaded facts', async () => {
    mocks.fetch.mockImplementation(async (url: string) => { if (url.includes('/experiences')) throw new Error('offline'); return initial(url); });
    openViewer(); await ready();
    fireEvent.click(screen.getByRole('tab', { name: /^经验/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('offline');
    expect(screen.queryByText('还没有经验。完成任务后形成的候选会显示在这里。')).toBeNull();
    mocks.fetch.mockImplementation(async (url: string) => initial(url));
    fireEvent.click(screen.getByText('刷新'));
    await screen.findByText('还没有经验。完成任务后形成的候选会显示在这里。');
  });
  it('discards stale responses after close and reopening for another agent', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.fetch.mockImplementation((url: string) => url.startsWith('/api/memories?agentId=alpha') ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(url.startsWith('/api/memories?agentId=beta') ? response({ memories: [{ ...memory, fact: 'Beta current' }] }) : initial(url)));
    openViewer(); fireEvent.click(screen.getByLabelText('关闭记忆'));
    mocks.agentId = 'beta'; act(() => { window.dispatchEvent(new Event('codia-view-memories')); });
    await screen.findByText('Beta current');
    await act(async () => { resolveOld(response({ memories: [memory] })); });
    expect(screen.queryByText('Original evidence')).toBeNull();
  });
  it('prevents repeated mutations and does not discard pending save by closing', async () => {
    let resolveWrite!: (value: unknown) => void;
    mocks.fetch.mockImplementation((url: string, options?: { method: string }) => options?.method === 'PATCH' ? new Promise(resolve => { resolveWrite = resolve; }) : Promise.resolve(initial(url)));
    openViewer(); await ready(); fireEvent.click(screen.getByText('纠错'));
    fireEvent.click(screen.getByText('保存纠错')); fireEvent.click(screen.getByText('保存纠错'));
    fireEvent.click(screen.getByLabelText('关闭记忆'));
    expect(mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => { resolveWrite(response({ memory: { ...memory, revision: 2 } })); });
    await waitFor(() => expect(screen.queryByText('取消纠错')).toBeNull());
  });
  it('cancels an edit without writing and explains retained source chat and backups', async () => {
    openViewer(); await ready(); fireEvent.click(screen.getByText('纠错')); fireEvent.click(screen.getByText('取消纠错'));
    expect(mocks.fetch.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
    expect(screen.getByText(/备份不会立即物理删除/)).toBeTruthy();
  });
  it('shows separate experience counters and explicit enable/cancel steps', async () => {
    mocks.fetch.mockImplementation(async (url: string, options?: { method: string; body: string }) => options?.method === 'PATCH' ? response({ entry: { ...experience, state: JSON.parse(options.body).state, revision: 3 } }) : url.includes('/experiences') ? response({ entries: [{ ...experience, state: 'validated', revision: 2 }] }) : initial(url));
    openViewer(); await ready(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ }));
    expect(screen.getByText('检索 8')).toBeTruthy(); expect(screen.getByText('核实成功 0')).toBeTruthy();
    fireEvent.click(screen.getByText('启用经验')); fireEvent.click(screen.getByText('取消'));
    expect(mocks.fetch.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false);
    fireEvent.click(screen.getByText('启用经验')); fireEvent.click(screen.getByText('确认启用'));
    await screen.findByText('已启用');
    expect(JSON.parse(mocks.fetch.mock.calls.find(([, options]) => options?.method === 'PATCH')![1].body)).toEqual({ state: 'enabled', expectedRevision: 2 });
  });
  it('requires explicit evidence review and sends a stable idempotency key with real run environment', async () => {
    mocks.fetch.mockImplementation(async (url: string, options?: { method: string }) => options?.method === 'POST' ? response({ entry: { ...experience, revision: 2 } }) : url.includes('/experiences') ? response({ entries: [experience] }) : initial(url));
    openViewer(); await ready(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
    fireEvent.change(screen.getByLabelText('证据来源'), { target: { value: 'external_manual' } });
    const save = screen.getByText('保存核实结果') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('运行标识'), { target: { value: 'run-real-123' } });
    fireEvent.change(screen.getByLabelText('证据引用'), { target: { value: 'test-report:123' } });
    fireEvent.change(screen.getByLabelText('结果摘要'), { target: { value: 'Observed all tests pass' } });
    fireEvent.change(screen.getByLabelText('核实结果'), { target: { value: 'success' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(save.disabled).toBe(false); fireEvent.click(save);
    await waitFor(() => expect(screen.queryByText('取消核实')).toBeNull());
    const body = JSON.parse(mocks.fetch.mock.calls.find(([, options]) => options?.method === 'POST')![1].body);
    expect(body).toMatchObject({ confirmed: true, expectedRevision: 1, runId: 'run-real-123', outcome: 'success', environment: { projectId: 'repo-alpha', platform: 'linux', appVersion: '1.0' } });
    expect(body.eventId).toBeTruthy(); expect(body.reviewerId).toBeUndefined();
  });
  it('corrects experience scope as a new candidate instead of preserving verification', async () => {
    mocks.fetch.mockImplementation(async (url: string, options?: { method: string; body: string }) => options?.method === 'PATCH' ? response({ entry: { ...experience, ...JSON.parse(options.body).patch, state: 'candidate', revision: 3 } }) : url.includes('/experiences') ? response({ entries: [{ ...experience, state: 'enabled', revision: 2 }] }) : initial(url));
    openViewer(); await ready(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ }));
    fireEvent.click(screen.getByText('纠正内容与范围'));
    fireEvent.change(screen.getByLabelText('适用项目'), { target: { value: 'repo-beta' } });
    fireEvent.click(screen.getByText('保存经验纠正'));
    await screen.findByText('候选');
    const body = JSON.parse(mocks.fetch.mock.calls.find(([, options]) => options?.method === 'PATCH')![1].body);
    expect(body).toMatchObject({ expectedRevision: 2, patch: { applicability: { scope: 'project', projectId: 'repo-beta' } } });
    expect(screen.queryByText('启用经验')).toBeNull();
  });
  it('explicitly approves a sourced candidate fact in pending review', async () => {
    mocks.fetch.mockImplementation(async (url: string, options?: { method: string }) => options?.method === 'PATCH' ? response({ memory: { ...memory, status: 'active', revision: 2 } }) : url.startsWith('/api/memories?agentId=alpha') ? response({ memories: [{ ...memory, status: 'candidate' }] }) : initial(url));
    openViewer(); await ready(); fireEvent.click(screen.getByRole('tab', { name: /^待核实/ }));
    fireEvent.click(await screen.findByText('确认有效'));
    await screen.findByText('没有待核实的记录。');
    expect(JSON.parse(mocks.fetch.mock.calls.find(([, options]) => options?.method === 'PATCH')![1].body)).toEqual({ status: 'active', expectedRevision: 1 });
  });
  it('includes failed extraction jobs in pending review and requeues explicitly', async () => {
    mocks.fetch.mockImplementation(async (url: string, options?: { method: string }) => url.includes('/extractions') ? response({ jobs: options?.method === 'POST' ? [] : [{ key: 'source-key', sessionId: 's2', status: 'quarantined', attempts: 3, error: 'invalid JSON' }] }) : initial(url));
    openViewer(); await ready(); fireEvent.click(screen.getByRole('tab', { name: /^待核实/ }));
    expect(await screen.findByText('invalid JSON')).toBeTruthy(); fireEvent.click(screen.getByText('重新排队提取'));
    await screen.findByText(/已重新排队/);
    expect(JSON.parse(mocks.fetch.mock.calls.find(([, options]) => options?.method === 'POST')![1].body)).toEqual({ key: 'source-key' });
  });
});
