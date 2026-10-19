// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), closeSettings: vi.fn(), navigate: vi.fn(() => true), budgetProps: undefined as undefined | { onAcquireMutation?: () => boolean; onReleaseMutation?: () => void } }));
vi.mock('../store', () => ({ useSettingsStore: { getState: () => ({ getSettingsAgentId: () => 'alpha' }) } }));
vi.mock('../api', async original => ({ ...(await original<typeof import('../api')>()), codiaFetch: mocks.fetch }));
vi.mock('../../stores/settings-modal-actions', () => ({ closeSettingsModal: mocks.closeSettings }));
vi.mock('../../utils/task-console-navigation', () => ({ openTaskConsoleRun: mocks.navigate }));
vi.mock('../helpers', () => ({ t: (value: string) => value }));
vi.mock('./MemoryBudgetSettings', () => ({ MemoryBudgetSettings: (props: { onAcquireMutation?: () => boolean; onReleaseMutation?: () => void }) => { mocks.budgetProps = props; return <div>后台处理预算</div>; } }));
import { MemoryViewer } from './MemoryViewer';
const fact = (id: number) => ({ id, fact: `Fact ${id}`, status: 'candidate', reviewStatus: 'unverified', revision: 2, updated_at: '2026-10-01T00:00:00Z', source: 'session:s1', sourceRefs: [{ kind: 'session', sessionId: 's1' }] });
const experience = { id: 'exp-1', revision: 3, contentRevision: 2, state: 'candidate', category: 'Build', content: 'Use trusted lockfile', taskType: 'build', goal: '', preconditions: [], actions: [], verificationMethod: 'tests', risks: [], rollback: '', sourceRefs: [{ type: 'run', id: 'activity:run-1' }], parentMemoryIds: [], applicability: { scope: 'project', projectId: 'workspace:/alpha', platform: 'linux' }, lastVerifiedAt: null, evidence: [], stats: { retrieved: 1, injected: 0, attempted: 0, verifiedSuccess: 0, verifiedFailure: 0, unknown: 0 } };
const run = { environmentProvenance: 'recorded', environmentDiagnostics: [], evidenceOrigin: 'recorded_run', runId: 'activity:run-1', sessionId: 's1', status: 'succeeded', startedAt: '2026-10-01T01:00:00Z', finishedAt: '2026-10-01T01:01:00Z', evidenceRef: 'task-run:run-1', environment: { projectId: 'workspace:/alpha', platform: 'linux', appVersion: '0.3.3' } };
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const meta = { limit: 25, offset: 0, total: 0, pendingTotal: 0, projects: [{ id: 'workspace:/alpha', label: 'Alpha' }], sources: ['session:s1'] };
const initial = (url: string) => {
 const parsed = new URL(url, 'http://local');
 if (parsed.pathname.endsWith('/runs')) return response({ ...meta, total: 1, runs: [run] });
 if (parsed.pathname.endsWith('/experiences')) return response({ ...meta, total: 1, pendingTotal: 1, entries: [experience], enabled: true });
 if (parsed.pathname.endsWith('/extractions')) return response({ ...meta, jobs: [] });
 return response({ ...meta, total: 10000, pendingTotal: 9999, offset: Number(parsed.searchParams.get('offset') || 0), memories: parsed.searchParams.get('offset') === '25' ? [fact(26)] : [fact(1), fact(2)] });
};
const open = async () => { render(<MemoryViewer />); act(() => window.dispatchEvent(new Event('codia-view-memories'))); await screen.findByText('Fact 1'); await waitFor(() => expect(screen.queryByText('正在加载来源与记录…')).toBeNull()); };
beforeEach(() => { mocks.navigate.mockReturnValue(true); mocks.fetch.mockImplementation(async (url: string) => initial(url)); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('memory governance paged review workspace', () => {
 it('requests bounded server pages and filters by real project, source, status and dates', async () => {
  await open();
  expect(new URL(mocks.fetch.mock.calls[0][0], 'http://local').searchParams.get('limit')).toBe('25');
  expect(screen.getByRole('tab', { name: '待核实 (10000)' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '事实与偏好下一页' }));
  await screen.findByText('Fact 26'); expect(screen.queryByText('Fact 1')).toBeNull();
  fireEvent.change(screen.getByLabelText('检索记忆与经验'), { target: { value: 'older fact' } });
  fireEvent.change(screen.getByLabelText('筛选项目'), { target: { value: 'workspace:/alpha' } });
  fireEvent.change(screen.getByLabelText('筛选来源'), { target: { value: 'session:s1' } });
  fireEvent.change(screen.getByLabelText('筛选状态'), { target: { value: 'candidate' } });
  fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-01' } });
  fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-10-01' } });
  fireEvent.click(screen.getByText('应用筛选'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => { const q = new URL(url, 'http://local').searchParams; return q.get('q') === 'older fact' && q.get('projectId') === 'workspace:/alpha' && q.get('source') === 'session:s1' && q.get('status') === 'candidate' && q.get('from') === '2026-09-01' && q.get('to') === '2026-10-01' && q.get('offset') === '0'; })).toBe(true));
 });
 it('previews exact selections, sends each CAS version and reports mixed batch results', async () => {
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/batch') ? response({ results: [{ id: 1, ok: true, memory: { ...fact(1), status: 'active', reviewStatus: 'user_confirmed', revision: 3 } }, { id: 2, ok: false, code: 'revision_conflict', error: 'Changed elsewhere', current: { ...fact(2), revision: 3, fact: 'Newer fact 2' } }] }) : initial(url));
  await open();
  fireEvent.click(screen.getByLabelText('选择事实 1')); fireEvent.click(screen.getByLabelText('选择事实 2'));
  fireEvent.click(screen.getByText('预览批量确认'));
  expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/batch'))).toBe(false);
  const preview = screen.getByRole('region', { name: '批量事实预览' });
  expect(within(preview).getByText('Fact 1')).toBeTruthy(); expect(within(preview).getByText('Fact 2')).toBeTruthy();
  fireEvent.click(within(preview).getByText('确认处理 2 条事实'));
  await screen.findByText('Newer fact 2');
  expect(screen.getByText(/#2.*版本冲突/)).toBeTruthy();
  expect(screen.getByText(/成功 1 条.*失败 1 条/)).toBeTruthy();
  expect(JSON.parse(mocks.fetch.mock.calls.find(([url]) => url.includes('/batch'))![1].body)).toEqual({ operation: 'confirm', confirmed: true, items: [{ id: 1, expectedRevision: 2 }, { id: 2, expectedRevision: 2 }] });
  expect(screen.queryByText('批量启用经验')).toBeNull();
 });
 it('loads recorded runs, requires explicit adoption and human review, and sends no editable environment', async () => {
  mocks.fetch.mockImplementation(async (url: string, opts?: RequestInit) => opts?.method === 'POST' ? response({ entry: { ...experience, revision: 4 } }) : initial(url));
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
  await screen.findByLabelText('选择真实运行');
  await waitFor(() => expect(within(screen.getByLabelText('选择真实运行')).getByText(/run-1/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('选择真实运行'), { target: { value: 'activity:run-1' } });
  expect(screen.queryByLabelText('运行平台')).toBeNull();
  expect(mocks.fetch.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByText('本次实际采用了这条经验'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/attempt'))).toBe(true));
  expect(JSON.parse(mocks.fetch.mock.calls.find(([url]) => url.includes('/attempt'))![1].body)).toEqual({ expectedRevision: 3, runId: 'activity:run-1', confirmed: true });
  fireEvent.change(screen.getByLabelText('结果摘要'), { target: { value: 'Checked output independently' } });
  fireEvent.change(screen.getByLabelText('核实结果'), { target: { value: 'success' } });
  expect((screen.getByText('保存核实结果') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/我已检查上述运行与证据/)); fireEvent.click(screen.getByText('保存核实结果'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/review'))).toBe(true));
  const body = JSON.parse(mocks.fetch.mock.calls.find(([url]) => url.includes('/review'))![1].body);
  expect(body).toMatchObject({ evidenceOrigin: 'recorded_run', runId: 'activity:run-1', outcome: 'success', confirmed: true }); expect(body.environment).toBeUndefined(); expect(body.eventId).toBeTruthy();
 });
 it('never fabricates a missing run and labels external manual evidence explicitly', async () => {
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/runs') ? response({ ...meta, runs: [] }) : initial(url));
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
  await screen.findByText(/没有可用的真实运行/);
  expect((screen.getByText('保存核实结果') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('证据来源'), { target: { value: 'external_manual' } });
  expect(screen.getByText(/人工提供.*未自动解析/)).toBeTruthy(); expect(screen.getByLabelText('运行标识')).toBeTruthy();
 });
 it('cancels a batch preview without writes and clears selection when a page changes', async () => {
  await open(); fireEvent.click(screen.getByLabelText('选择事实 1')); fireEvent.click(screen.getByText('预览批量忘记'));
  expect(screen.getByRole('region', { name: '批量事实预览' }).textContent).toContain('遗忘标记');
  fireEvent.click(screen.getByText('取消批量处理'));
  expect(mocks.fetch.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '事实与偏好下一页' })); await screen.findByText('Fact 26');
  expect(screen.getByText('已选择 0 条事实（仅当前页）')).toBeTruthy();
  expect((screen.getByText('预览批量确认') as HTMLButtonElement).disabled).toBe(true);
 });
 it('never treats a missing item acknowledgement as successful and rejects repeated submit clicks', async () => {
  let finish!: (value: unknown) => void;
  mocks.fetch.mockImplementation((url: string) => url.includes('/batch') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(initial(url)));
  await open(); fireEvent.click(screen.getByLabelText('选择事实 1')); fireEvent.click(screen.getByLabelText('选择事实 2'));
  fireEvent.click(screen.getByText('预览批量忘记')); fireEvent.click(screen.getByText('确认处理 2 条事实')); fireEvent.click(screen.getByText('确认处理 2 条事实'));
  expect(mocks.fetch.mock.calls.filter(([url]) => url.includes('/batch'))).toHaveLength(1);
  await act(async () => finish(response({ results: [{ id: 1, ok: true }] })));
  await screen.findByText(/成功 1 条.*失败 1 条/);
  expect(screen.queryByText('Fact 1')).toBeNull(); expect(screen.getByText('Fact 2')).toBeTruthy();
  expect(screen.getByText(/服务器未返回此条结果/)).toBeTruthy();
 });
 it('sends reviewOnly to all paged endpoints instead of deriving totals from the visible page', async () => {
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^待核实/ }));
  await waitFor(() => expect(screen.queryByText('正在加载来源与记录…')).toBeNull());
  const calls = mocks.fetch.mock.calls.slice(-3).map(([url]) => new URL(url, 'http://local'));
  expect(calls.every(url => url.searchParams.get('reviewOnly') === 'true' && url.searchParams.get('limit') === '25')).toBe(true);
  expect(screen.getByRole('tab', { name: '待核实 (10000)' })).toBeTruthy();
 });
 it('blocks historical verification when only current session environment is available', async () => {
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/runs') ? response({ ...meta, total: 1, runs: [{ ...run, environmentProvenance: 'session_current' }] }) : initial(url));
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
  await waitFor(() => expect(within(screen.getByLabelText('选择真实运行')).getByText(/run-1/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('选择真实运行'), { target: { value: 'activity:run-1' } });
  expect(screen.getByRole('alert').textContent).toContain('缺少可信历史环境');
  fireEvent.change(screen.getByLabelText('结果摘要'), { target: { value: 'Check completed' } });
  fireEvent.click(screen.getByLabelText(/我已检查上述运行与证据/));
  expect((screen.getByText('保存核实结果') as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.fetch.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
 });
 it('reports a run read failure and supports a bounded retry without inventing entries', async () => {
  let fail = true;
  mocks.fetch.mockImplementation(async (url: string) => { if (url.includes('/runs') && fail) throw new Error('run index offline'); return initial(url); });
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
  expect((await screen.findByRole('alert')).textContent).toContain('run index offline');
  expect(within(screen.getByLabelText('选择真实运行')).queryByText(/run-1/)).toBeNull();
  fail = false; fireEvent.click(screen.getByText('查找运行'));
  await waitFor(() => expect(within(screen.getByLabelText('选择真实运行')).getByText(/run-1/)).toBeTruthy());
  expect(mocks.fetch.mock.calls.filter(([url]) => url.includes('/runs')).every(([url]) => new URL(url, 'http://local').searchParams.get('limit') === '25')).toBe(true);
 });
 it('clears previous human approval after a concurrent experience revision while preserving the draft', async () => {
  mocks.fetch.mockImplementation(async (url: string, opts?: RequestInit) => url.includes('/review') && opts?.method === 'POST' ? { ok: false, status: 409, json: async () => ({ code: 'revision_conflict', error: 'changed', current: { ...experience, revision: 4, contentRevision: 3, content: 'Changed instructions' } }) } : initial(url));
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
  await waitFor(() => expect(within(screen.getByLabelText('选择真实运行')).getByText(/run-1/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('选择真实运行'), { target: { value: 'activity:run-1' } });
  fireEvent.change(screen.getByLabelText('结果摘要'), { target: { value: 'My inspected result' } });
  fireEvent.click(screen.getByLabelText(/我已检查上述运行与证据/)); fireEvent.click(screen.getByText('保存核实结果'));
  await screen.findByText('Changed instructions');
  expect((screen.getByLabelText('结果摘要') as HTMLTextAreaElement).value).toBe('My inspected result');
  expect((screen.getByLabelText(/我已检查上述运行与证据/) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByText('保存核实结果') as HTMLButtonElement).disabled).toBe(true);
 });

 it('searches historical projects in bounded pages and preserves the selected real ID', async () => {
  mocks.fetch.mockImplementation(async (url: string) => {
    const query = new URL(url, 'http://local');
    if (query.pathname.endsWith('/projects')) return response({ projects: [{ id: query.searchParams.get('offset') === '25' ? 'workspace:/archive/two' : 'workspace:/archive/one', label: 'Historical project' }], total: 30, offset: Number(query.searchParams.get('offset')), limit: 25 });
    return initial(url);
  });
  await open(); fireEvent.change(screen.getByLabelText('查找历史项目'), { target: { value: 'a' } });
  expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/projects'))).toBe(false);
  fireEvent.change(screen.getByLabelText('查找历史项目'), { target: { value: 'archive' } });
  await waitFor(() => expect(within(screen.getByLabelText('筛选项目')).getByText(/workspace:\/archive\/one/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('筛选项目'), { target: { value: 'workspace:/archive/one' } });
  fireEvent.click(screen.getByLabelText('项目搜索下一页'));
  await waitFor(() => expect(within(screen.getByLabelText('筛选项目')).getByText(/workspace:\/archive\/two/)).toBeTruthy());
  expect((screen.getByLabelText('筛选项目') as HTMLSelectElement).value).toBe('workspace:/archive/one');
  fireEvent.change(screen.getByLabelText('筛选来源'), { target: { value: 'old-source-outside-facets' } });
  fireEvent.click(screen.getByText('应用筛选'));
  await waitFor(() => expect(mocks.fetch.mock.calls.some(([url]) => { const q = new URL(url, 'http://local').searchParams; return q.get('projectId') === 'workspace:/archive/one' && q.get('source') === 'old-source-outside-facets'; })).toBe(true));
 });
 it('cancels obsolete historical-project lookups and discards a late response', async () => {
  let finishOld!: (value: unknown) => void;
  let oldSignal: AbortSignal | undefined;
  mocks.fetch.mockImplementation((url: string, options?: RequestInit) => {
    if (url.includes('/projects') && url.includes('q=older')) { oldSignal = options?.signal as AbortSignal; return new Promise(resolve => { finishOld = resolve; }); }
    if (url.includes('/projects')) return Promise.resolve(response({ projects: [{ id: 'workspace:/newest', label: 'Newest' }], total: 1 }));
    return Promise.resolve(initial(url));
  });
  await open(); fireEvent.change(screen.getByLabelText('查找历史项目'), { target: { value: 'older' } });
  await waitFor(() => expect(finishOld).toBeTypeOf('function'));
  fireEvent.change(screen.getByLabelText('查找历史项目'), { target: { value: 'newest' } });
  await waitFor(() => expect(within(screen.getByLabelText('筛选项目')).getByText(/Newest/)).toBeTruthy());
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => finishOld(response({ projects: [{ id: 'workspace:/stale', label: 'Stale result' }], total: 1 })));
  expect(within(screen.getByLabelText('筛选项目')).queryByText(/Stale result/)).toBeNull();
 });

 it('shares the mutation lock with background-budget writes so closing cannot hide a pending save', async () => {
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^待核实/ }));
  await waitFor(() => expect(screen.queryByText('正在加载来源与记录…')).toBeNull());
  act(() => { expect(mocks.budgetProps?.onAcquireMutation?.()).toBe(true); });
  fireEvent.click(screen.getByLabelText('关闭记忆')); expect(screen.getByRole('dialog')).toBeTruthy();
  act(() => { expect(mocks.budgetProps?.onAcquireMutation?.()).toBe(false); });
  act(() => { mocks.budgetProps?.onReleaseMutation?.(); });
  fireEvent.click(screen.getByLabelText('关闭记忆')); expect(screen.queryByRole('dialog')).toBeNull();
 });

 it('reads precise message IDs on demand and warns about changed or missing source evidence', async () => {
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/1/evidence') ? response({ messages: [{ sessionId: 's1', messageId: 'm1', role: 'user', text: 'Exact original message text', timestamp: null, hashMatches: false }], missingMessageIds: ['m2'], limitations: ['Showing at most 20 recorded references'] }) : initial(url));
  await open();
  expect(mocks.fetch.mock.calls.some(([url]) => url.includes('/1/evidence'))).toBe(false);
  const card = screen.getByRole('region', { name: '记忆 1' });
  fireEvent.click(within(card).getByText(/查看来源/)); fireEvent.click(within(card).getByText('读取消息证据'));
  expect(await within(card).findByText('Exact original message text')).toBeTruthy();
  expect(within(card).getByText(/证据校验不匹配/)).toBeTruthy(); expect(within(card).getByText(/找不到这些消息.*m2/)).toBeTruthy();
  expect(within(card).getByText(/打开来源会话仍是会话级跳转/)).toBeTruthy();
  expect(mocks.fetch.mock.calls.some(([, options]) => options?.method)).toBe(false);
 });
 it('shows real execution summaries and inert artifact paths, and navigates only by the recorded run ID', async () => {
  mocks.fetch.mockImplementation(async (url: string) => url.includes('/runs') ? response({ ...meta, total: 1, runs: [{ ...run, summary: 'Observed 12 checks passed', artifacts: [{ path: '/tmp/result.txt' }, { url: 'https://example.com/report', displayName: 'Report' }, { uri: 'javascript:alert(1)' }] }] }) : initial(url));
  await open(); fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
  await waitFor(() => expect(within(screen.getByLabelText('选择真实运行')).getByText(/run-1/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('选择真实运行'), { target: { value: 'activity:run-1' } });
  fireEvent.click(screen.getByText('查看执行结果与成果引用'));
  expect(screen.getByText('Observed 12 checks passed')).toBeTruthy(); expect(screen.getByText('/tmp/result.txt').tagName).toBe('SPAN');
  expect(screen.getByText('javascript:alert(1)').tagName).toBe('SPAN'); expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com/report');
  fireEvent.click(screen.getByText('查看任务详情')); expect(mocks.navigate).toHaveBeenCalledWith('activity:run-1'); expect(mocks.closeSettings).toHaveBeenCalledTimes(1); expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
 });

 it('keeps a standalone settings window open and explains when task navigation is unavailable there', async () => {
  render(<><div id="settingsPanel" /><MemoryViewer /></>); act(() => window.dispatchEvent(new Event('codia-view-memories')));
  await screen.findByText('Fact 1'); await waitFor(() => expect(screen.queryByText('正在加载来源与记录…')).toBeNull());
  fireEvent.click(screen.getByRole('tab', { name: /^经验/ })); fireEvent.click(screen.getByText('记录核实结果'));
  await waitFor(() => expect(within(screen.getByLabelText('选择真实运行')).getByText(/run-1/)).toBeTruthy());
  fireEvent.change(screen.getByLabelText('选择真实运行'), { target: { value: 'activity:run-1' } });
  fireEvent.click(screen.getByText('查看执行结果与成果引用')); fireEvent.click(screen.getByText('查看任务详情'));
  expect(screen.getByRole('alert').textContent).toContain('独立设置窗口无法显示任务详情');
  expect(mocks.navigate).not.toHaveBeenCalled(); expect(mocks.closeSettings).not.toHaveBeenCalled(); expect(screen.getByRole('dialog')).toBeTruthy();
 });
 it('aborts precise-evidence reads for an outdated fact revision and discards their late response', async () => {
  let finish!: (value: unknown) => void; let signal: AbortSignal | undefined;
  mocks.fetch.mockImplementation((url: string, options?: RequestInit) => {
    if (url.includes('/1/evidence')) { signal = options?.signal as AbortSignal; return new Promise(resolve => { finish = resolve; }); }
    if (options?.method === 'PATCH') return Promise.resolve(response({ memory: { ...fact(1), fact: 'New revision fact', revision: 3 } }));
    return Promise.resolve(initial(url));
  });
  await open(); const card = screen.getByRole('region', { name: '记忆 1' });
  fireEvent.click(within(card).getByText(/查看来源/)); fireEvent.click(within(card).getByText('读取消息证据'));
  fireEvent.click(within(card).getByText('纠错')); fireEvent.click(within(card).getByText('保存纠错'));
  await screen.findByText('New revision fact'); expect(signal?.aborted).toBe(true);
  await act(async () => finish(response({ messages: [{ sessionId: 's1', messageId: 'm1', role: 'user', text: 'Stale source content', timestamp: null, hashMatches: true }], missingMessageIds: [], limitations: [] })));
  expect(screen.queryByText('Stale source content')).toBeNull();
 });

});
