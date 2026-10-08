// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CloudTasks, CloudTaskRunDetail, type CloudTasksProps } from './CloudTasks';
import { createCloudWorkspaceClient, type CloudFile, type CloudHealth, type CloudRun, type CloudSchedule, type CloudTaskPlan, type CloudTaskSession } from './cloud-workspace-api';

const stamp = '2026-10-08T00:00:00.000Z';
const file: CloudFile = { id: 'file-1', current_version: 'input-v1', name: '材料.txt', size: 16, sha256: 'a'.repeat(64), version_count: 1, created_at: stamp };
const plan: CloudTaskPlan = { id: 'plan-1', title: '调研计划', currentVersion: 'plan-v1', workspaceId: 'workspace-1', instruction: '核对材料并生成结论', inputVersions: [file.current_version], createdAt: stamp, updatedAt: stamp };
const schedule: CloudSchedule = { id: 'schedule-1', name: '每日检查', input_version: file.current_version, operation: 'document-summary', state: 'paused', next_run_at: 1791435900000, interval_ms: 60_000, revision: 1, created_at: stamp, updated_at: stamp };
const run: CloudRun = { id: 'run-1', input_version: plan.currentVersion, operation: 'agent-task', status: 'queued', created_at: stamp, updated_at: stamp };
const health: CloudHealth = { mode: 'local', database: 'sqlite', objectStore: 'local', executor: 'codia-agent', executorAvailable: true, supportedOperations: ['document-summary', 'agent-task', 'agent-summary'], productionReady: false };
const noModel: CloudHealth = { ...health, executorAvailable: false, executorUnavailableReason: 'model_not_configured' };
const session: CloudTaskSession = { schemaVersion: 1, runId: run.id, attempt: 2, finalText: '已整理结论 <script>unsafe()</script>', inputVersions: [file.current_version], messages: [{ role: 'assistant', text: '开始检查' }, { role: 'tool', toolName: 'read_cloud_file', toolCallId: 'call-1', text: '读取完成' }, { role: 'tool', toolName: 'create_artifact', text: '拒绝越界', isError: true }], artifacts: [{ id: 'output-1', name: '调研结果.txt', content: '结论 <img src=x onerror=unsafe()>', sha256: 'a'.repeat(64), size: 45 }] };
type Write = { path: string; method: string; body: Record<string, unknown> };
let writes: Write[];
let plans: CloudTaskPlan[];
let schedules: CloudSchedule[];
let responseError: { status?: number; message: string } | null;
let text: string;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function client() {
  return createCloudWorkspaceClient(async (path, init) => {
    if (init.method) {
      const body = JSON.parse(String(init.body)); writes.push({ path, method: init.method, body });
      if (responseError) { if (!responseError.status) throw new TypeError(responseError.message); return json({ error: responseError.message }, responseError.status); }
      if (path.endsWith('/task-plans')) { const saved = { ...plan, ...body, instruction: body.instruction || '固定工作流指令' }; plans = [saved]; return json({ plan: saved }); }
      if (path.endsWith('/schedules')) { const saved: CloudSchedule = { ...schedule, name: body.name, input_version: body.inputVersion, operation: body.operation, next_run_at: body.firstRunAt, interval_ms: body.intervalMs, state: body.enabled ? 'enabled' : 'paused' }; schedules = [saved]; return json({ schedule: saved }); }
      if (path.includes('/schedules/')) { const saved: CloudSchedule = { ...schedules[0], revision: schedules[0].revision + 1, state: body.enabled ? 'enabled' : 'paused' }; schedules = [saved]; return json({ schedule: saved }); }
      if (path.endsWith('/cancel')) return json({ run: { ...run, status: 'failed', error: 'cancelled' } });
      if (path.endsWith('/runs')) return json({ run });
    }
    if (path.endsWith('/task-plans')) return json({ plans });
    if (path.endsWith('/schedules')) return json({ schedules });
    if (path.includes('/records?')) return json({ records: [{ id: 'workflow-1', kind: 'workflow', title: '周报草稿', currentVersion: 'workflow-v1', createdAt: stamp, updatedAt: stamp }] });
    if (path.endsWith('/workflow-v1/content')) return new Response(JSON.stringify({ kind: 'workflow', data: { instruction: '固定工作流指令' } }));
    if (path.endsWith('/content')) return new Response(text);
    if (path.endsWith('/task-session')) return json({ session });
    throw new Error(`Unexpected request: ${path}`);
  });
}
function props(overrides: Partial<CloudTasksProps> = {}): CloudTasksProps { return { workspaceId: 'workspace-1', client: client(), files: [file], health, ...overrides }; }
async function ready(overrides: Partial<CloudTasksProps> = {}) {
  const p = props(overrides); const result = render(<CloudTasks {...p} />);
  await screen.findByRole('button', { name: '调研计划' });
  return { ...result, props: p };
}
function fillPlan() { fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '研究新目标' } }); fireEvent.change(screen.getByLabelText('任务指令'), { target: { value: '按所选材料整理结论' } }); }
async function fillSchedule() {
  fireEvent.change(screen.getByLabelText('定时任务名称'), { target: { value: '测试检查' } });
  fireEvent.change(screen.getByLabelText('定时输入文件'), { target: { value: file.id } });
  await waitFor(() => expect(screen.getByRole('button', { name: '保存为暂停定时' })).toBeEnabled());
}
beforeEach(() => { writes = []; plans = [plan]; schedules = [schedule]; responseError = null; text = 'UTF-8 文本材料'; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('cloud task plans and durable schedules', () => {
  it('pins validated workspace text and protects a repeated plan submission', async () => {
    const result = await ready(); fillPlan();
    fireEvent.change(screen.getByLabelText('添加当前工作空间文件'), { target: { value: file.id } });
    await screen.findByRole('button', { name: '移除 材料.txt' });
    result.rerender(<CloudTasks {...result.props} files={[{ ...file, current_version: 'input-new' }]} />);
    const button = screen.getByRole('button', { name: '保存任务计划' }); fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('任务计划已保存，输入版本已固定。保存不会调用模型。');
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ title: '研究新目标', instruction: '按所选材料整理结论', inputVersions: ['input-v1'] });
    expect(writes[0].body.requestKey).toEqual(expect.any(String));
  });

  it('keeps the draft and request key after an uncertain network response and retry', async () => {
    await ready(); fillPlan(); responseError = { message: 'Network offline' };
    fireEvent.click(screen.getByRole('button', { name: '保存任务计划' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('任务指令')).toHaveValue('按所选材料整理结论');
    fireEvent.click(screen.getByRole('button', { name: '重新读取列表' }));
    expect(screen.getByLabelText('任务名称')).toHaveValue('研究新目标');
    responseError = null; fireEvent.click(screen.getByRole('button', { name: '保存任务计划' }));
    await screen.findByText('任务计划已保存，输入版本已固定。保存不会调用模型。');
    expect(writes).toHaveLength(2); expect(writes[0].body.requestKey).toBe(writes[1].body.requestKey);
  });

  it('previews an exact workflow version and keeps the manual instruction when switching back', async () => {
    await ready(); fillPlan(); fireEvent.change(screen.getByLabelText('使用已保存的工作流'), { target: { value: 'workflow-v1' } });
    await screen.findByText('固定工作流指令');
    fireEvent.change(screen.getByLabelText('使用已保存的工作流'), { target: { value: '' } });
    expect(screen.getByLabelText('任务指令')).toHaveValue('按所选材料整理结论');
    fireEvent.change(screen.getByLabelText('使用已保存的工作流'), { target: { value: 'workflow-v1' } });
    await screen.findByText('固定工作流指令'); fireEvent.click(screen.getByRole('button', { name: '保存任务计划' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].body.sourceWorkflowVersion).toBe('workflow-v1'); expect(writes[0].body.instruction).toBeUndefined();
  });

  it('rejects binary or oversized text without adding it to a plan', async () => {
    await ready(); text = '\0not text';
    fireEvent.change(screen.getByLabelText('添加当前工作空间文件'), { target: { value: file.id } });
    expect((await screen.findByRole('alert')).textContent).toContain('仅支持非空 UTF-8 文本');
    expect(screen.queryByRole('button', { name: '移除 材料.txt' })).not.toBeInTheDocument(); expect(writes).toHaveLength(0);
  });

  it('counts instruction bytes toward the text budget and limits input selection to eight files', async () => {
    const files = Array.from({ length: 9 }, (_, index) => ({ ...file, id: `file-${index}`, name: `材料${index}.txt`, current_version: `input-${index}` }));
    const result = await ready({ files });
    for (let index = 0; index < 8; index += 1) {
      fireEvent.change(screen.getByLabelText('添加当前工作空间文件'), { target: { value: files[index].id } });
      await screen.findByRole('button', { name: `移除 材料${index}.txt` });
    }
    expect(screen.getByRole('option', { name: /材料8.txt · input-8/ })).toBeDisabled(); result.unmount();
    text = 'a'.repeat(120 * 1024); await ready();
    fireEvent.change(screen.getByLabelText('添加当前工作空间文件'), { target: { value: file.id } });
    await screen.findByRole('button', { name: '移除 材料.txt' });
    fireEvent.change(screen.getByLabelText('任务名称'), { target: { value: '超出合计限制' } });
    fireEvent.change(screen.getByLabelText('任务指令'), { target: { value: 'b'.repeat(16000) } });
    expect(screen.getByRole('button', { name: '保存任务计划' })).toBeDisabled(); expect(writes).toHaveLength(0);
  });

  it('allows saving plans without a model, blocks AI calls and enables fixed document schedules', async () => {
    await ready({ health: noModel }); fillPlan();
    expect(screen.getByRole('button', { name: '保存任务计划' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '执行 调研计划' })).toBeDisabled();
    await fillSchedule(); expect(screen.getByLabelText('创建后立即启用')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('定时处理方式'), { target: { value: 'agent-task' } });
    expect(screen.getByLabelText('创建后立即启用')).toBeDisabled(); expect(writes).toHaveLength(0);
  });

  it('saves one-time schedules paused by default and sends a UTC timestamp', async () => {
    await ready(); await fillSchedule(); fireEvent.change(screen.getByLabelText('首次运行（本机时间）'), { target: { value: '2026-11-01T09:30' } });
    expect(screen.getByTestId('schedule-utc-preview')).toHaveTextContent(new Date('2026-11-01T09:30').toISOString());
    const button = screen.getByRole('button', { name: '保存为暂停定时' }); fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('定时任务已保存为暂停状态。启用后才会执行。');
    expect(writes).toHaveLength(1); expect(writes[0].body).toMatchObject({ inputVersion: file.current_version, operation: 'document-summary', enabled: false, intervalMs: null, firstRunAt: new Date('2026-11-01T09:30').getTime() });
  });

  it('preserves schedule key and first-run timestamp across an uncertain retry', async () => {
    await ready(); await fillSchedule(); responseError = { message: 'Network offline' };
    fireEvent.click(screen.getByRole('button', { name: '保存为暂停定时' })); await screen.findByRole('alert'); responseError = null;
    fireEvent.click(screen.getByRole('button', { name: '保存为暂停定时' })); await screen.findByText('定时任务已保存为暂停状态。启用后才会执行。');
    expect(writes[0].body).toEqual(writes[1].body);
  });

  it('discloses recurring AI costs before explicit enabling and pins the chosen plan', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: '调研计划' }));
    fireEvent.change(screen.getByLabelText('定时任务名称'), { target: { value: '循环研究' } });
    fireEvent.change(screen.getByLabelText('定时处理方式'), { target: { value: 'agent-task' } });
    fireEvent.change(screen.getByLabelText('运行频率'), { target: { value: 'interval' } });
    fireEvent.change(screen.getByLabelText('运行间隔（分钟）'), { target: { value: '30' } });
    expect(screen.getByText(/循环执行及崩溃重试都可能重复调用并计费/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('创建后立即启用')); fireEvent.click(screen.getByRole('button', { name: '保存并启用定时' }));
    await screen.findByText('定时任务已启用，将使用固定版本运行。');
    expect(writes[0].body).toMatchObject({ inputVersion: plan.currentVersion, operation: 'agent-task', intervalMs: 30 * 60_000, enabled: true });
  });

  it('asks before resuming, pauses directly, and sends optimistic revisions', async () => {
    await ready(); fireEvent.click(screen.getByRole('button', { name: '启用定时' })); expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '返回' })); expect(screen.queryByRole('button', { name: '确认启用' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '启用定时' })); fireEvent.click(screen.getByRole('button', { name: '确认启用' }));
    await screen.findByRole('button', { name: '暂停定时' }); expect(writes[0].body).toEqual({ expectedRevision: 1, enabled: true });
    fireEvent.click(screen.getByRole('button', { name: '暂停定时' })); await screen.findByRole('button', { name: '启用定时' });
    expect(writes[1].body).toEqual({ expectedRevision: 2, enabled: false });
  });

  it('refreshes conflicted schedule state without losing an unrelated plan draft or retrying the mutation', async () => {
    await ready(); fillPlan(); responseError = { status: 409, message: 'revision_conflict' }; schedules = [{ ...schedule, state: 'enabled', revision: 2 }];
    fireEvent.click(screen.getByRole('button', { name: '启用定时' })); fireEvent.click(screen.getByRole('button', { name: '确认启用' }));
    expect((await screen.findByRole('alert')).textContent).toContain('定时任务已被其他操作修改');
    await screen.findByRole('button', { name: '暂停定时' }); expect(screen.getByLabelText('任务指令')).toHaveValue('按所选材料整理结论'); expect(writes).toHaveLength(1);
  });

  it('submits a plan once with a stable retry key and hands the run to the existing run view', async () => {
    const onRunCreated = vi.fn(); await ready({ onRunCreated }); responseError = { message: 'Network offline' };
    const start = screen.getByRole('button', { name: '执行 调研计划' }); fireEvent.click(start); fireEvent.click(start); await screen.findByRole('alert');
    expect(writes).toHaveLength(1); responseError = null; fireEvent.click(screen.getByRole('button', { name: '执行 调研计划' }));
    await waitFor(() => expect(onRunCreated).toHaveBeenCalledWith(run));
    expect(writes[0].body).toEqual(writes[1].body); expect(writes[0].body.operation).toBe('agent-task');
  });

  it('aborts reads on workspace navigation and ignores a late old response', async () => {
    const signals: AbortSignal[] = []; let resolveOld: (response: Response) => void = () => undefined;
    const c = createCloudWorkspaceClient(async (path, init) => {
      if (init.signal) signals.push(init.signal);
      if (path.includes('workspace-old') && path.endsWith('/task-plans')) return new Promise<Response>(resolve => { resolveOld = resolve; });
      if (path.endsWith('/task-plans')) return json({ plans: [{ ...plan, title: '新工作空间计划' }] });
      if (path.endsWith('/schedules')) return json({ schedules: [] });
      return json({ records: [] });
    });
    const p = props({ client: c, workspaceId: 'workspace-old' }); const view = render(<CloudTasks {...p} />);
    const oldSignals = signals.slice(); view.rerender(<CloudTasks {...p} workspaceId="workspace-new" />);
    await screen.findByRole('button', { name: '新工作空间计划' }); expect(oldSignals.every(signal => signal.aborted)).toBe(true);
    await act(async () => { resolveOld(json({ plans: [{ ...plan, title: '过时计划' }] })); });
    expect(screen.queryByRole('button', { name: '过时计划' })).not.toBeInTheDocument(); view.unmount(); expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});

describe('cloud task results and cancellation', () => {
  it('shows final output, safe tool traces, and each artifact as text', async () => {
    render(<CloudTaskRunDetail run={{ ...run, status: 'succeeded' }} client={client()} />);
    expect(await screen.findByTestId('task-final-text')).toHaveTextContent('<script>unsafe()</script>');
    expect(screen.getByTestId('task-run-detail').querySelector('script')).toBeNull();
    expect(screen.getByText('read_cloud_file')).toBeInTheDocument(); expect(screen.getByText('create_artifact · 工具错误')).toBeInTheDocument();
    expect(screen.getByText('调研结果.txt · 45 B')).toBeInTheDocument(); expect(screen.getByText('结论 <img src=x onerror=unsafe()>')).toBeInTheDocument();
    expect(screen.getByTestId('task-run-detail').querySelector('img')).toBeNull();
  });

  it('cancels only once, preserves history, and reports cancellation distinctly from failure', async () => {
    const onRunUpdated = vi.fn(); const c = client(); const view = render(<CloudTaskRunDetail run={run} client={c} onRunUpdated={onRunUpdated} />);
    const cancel = screen.getByRole('button', { name: '取消此运行' }); fireEvent.click(cancel); fireEvent.click(cancel);
    await waitFor(() => expect(onRunUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', error: 'cancelled' })));
    expect(writes).toHaveLength(1); expect(writes[0].path).toBe('/api/cloud/runs/run-1/cancel');
    view.rerender(<CloudTaskRunDetail run={{ ...run, status: 'failed', error: 'cancelled' }} client={c} onRunUpdated={onRunUpdated} />);
    expect(screen.getByText('此运行已取消。')).toBeInTheDocument(); expect(screen.queryByRole('button', { name: '取消此运行' })).not.toBeInTheDocument();
  });

  it('downloads artifact content as plain text and releases its object URL when leaving', async () => {
    const create = vi.fn((_blob: Blob) => 'blob:task-artifact'); const revoke = vi.fn();
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL'); const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    try {
      const view = render(<CloudTaskRunDetail run={{ ...run, status: 'succeeded' }} client={client()} />);
      expect(await screen.findByRole('link', { name: '下载此文本产物' })).toHaveAttribute('href', 'blob:task-artifact');
      expect(create.mock.calls[0][0].type).toBe('text/plain;charset=utf-8');
      view.unmount(); expect(revoke).toHaveBeenCalledWith('blob:task-artifact');
    } finally {
      if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor); else Reflect.deleteProperty(URL, 'createObjectURL');
      if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor); else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });

  it('does not show a previous run session after navigation even when its fetch ignores abort', async () => {
    let resolveOld: (response: Response) => void = () => undefined; const signals: AbortSignal[] = [];
    const c = createCloudWorkspaceClient(async (path, init) => { if (init.signal) signals.push(init.signal); if (path.includes('/run-1/')) return new Promise<Response>(resolve => { resolveOld = resolve; }); return json({ session: { ...session, runId: 'run-2', finalText: '新任务结果' } }); });
    const view = render(<CloudTaskRunDetail run={{ ...run, status: 'succeeded' }} client={c} />);
    view.rerender(<CloudTaskRunDetail run={{ ...run, id: 'run-2', status: 'succeeded' }} client={c} />); await screen.findByText('新任务结果');
    await act(async () => { resolveOld(json({ session })); });
    expect(screen.getByTestId('task-final-text')).toHaveTextContent('新任务结果'); expect(signals[0].aborted).toBe(true);
  });
});
