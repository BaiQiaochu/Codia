// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: vi.fn(), agentId: 'alpha' }));
vi.mock('../store', () => {
  const useSettingsStore = Object.assign(() => ({ showToast: mocks.toast }), { getState: () => ({ getSettingsAgentId: () => mocks.agentId }) });
  return { useSettingsStore };
});
vi.mock('../api', () => ({ codiaFetch: mocks.fetch }));
vi.mock('../helpers', () => ({ t: (value: string) => value }));
import { ClearMemoryConfirm } from './ClearMemoryConfirm';
const open = () => { render(<ClearMemoryConfirm />); act(() => { window.dispatchEvent(new Event('codia-show-clear-confirm')); }); };
beforeEach(() => { mocks.agentId = 'alpha'; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('clear-memory confirmation', () => {
  it('explains scope and retention, and cancel sends nothing', () => {
    open(); expect(screen.getByText(/原始聊天和独立置顶内容仍保留/)).toBeTruthy();
    fireEvent.click(screen.getByText('settings.memory.actions.cancel'));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('locks repeated clicks and keeps the originally confirmed agent scope', async () => {
    let resolve!: (value: unknown) => void;
    mocks.fetch.mockImplementation(() => new Promise(res => { resolve = res; }));
    open(); mocks.agentId = 'beta';
    fireEvent.click(screen.getByText('settings.memory.actions.confirmClear'));
    fireEvent.click(screen.getByText('settings.memory.actions.confirmClear'));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch).toHaveBeenCalledWith('/api/memories?agentId=alpha', { method: 'DELETE' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => { resolve({ json: async () => ({ ok: true }) }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.toast).toHaveBeenCalledWith('settings.memory.actions.clearSuccess', 'success');
  });
  it('keeps failures visible and never reports uncertain deletion as success', async () => {
    mocks.fetch.mockRejectedValue(new Error('timeout'));
    open(); fireEvent.click(screen.getByText('settings.memory.actions.confirmClear'));
    expect((await screen.findByRole('alert')).textContent).toContain('结果未确认');
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(mocks.toast).not.toHaveBeenCalled();
  });
});
