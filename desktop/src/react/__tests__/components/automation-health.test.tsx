// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { fetchMock, state, switchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(), switchMock: vi.fn(),
  state: { agents: [{ id: 'owner', name: 'Owner', isPrimary: true }], currentAgentId: 'owner', agentName: 'Codia', agentYuan: 'codia', sessions: [], addToast: vi.fn() },
}));
vi.mock('../../stores', () => ({ useStore: Object.assign((fn: (s: typeof state) => unknown) => fn(state), { setState: vi.fn(), getState: () => state }) }));
vi.mock('../../hooks/use-codia-fetch', () => ({ codiaFetch: fetchMock, codiaUrl: (p: string) => p }));
vi.mock('../../stores/session-actions', () => ({ switchSession: switchMock }));
vi.mock('../../ui', () => ({ Collapse: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? children : null, SelectWidget: () => null }));
import { AutomationJobsSection } from '../../components/automation/AutomationJobsSection';
const jobs = ['one', 'two'].map(id => ({ id, label: `Job ${id}`, prompt: `Prompt ${id}`, schedule: 60_000, type: 'every', enabled: true, actorAgentId: 'owner', timezone: 'Asia/Shanghai' }));
beforeEach(() => {
  fetchMock.mockReset(); switchMock.mockReset();
  window.t = (key: string) => key;
  fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url === '/api/models' ? { models: [] } : url.includes('/health') ? { status: 'success', history: [], requiresReview: false, job: jobs[0] } : { jobs } }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('automation health UI', () => {
  it('preserves unsaved edits while refreshing all jobs and saving a different job', async () => {
    render(<AutomationJobsSection />);
    fireEvent.click(await screen.findByText('Job one'));
    fireEvent.click(screen.getByText('Job two'));
    const prompts = screen.getAllByRole('textbox').filter(el => el.tagName === 'TEXTAREA');
    fireEvent.change(prompts[0], { target: { value: 'Unsaved local prompt' } });
    fireEvent.change(prompts[1], { target: { value: 'Saved other prompt' } });
    fireEvent.click(screen.getAllByText('common.confirm')[1]);
    fireEvent.click(screen.getByRole('button', { name: '刷新计划' }));
    await waitFor(() => expect((prompts[0] as HTMLTextAreaElement).value).toBe('Unsaved local prompt'));
  });
  it('shows read errors separately, retains good jobs and retries without treating failure as empty', async () => {
    let fail = false;
    fetchMock.mockImplementation(async (url: string) => { if (url === '/api/desk/cron' && fail) throw new Error('synthetic unavailable'); return { ok: true, json: async () => url === '/api/models' ? { models: [] } : { jobs } }; });
    render(<AutomationJobsSection />);
    await screen.findByText('Job one');
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新计划' }));
    expect(await screen.findByText(/synthetic unavailable/)).toBeTruthy();
    expect(screen.getByText('Job one')).toBeTruthy();
    expect(screen.queryByText('automation.empty')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '刷新计划' }));
    await waitFor(() => expect(screen.queryByText(/synthetic unavailable/)).toBeNull());
  });
  it('requires review for unknown results, submits once on rapid clicks and reads the original session', async () => {
    let release!: (value: unknown) => void;
    const health = { status: 'unknown', history: [{ status: 'success', activityId: 'result-activity', timestamp: '2026-10-19T10:00:00Z' }], requiresReview: true, reviewKey: 'prior-request', job: jobs[0] };
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') return new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => url === '/api/models' ? { models: [] } : url.includes('/health') ? health : url.includes('/session') ? { messages: [{ role: 'assistant', content: 'Original synthetic result' }] } : { jobs } };
    });
    render(<AutomationJobsSection />);
    fireEvent.click(await screen.findByText('Job one'));
    await screen.findByText('结果未知');
    fireEvent.click(screen.getByRole('button', { name: '查看原结果会话' }));
    expect(await screen.findByText('Original synthetic result')).toBeTruthy();
    expect(switchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '试跑一次' }));
    const confirm = screen.getByRole('button', { name: '确认试跑一次' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /已核对/ }));
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
    const payload = JSON.parse(fetchMock.mock.calls.find(([, opts]) => opts?.method === 'POST')![1].body);
    expect(payload).toMatchObject({ action: 'run-now', reviewedRunKey: 'prior-request' });
    expect(payload.requestId).toBeTruthy();
    await act(async () => release({ ok: true, json: async () => ({ ok: true, receipt: { status: 'claimed' } }) }));
  });
  it('automatically refreshes health while preserving unsaved fields and never dispatches on a timer', async () => {
    vi.useFakeTimers();
    let status = 'running';
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url === '/api/models' ? { models: [] } : url.includes('/health') ? { status, history: [], requiresReview: false, running: status === 'running' } : { jobs: jobs.map(job => ({ ...job })) } }));
    render(<AutomationJobsSection />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByText('Job one'));
    await act(async () => { await Promise.resolve(); });
    const prompt = screen.getByDisplayValue('Prompt one');
    fireEvent.change(prompt, { target: { value: 'Keep me on refresh' } });
    expect(screen.getByText('正在执行')).toBeTruthy();
    status = 'success';
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText('执行成功')).toBeTruthy();
    expect((prompt as HTMLTextAreaElement).value).toBe('Keep me on refresh');
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(0);
  });

  it('does not silently retry a disconnected manual request; cancel cannot dispatch', async () => {
    let healthCalls = 0;
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') throw new Error('connection lost');
      if (url.includes('/health')) healthCalls += 1;
      return { ok: true, json: async () => url === '/api/models' ? { models: [] } : url.includes('/health') ? { status: 'never', history: [], requiresReview: false } : { jobs } };
    });
    render(<AutomationJobsSection />);
    fireEvent.click(await screen.findByText('Job one'));
    await screen.findByText('尚无运行记录');
    fireEvent.click(screen.getByRole('button', { name: '试跑一次' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: '试跑一次' }));
    fireEvent.click(screen.getByRole('button', { name: '确认试跑一次' }));
    await screen.findByText(/请求结果未确认/);
    expect((screen.getByRole('button', { name: '确认试跑一次' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新运行记录' }));
    await waitFor(() => expect(healthCalls).toBeGreaterThan(2));
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
  });

  it('does not show an empty list after a malformed first response', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url === '/api/models' ? { models: [] } : { error: 'unavailable' } }));
    render(<AutomationJobsSection />);
    expect(await screen.findByText(/计划读取失败/)).toBeTruthy();
    expect(screen.queryByText('automation.empty')).toBeNull();
    expect(screen.queryByText('automation.emptyForAgent')).toBeNull();
  });

  it('retries only failed run history without clearing jobs or unsaved input', async () => {
    let fail = true;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/health') && fail) throw new Error('history unavailable');
      return { ok: true, json: async () => url === '/api/models' ? { models: [] } : url.includes('/health') ? { status: 'success', history: [], requiresReview: false } : { jobs } };
    });
    render(<AutomationJobsSection />);
    fireEvent.click(await screen.findByText('Job one'));
    const prompt = screen.getByDisplayValue('Prompt one');
    fireEvent.change(prompt, { target: { value: 'Keep failed-history draft' } });
    await screen.findByText(/history unavailable/);
    expect(screen.queryByText('没有已保留的运行记录。')).toBeNull();
    const cronReads = fetchMock.mock.calls.filter(([url]) => url === '/api/desk/cron').length;
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '刷新运行记录' }));
    await screen.findByText('执行成功');
    expect((prompt as HTMLTextAreaElement).value).toBe('Keep failed-history draft');
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/desk/cron')).toHaveLength(cronReads);
  });

  it('labels a recovered claimed slot as scheduled time while execution time remains unknown', async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => url === '/api/models' ? { models: [] } : url.includes('/health') ? { status: 'unknown', history: [{ status: 'claimed', scheduledAt: '2026-10-19T10:00:00Z' }], requiresReview: true } : { jobs } }));
    render(<AutomationJobsSection />);
    fireEvent.click(await screen.findByText('Job one'));
    expect(await screen.findByText(/执行时间未知 · 计划时间：/)).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(0);
  });

  it('preserves edits made while saving, including a changed schedule and a field reverted to its original value', async () => {
    let release!: (value: unknown) => void;
    let storedJobs = jobs.map(job => ({ ...job }));
    let submitted: Record<string, unknown> = {};
    let saves = 0;
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        submitted = JSON.parse(String(opts.body)); saves++;
        if (saves === 1) return new Promise(resolve => { release = resolve; });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => url === '/api/models' ? { models: [] } : url.includes('/health') ? { status: 'success', history: [], requiresReview: false } : { jobs: storedJobs.map(job => ({ ...job })) } };
    });
    render(<AutomationJobsSection />); fireEvent.click(await screen.findByText('Job one'));
    const interval = screen.getByRole('spinbutton') as HTMLInputElement;
    const label = screen.getByLabelText('automation.field.label') as HTMLInputElement;
    const prompt = screen.getByDisplayValue('Prompt one') as HTMLTextAreaElement;
    fireEvent.change(interval, { target: { value: '2' } });
    fireEvent.change(label, { target: { value: 'Submitted title' } });
    fireEvent.change(prompt, { target: { value: 'Submitted prompt' } });
    fireEvent.click(screen.getByText('common.confirm'));
    expect(submitted).toMatchObject({ schedule: '2', label: 'Submitted title', prompt: 'Submitted prompt' });
    fireEvent.change(interval, { target: { value: '3' } });
    fireEvent.change(label, { target: { value: 'Job one' } });
    fireEvent.change(prompt, { target: { value: 'Later unsaved prompt' } });
    storedJobs = [{ ...storedJobs[0], schedule: 120_000, label: 'Submitted title', prompt: 'Submitted prompt' }, storedJobs[1]];
    await act(async () => release({ ok: true, json: async () => ({ ok: true }) }));
    fireEvent.click(screen.getByRole('button', { name: '刷新计划' }));
    await waitFor(() => expect(interval.value).toBe('3'));
    expect(label.value).toBe('Job one'); expect(prompt.value).toBe('Later unsaved prompt');
    expect((screen.getByText('common.confirm') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '试跑一次' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText('common.confirm'));
    await waitFor(() => expect(saves).toBe(2));
    expect(submitted).toMatchObject({ schedule: '3', label: 'Job one', prompt: 'Later unsaved prompt' });
  });

});
