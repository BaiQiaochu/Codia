// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../settings/api', () => ({ codiaFetch: fetchMock }));
import { MemoryBudgetSettings } from '../../settings/overlays/MemoryBudgetSettings';
const totals = { calls: 1, knownTokens: 12, knownUsd: 0, pendingCalls: 0, unknownCostCalls: 1, reservedUsd: 0.1, reservedTokens: 120, until: '2030-01-01T00:00:00Z' };
const data = { policy: { completedExtractionDays: 30, ordinaryEventDays: 60 }, revision: 'policy1', budget: { config: { memoryDaily: { maxCalls: 5 } }, revision: 1, daily: totals, memoryDaily: totals, monthly: totals, pauses: [] }, report: { note: '受保护的收据不会删除', ordinaryEvents: 3, archivedEventReceipts: 1 } };
const response = (body: unknown = data, ok = true) => ({ ok, json: async () => body });
afterEach(cleanup);beforeEach(() => { fetchMock.mockReset(); fetchMock.mockResolvedValue(response()); });
async function open(props: Partial<React.ComponentProps<typeof MemoryBudgetSettings>> = {}) { const result = render(<MemoryBudgetSettings agentId="a" {...props} />); fireEvent.click(screen.getByText('后台记忆额度与历史保留')); await screen.findByText('保存后台额度'); return result; }
describe('MemoryBudgetSettings mutation boundary', () => {
  it('initial reads never acquire or release the parent mutation lock', async () => {
    const acquire = vi.fn(() => true), release = vi.fn();await open({ onAcquireMutation: acquire, onReleaseMutation: release });
    expect(acquire).not.toHaveBeenCalled();expect(release).not.toHaveBeenCalled();expect(screen.getByText(/未知费用 1 次/)).toBeTruthy();
  });
  it('acquires exactly once and releases on successful save; repeated clicks cannot duplicate', async () => {
    const acquire = vi.fn(() => true), release = vi.fn();await open({ onAcquireMutation: acquire, onReleaseMutation: release });
    let resolve!: (value: ReturnType<typeof response>) => void;fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByText('保存后台额度'));fireEvent.click(screen.getByText('保存后台额度'));
    expect(acquire).toHaveBeenCalledTimes(1);expect(release).not.toHaveBeenCalled();
    resolve(response({ ...data.budget, revision: 2 }));await screen.findByText('后台额度已保存。');expect(release).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ config: { memoryDaily: { maxCalls: 5 } }, expectedRevision: 1 });
  });
  it('releases after save failure and preserves editable values for retry', async () => {
    const acquire = vi.fn(() => true), release = vi.fn();await open({ onAcquireMutation: acquire, onReleaseMutation: release });
    fireEvent.change(screen.getByLabelText('成功提取明细保留天数'), { target: { value: '45' } });fetchMock.mockResolvedValueOnce(response({ error: 'stale revision' }, false));
    fireEvent.click(screen.getByText('保存保留策略'));await screen.findByText('stale revision');expect(release).toHaveBeenCalledTimes(1);expect((screen.getByLabelText('成功提取明细保留天数') as HTMLInputElement).value).toBe('45');
  });
  it('does not send a write when parent refuses the lock or until cleanup is confirmed', async () => {
    await open({ onAcquireMutation: () => false });fireEvent.click(screen.getByText('保存后台额度'));expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('按已保存策略整理'));expect(fetchMock).toHaveBeenCalledTimes(1);fireEvent.click(screen.getByText('取消'));expect(screen.queryByText('确认整理')).toBeNull();
  });
  it('does not let an earlier agent response overwrite a newly selected agent', async () => {
    let resolve!: (value: ReturnType<typeof response>) => void;fetchMock.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<MemoryBudgetSettings agentId="a" />);view.rerender(<MemoryBudgetSettings agentId="b" />);fireEvent.click(screen.getByText('后台记忆额度与历史保留'));
    await screen.findByText('当前普通事件 3 条 · 已归档幂等收据 1 条');resolve(response({ ...data, report: { ...data.report, ordinaryEvents: 999 } }));
    await waitFor(() => expect(screen.queryByText(/当前普通事件 999/)).toBeNull());
  });
});
