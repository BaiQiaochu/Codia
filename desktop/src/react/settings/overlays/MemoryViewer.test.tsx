// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), open: vi.fn() }));
vi.mock('../store', () => ({ useSettingsStore: { getState: () => ({ getSettingsAgentId: () => 'alpha' }) } }));
vi.mock('../api', () => ({ codiaFetch: mocks.fetch }));
vi.mock('../helpers', () => ({ t: (value: string) => value }));
import { MemoryViewer } from './MemoryViewer';
const memory = { id: 1, fact: 'Original evidence', updated_at: '2026-10-01T00:00:00Z', source: 'session:s1', status: 'active' };
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const openViewer = () => { render(<MemoryViewer />); window.dispatchEvent(new Event('codia-view-memories')); };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('memory evidence and correction UI', () => {
  it('opens verified same-agent source via existing desktop session navigation', async () => {
    Object.assign(window, { codia: { quickChatOpenSession: mocks.open } });
    mocks.fetch.mockImplementation(async (url: string) => response(url === '/api/sessions' ? [{ sessionId: 's1', path: '/alpha/source.jsonl', agentId: 'alpha' }] : { memories: [memory] }));
    openViewer();
    fireEvent.click(await screen.findByText('打开来源会话'));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith('/alpha/source.jsonl'));
  });
  it('sends correction with original timestamp and requires explicit delete confirmation', async () => {
    mocks.fetch.mockImplementation(async (_url: string, options?: { method: string }) => response(options?.method === 'PATCH' ? { memory: { ...memory, fact: 'Corrected evidence' } } : options?.method === 'DELETE' ? { ok: true } : { memories: [memory] }));
    openViewer();
    fireEvent.click(await screen.findByText('纠错'));
    fireEvent.change(screen.getByLabelText('纠正事实'), { target: { value: 'Corrected evidence' } });
    fireEvent.click(screen.getByText('保存纠错'));
    await screen.findByText('Corrected evidence');
    expect(JSON.parse(mocks.fetch.mock.calls.find(([, opts]) => opts?.method === 'PATCH')![1].body)).toEqual({ fact: 'Corrected evidence', status: 'active', expectedUpdatedAt: memory.updated_at });
    fireEvent.click(screen.getByText('删除'));
    expect(mocks.fetch.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByText('确认删除'));
    await waitFor(() => expect(screen.queryByText('Corrected evidence')).toBeNull());
  });
  it('shows concurrent edit conflict and keeps draft for review', async () => {
    mocks.fetch.mockImplementation(async (_url: string, options?: { method: string }) => options?.method === 'PATCH' ? response({ error: 'conflict', current: { ...memory, fact: 'Concurrent edit', updated_at: 'new' } }, 409) : response({ memories: [memory] }));
    openViewer();
    fireEvent.click(await screen.findByText('纠错'));
    fireEvent.change(screen.getByLabelText('纠正事实'), { target: { value: 'My correction' } });
    fireEvent.click(screen.getByText('保存纠错'));
    expect((await screen.findByRole('alert')).textContent).toContain('已被更新');
    expect((screen.getByLabelText('纠正事实') as HTMLTextAreaElement).value).toBe('My correction');
  });
  it('does not navigate to another agent with matching session ID', async () => {
    Object.assign(window, { codia: { quickChatOpenSession: mocks.open } });
    mocks.fetch.mockImplementation(async (url: string) => response(url === '/api/sessions' ? [{ sessionId: 's1', path: '/beta/private', agentId: 'beta' }] : { memories: [memory] }));
    openViewer();
    fireEvent.click(await screen.findByText('打开来源会话'));
    expect((await screen.findByRole('alert')).textContent).toContain('不可用');
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
