// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkflowRecoveryPanel } from './WorkflowRecoveryPanel';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { requestInputDraft } from '../utils/input-draft-events';
import { switchSession } from '../stores/session-actions';
vi.mock('../hooks/use-codia-fetch', () => ({ codiaFetch: vi.fn() }));
vi.mock('../utils/input-draft-events', () => ({ requestInputDraft: vi.fn() }));
vi.mock('../stores/session-actions', () => ({ switchSession: vi.fn(async () => {}) }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
it('disables unsafe recovery and opens original evidence session', async () => {
  vi.mocked(codiaFetch).mockResolvedValue(response({ canPrepare: false, blockedReason: 'unknown external result', sessionPath: '/original', actions: [{ nodeSeq: 1, actionId: 'run:1', access: 'write', status: 'unknown' }] }));
  render(<WorkflowRecoveryPanel runId="run" onPrepared={() => {}} />);
  await waitFor(() => expect(screen.getByText('准备恢复草稿')).toBeDisabled());
  expect(screen.getByText(/结果未确认，先检查外部结果/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('打开原会话检查结果'));
  await waitFor(() => expect(switchSession).toHaveBeenCalledWith('/original'));
  expect(requestInputDraft).not.toHaveBeenCalled();
});
it('shows the cumulative budget blocker and cannot prepare a reset-budget recovery', async () => {
  const blockedReason = 'Cumulative workflow budget accounting cannot be safely restored for budgetTokens, maxSteps or maxDurationMs. Check prior usage and external effects, then review a new run and budget; checkpoint recovery is disabled.';
  vi.mocked(codiaFetch).mockResolvedValue(response({ canPrepare: false, blockedReason, sessionPath: '/original', actions: [] }));
  render(<WorkflowRecoveryPanel runId="budgeted-run" onPrepared={() => {}} />);
  expect(await screen.findByText(blockedReason)).toBeInTheDocument();
  const prepare = screen.getByText('准备恢复草稿');
  expect(prepare).toBeDisabled();
  fireEvent.click(prepare);
  expect(codiaFetch).toHaveBeenCalledTimes(1);
  expect(requestInputDraft).not.toHaveBeenCalled();
});
it('prepares a reviewed draft only after switching to the original session', async () => {
  vi.mocked(codiaFetch).mockResolvedValueOnce(response({ canPrepare: true, blockedReason: null, sessionPath: '/original', actions: [] })).mockResolvedValueOnce(response({ draft: 'exact recovery definition', sessionPath: '/original' }));
  const prepared = vi.fn();
  render(<WorkflowRecoveryPanel runId="run" onPrepared={prepared} />);
  await waitFor(() => expect(screen.getByText('准备恢复草稿')).toBeEnabled());
  fireEvent.click(screen.getByText('准备恢复草稿'));
  await waitFor(() => expect(requestInputDraft).toHaveBeenCalledWith(expect.objectContaining({ text: 'exact recovery definition', mode: 'append' })));
  expect(switchSession).toHaveBeenCalledWith('/original');
  expect(prepared).toHaveBeenCalledOnce();
});
it('requires explicit abandonment confirmation', async () => {
  vi.mocked(codiaFetch).mockResolvedValueOnce(response({ canPrepare: true, blockedReason: null, sessionPath: '/original', actions: [] })).mockResolvedValueOnce(response({ ok: true, note: 'cancelled' }));
  render(<WorkflowRecoveryPanel runId="run" onPrepared={() => {}} />);
  await screen.findByText('放弃此检查点恢复');
  fireEvent.click(screen.getByText('放弃此检查点恢复'));
  expect(codiaFetch).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('确认放弃恢复'));
  await waitFor(() => expect(codiaFetch).toHaveBeenCalledWith('/api/workflow-recovery/run/cancel', { method: 'POST' }));
});
it('refreshes recovery for the same run without clearing an open confirmation', async () => {
  vi.mocked(codiaFetch).mockResolvedValueOnce(response({ canPrepare: false, blockedReason: 'still running', actions: [] }))
    .mockResolvedValueOnce(response({ canPrepare: true, blockedReason: null, actions: [] }));
  const view = render(<WorkflowRecoveryPanel runId="r" refreshToken={0} onPrepared={() => {}} />);
  await screen.findByText('still running'); fireEvent.click(screen.getByText('放弃此检查点恢复'));
  view.rerender(<WorkflowRecoveryPanel runId="r" refreshToken={1} onPrepared={() => {}} />);
  await waitFor(() => expect(screen.getByText('准备恢复草稿')).toBeEnabled());
  expect(screen.getByText('确认放弃恢复')).toBeInTheDocument();
});
it('ignores late reads after switching runs and provides local read retry', async () => {
  let old: (v: Response) => void = () => {};
  vi.mocked(codiaFetch).mockImplementationOnce(() => new Promise(r => { old = r; }))
    .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'temporarily unavailable' }) } as Response)
    .mockResolvedValueOnce(response({ canPrepare: false, blockedReason: 'new run unknown effects', actions: [] }));
  const view = render(<WorkflowRecoveryPanel runId="old" onPrepared={() => {}} />);
  view.rerender(<WorkflowRecoveryPanel runId="new" onPrepared={() => {}} />);
  await screen.findByRole('alert'); fireEvent.click(screen.getByText('刷新恢复记录'));
  await screen.findByText('new run unknown effects'); old(response({ canPrepare: true, blockedReason: null, actions: [] }));
  await waitFor(() => expect(screen.getByText('准备恢复草稿')).toBeDisabled());
});
