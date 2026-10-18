// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../hooks/use-codia-fetch', () => ({ codiaFetch: mocks.fetch }));
import { ToolActionLedgerPanel } from './ToolActionLedgerPanel';
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('read-only action recovery inspection', () => {
  it('loads only on request, shows unknown writes and opens their original session without replay', async () => {
    const openSession = vi.fn(async () => {});
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ total: 1, unreadableCount: 0, actions: [{ actionId: 'action_1', toolName: 'notify', state: 'unknown', readOnly: false, sessionPath: '/original', traceId: 'trace_1' }] }) });
    render(<ToolActionLedgerPanel openSession={openSession} />);
    expect(mocks.fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('检查工具动作记录'));
    expect(await screen.findByText(/notify · 结果未知，禁止自动重发/)).toBeTruthy();
    fireEvent.click(screen.getByText('打开动作原会话'));
    await waitFor(() => expect(openSession).toHaveBeenCalledWith('/original'));
    expect(mocks.fetch.mock.calls).toEqual([['/api/tool-actions']]);
    expect(screen.queryByRole('button', { name: /重试|重新发送|取消/ })).toBeNull();
  });
  it('surfaces corruption and missing sessions without claiming success or creating alternatives', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ total: 2, unreadableCount: 1, actions: [{ actionId: 'a', toolName: 'write', state: 'running', readOnly: false, sessionPath: null }] }) });
    render(<ToolActionLedgerPanel openSession={vi.fn()} />);
    fireEvent.click(screen.getByText('检查工具动作记录'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('无法读取'));
    expect(screen.getByText(/原会话不可用/)).toBeTruthy();
    expect(screen.queryByText('打开动作原会话')).toBeNull();
  });
  it('reports read errors instead of a successful empty result', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 503 });
    render(<ToolActionLedgerPanel openSession={vi.fn()} />);
    fireEvent.click(screen.getByText('检查工具动作记录'));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('503'));
    expect(screen.queryByText('尚无可检查的工具动作。')).toBeNull();
  });
});
