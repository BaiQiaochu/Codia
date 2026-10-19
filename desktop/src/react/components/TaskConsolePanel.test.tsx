// @vitest-environment jsdom
import React from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn(), draft: vi.fn(), session: vi.fn(), tab: vi.fn() }));
vi.mock('../hooks/use-codia-fetch', () => ({ codiaFetch: mocks.fetch }));
vi.mock('../stores', () => ({ useStore: { getState: () => ({ setActivePanel: mocks.close, setCurrentTab: mocks.tab }) } }));
vi.mock('../stores/session-actions', () => ({ switchSession: mocks.session }));
vi.mock('../utils/input-draft-events', () => ({ requestInputDraft: mocks.draft }));
import { TaskConsolePanel } from './TaskConsolePanel';
import { openTaskConsoleRun, takePendingTaskConsoleRun } from '../utils/task-console-navigation';
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); window.localStorage.clear(); });
afterEach(() => { cleanup(); takePendingTaskConsoleRun(); vi.clearAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); });
const response = (data: unknown) => ({ ok: true, json: async () => data });

describe('task console UI', () => {
  it('renders live records, unknown cost and separate interrupted approvals', async () => {
    mocks.fetch.mockResolvedValue(response({ runs: [{ id: 'workflow:r', sourceId: 'r', source: 'workflow', title: 'Actual run', status: 'queued', owner: 'A', startedAt: 1, finishedAt: null, tokens: null, cost: { state: 'unknown', reason: 'Unknown pricing' }, artifacts: ['/real/artifact.md'] }], approvals: [], interruptedApprovals: [{ id: 'old', kind: 'tool', sessionPath: '/old' }], limitations: [] }));
    render(<TaskConsolePanel />);
    fireEvent.click(await screen.findByText('Actual run'));
    expect(screen.getByText('/real/artifact.md')).toBeTruthy();
    expect(screen.getByText('未知。Unknown pricing')).toBeTruthy();
    expect(screen.getByText(/重启中断，需重新请求批准/)).toBeTruthy();
    fireEvent.click(screen.getByText('进入原会话重新请求'));
    await waitFor(() => expect(mocks.session).toHaveBeenCalledWith('/old'));
  });
  it('prepares canonical draft via API and only prefills existing chat on explicit action', async () => {
    mocks.fetch.mockImplementation(async (url: string) => response(url.includes('preflight') ? { modelId: null, checks: [{ id: 'model', label: '模型能力', state: 'fail' }], reason: 'Not verified', draft: 'research-brief@1.0.0 reviewed draft' } : { runs: [], approvals: [], limitations: [] }));
    render(<TaskConsolePanel />);
    fireEvent.click(screen.getByText('任务模板'));
    fireEvent.click(screen.getByText('检查输入并准备草稿'));
    const fill = await screen.findByText('填入聊天草稿，审核后发送');
    expect(mocks.draft).not.toHaveBeenCalled();
    fireEvent.click(fill);
    expect(mocks.draft).toHaveBeenCalledWith({ text: 'research-brief@1.0.0 reviewed draft', mode: 'append', source: 'template:research-brief@1.0.0' });
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('preflight'))).toHaveLength(1);
    expect(mocks.close).toHaveBeenCalledWith(null);
  });
  it('launches only after explicit action and shows a started run rather than completed success', async () => {
    mocks.fetch.mockImplementation(async (url: string) => response(url.includes('preflight') ? { executionAllowed: true, modelId: 'qualified', checks: [], reason: 'Ready', draft: 'draft' }
      : url.includes('/execute') ? { runId: 'workflow-actual', status: 'running' } : { runs: [], approvals: [], limitations: [] }));
    render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.change(screen.getByLabelText('总 token 本地预算'), { target: { value: '200000' } });
    fireEvent.change(screen.getByLabelText('模型费用本地预算（USD）'), { target: { value: '3' } });
    fireEvent.click(screen.getByText('检查输入并准备草稿'));
    const launch = await screen.findByText('确认预算并启动实验运行');
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('/execute'))).toBe(false);
    fireEvent.click(launch);
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('尚未完成'));
    const call = mocks.fetch.mock.calls.find(([url]) => String(url).includes('/execute'))!;
    expect(JSON.parse(call[1].body)).toMatchObject({ confirmExperimental: true, version: '1.0.0', budget: { maxTokens: 200000, maxUsd: 3, maxSteps: 8, maxDurationMs: 300000, maxOutputTokensPerCall: 1024, maxModelCalls: 32 } });
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it('reuses the persisted request ID after a lost network acknowledgment without saving raw inputs', async () => {
    let attempts = 0;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('/execute')) { if (++attempts === 1) throw new Error('lost acknowledgment'); return response({ runId: 'workflow-original' }); }
      return response(url.includes('preflight') ? { executionAllowed: true, modelId: 'm', checks: [], reason: 'Ready', draft: 'draft' } : { runs: [], approvals: [], limitations: [] });
    });
    render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: 'PRIVATE_INPUT_NOT_PERSISTED' } });
    fireEvent.click(screen.getByText('检查输入并准备草稿'));
    fireEvent.click(await screen.findByText('确认预算并启动实验运行'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('lost acknowledgment'));
    const saved = window.localStorage.getItem('codia.task-console.pending-launch.v1')!;
    expect(saved).not.toContain('PRIVATE_INPUT_NOT_PERSISTED'); expect(JSON.parse(saved).fingerprint).toMatch(/^[a-f0-9]{64}$/);
    fireEvent.click(screen.getByText('确认预算并启动实验运行'));
    await screen.findByRole('status');
    const requests = mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/execute')).map(([, options]) => JSON.parse(options.body));
    expect(requests).toHaveLength(2); expect(requests[1].requestId).toBe(requests[0].requestId);
    expect(window.localStorage.getItem('codia.task-console.pending-launch.v1')).toBeNull();
  });
  it('keeps the same pending launch ID across component remounts', async () => {
    let attempts = 0;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('/execute')) { if (++attempts === 1) throw new Error('network interrupted'); return response({ runId: 'workflow-original' }); }
      return response(url.includes('preflight') ? { executionAllowed: true, modelId: 'm', checks: [], reason: 'Ready', draft: 'draft' } : { runs: [], approvals: [], limitations: [] });
    });
    const initial = render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.click(screen.getByText('检查输入并准备草稿')); fireEvent.click(await screen.findByText('确认预算并启动实验运行'));
    await screen.findByRole('alert'); initial.unmount();
    render(<TaskConsolePanel />);
    expect(screen.getByLabelText('未确认的模板启动')).toBeTruthy();
    fireEvent.click(screen.getByText('任务模板')); fireEvent.click(screen.getByText('检查输入并准备草稿'));
    fireEvent.click(await screen.findByText('确认预算并启动实验运行')); await screen.findByRole('status');
    const requests = mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/execute')).map(([, options]) => JSON.parse(options.body));
    expect(requests).toHaveLength(2); expect(requests[1].requestId).toBe(requests[0].requestId);
  });
  it('blocks changed input until the user explicitly confirms reviewing the old launch', async () => {
    let attempts = 0;
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url.includes('/execute')) { if (++attempts === 1) throw new Error('lost acknowledgment'); return response({ runId: 'workflow-new' }); }
      return response(url.includes('preflight') ? { executionAllowed: true, modelId: 'm', checks: [], reason: 'Ready', draft: 'draft' } : { runs: [], approvals: [], limitations: [] });
    });
    render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.click(screen.getByText('检查输入并准备草稿')); fireEvent.click(await screen.findByText('确认预算并启动实验运行'));
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: 'Changed input' } });
    fireEvent.click(screen.getByText('检查输入并准备草稿')); fireEvent.click(await screen.findByText('确认预算并启动实验运行'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveProperty('textContent', expect.stringContaining('输入已改变')));
    expect(attempts).toBe(1);
    fireEvent.click(screen.getByText('已核查已有运行，允许新建启动请求'));
    expect(screen.queryByText('确认预算并启动实验运行')).toBeNull();
    fireEvent.click(screen.getByText('检查输入并准备草稿')); fireEvent.click(await screen.findByText('确认预算并启动实验运行'));
    await waitFor(() => expect(attempts).toBe(2));
    const requests = mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/execute')).map(([, options]) => JSON.parse(options.body));
    expect(requests[1].requestId).not.toBe(requests[0].requestId);
  });
  it('keeps server-unknown admissions blocked across reload until explicit review', async () => {
    mocks.fetch.mockImplementation(async (url: string) => url.includes('/execute') ? { ok: false, status: 409, json: async () => ({ error: 'template_launch_result_unknown' }) }
      : response(url.includes('preflight') ? { executionAllowed: true, modelId: 'm', checks: [], reason: 'Ready', draft: 'draft' } : { runs: [], approvals: [], limitations: [] }));
    const initial = render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.click(screen.getByText('检查输入并准备草稿')); fireEvent.click(await screen.findByText('确认预算并启动实验运行'));
    await screen.findByRole('alert');
    expect(screen.getByText('确认预算并启动实验运行')).toHaveProperty('disabled', true);
    initial.unmount(); render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.click(screen.getByText('检查输入并准备草稿'));
    expect(await screen.findByText('确认预算并启动实验运行')).toHaveProperty('disabled', true);
    expect(mocks.fetch.mock.calls.filter(([url]) => String(url).includes('/execute'))).toHaveLength(1);
  });
  it('blocks launch for incomplete preflight and never probes automatically', async () => {
    mocks.fetch.mockImplementation(async (url: string) => response(url.includes('preflight') ? { executionAllowed: false, modelId: null, checks: [], reason: 'Unknown model', draft: 'draft' } : { runs: [], approvals: [], limitations: [] }));
    render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.click(screen.getByText('检查输入并准备草稿'));
    expect(await screen.findByText('确认预算并启动实验运行')).toHaveProperty('disabled', true);
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes('/qualification'))).toBe(false);
  });
  it('requires explicit image-price acknowledgment for vision and renders each capability result', async () => {
    mocks.fetch.mockImplementation(async (url: string) => response(url.includes('/qualification') ? { qualification: { state: 'pass' }, report: { results: [{ capability: 'vision', status: 'unsupported', code: 'media', suggestion: 'Check image transport' }] } }
      : url.includes('preflight') ? { executionAllowed: false, modelId: null, checks: [], reason: 'Unknown', draft: 'draft' } : { runs: [], approvals: [], limitations: [] }));
    render(<TaskConsolePanel />); fireEvent.click(screen.getByText('任务模板'));
    fireEvent.click(screen.getByLabelText('视觉'));
    const probe = screen.getByText('使用独立预算检测模型能力'); expect(probe).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('确认固定测试图片的费用按输入 token 估算；供应商账单可能不同'));
    fireEvent.click(probe);
    expect(await screen.findByLabelText('能力体检结果')).toHaveProperty('textContent', expect.stringContaining('Check image transport'));
    const call = mocks.fetch.mock.calls.find(([url]) => String(url).includes('/qualification'))!;
    expect(JSON.parse(call[1].body)).toMatchObject({ manual: true, capabilities: ['text', 'tool', 'vision'], mediaTokenAccountingConfirmed: true, budget: { maxCalls: 3 } });
  });
  it('requests cancellation for an active root run and warns about already-started side effects', async () => {
    mocks.fetch.mockImplementation(async (url: string) => response(url.includes('/cancel') ? { ok: true } : { runs: [{ id: 'workflow:r', sourceId: 'r', source: 'workflow', title: 'Active root', status: 'running', owner: 'A', parentTaskId: null, startedAt: 1, finishedAt: null, tokens: null, cost: { state: 'unknown', reason: 'Unknown' }, artifacts: [] }], approvals: [], limitations: [] }));
    render(<TaskConsolePanel />); fireEvent.click(await screen.findByText('Active root'));
    fireEvent.click(screen.getByText('请求停止后续步骤'));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('可能已经生效'));
    expect(mocks.fetch).toHaveBeenCalledWith('/api/workflow-runs/r/cancel', { method: 'POST' });
  });
  it('shows read errors rather than inventing successful empty state', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 403 });
    render(<TaskConsolePanel />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('403'));
  });
});
it('manual parent refresh updates selected artifacts and recovery without selecting another run', async () => {
  let generation = 0;
  const run = { id: 'workflow:r', sourceId: 'r', source: 'workflow', title: 'Refresh run', status: 'running', owner: 'A', startedAt: 1, finishedAt: null, tokens: null, cost: { state: 'unknown', reason: 'unknown' }, artifacts: [], sessionPath: '/s' };
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url === '/api/task-console') return response({ runs: [run], approvals: [], limitations: [] });
    if (url.startsWith('/api/task-artifacts')) return response({ files: generation ? [{ id: 'sf_new', displayName: 'Fresh artifact' }] : [], capabilities: {} });
    if (url.startsWith('/api/workflow-recovery')) return response({ canPrepare: false, blockedReason: generation ? 'now blocked' : 'running', actions: [] });
    return response({ entries: [] });
  });
  render(<TaskConsolePanel />); fireEvent.click(await screen.findByText('Refresh run'));
  await screen.findByText('尚无已登记文件。'); generation++;
  fireEvent.click(screen.getByRole('button', { name: /^刷新$/ }));
  await screen.findByText('Fresh artifact'); await screen.findByText('now blocked');
  expect(screen.getAllByText('Refresh run')).toHaveLength(2);
});
it('opens a recorded evidence run across lazy mount and reports expired evidence without dispatch', async () => {
  const run = { id: 'activity:evidence', sourceId: 'evidence', source: 'activity', title: 'Evidence run', status: 'failed', owner: 'A', startedAt: 1, finishedAt: 2, tokens: null, cost: { state: 'unknown', reason: 'unknown' }, artifacts: [] };
  mocks.fetch.mockResolvedValue(response({ runs: [run], approvals: [], limitations: [] }));
  expect(openTaskConsoleRun('activity:evidence')).toBe(true); expect(mocks.close).toHaveBeenCalledWith('task-console');
  render(<TaskConsolePanel />); await screen.findByText('activity:evidence');
  expect(screen.getAllByText('Evidence run')).toHaveLength(2);
  expect(openTaskConsoleRun('workflow:removed')).toBe(true);
  await screen.findByText('该运行尚未找到或已不在保留记录中；可刷新重试。');
  expect(mocks.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});
it('rejects older list responses arriving after a newer manual refresh', async () => {
  let first: (v: unknown) => void = () => {};
  const run = { id: 'activity:new', sourceId: 'new', source: 'activity', title: 'Newest state', status: 'failed', owner: 'A', startedAt: 1, finishedAt: 2, cost: { state: 'unknown', reason: 'unknown' }, artifacts: [] };
  let lists = 0;
  mocks.fetch.mockImplementation((url: string) => {
    if (url === '/api/task-console' && ++lists === 1) return new Promise(resolve => { first = resolve; });
    return Promise.resolve(response({ runs: [run], approvals: [], limitations: [], entries: [] }));
  });
  render(<TaskConsolePanel />); fireEvent.click(screen.getByRole('button', { name: /^刷新$/ }));
  await screen.findByText('Newest state'); first(response({ runs: [], approvals: [], limitations: [] }));
  await waitFor(() => expect(screen.getByText('Newest state')).toBeTruthy());
});
