// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ExecutionRunNotice } from '../../components/chat/ExecutionRunNotice';
import { publishExecutionRun } from '../../services/execution-run-events';
import type { ExecutionRunSnapshot } from '../../../../../shared/execution-run';

const mock = vi.hoisted(() => ({ fetch: vi.fn(), connection: { kind: 'local' } }));
vi.mock('../../hooks/use-codia-fetch', () => ({ codiaFetch: mock.fetch }));
vi.mock('../../hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../../stores', () => ({ useStore: (selector: any) => selector({ activeServerConnection: mock.connection }) }));
const snapshot = (): ExecutionRunSnapshot => ({
  schemaVersion: 1, runId: 'fixture', revision: 3, grants: 1, status: 'paused', reason: 'model_limit',
  used: { modelCalls: 128, toolCalls: 20, activeMs: 1000 },
  limits: { modelCalls: 128, toolCalls: 512, activeMs: 3600000 },
  startedAt: 1, updatedAt: 3, pendingTools: [], pendingTasks: [],
});
beforeEach(() => { mock.fetch.mockReset(); mock.fetch.mockResolvedValue({ json: async () => ({ run: snapshot() }) }); });
afterEach(cleanup);

it('loads status without resuming, ignores old replay, and disables duplicate continuation', async () => {
  render(<ExecutionRunNotice sessionPath="/fixture" />);
  await screen.findByText('runControl.paused');
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  act(() => publishExecutionRun('/fixture', { ...snapshot(), revision: 2, status: 'completed' }));
  expect(screen.getByText('runControl.paused')).toBeTruthy();
  let finish: (value: unknown) => void;
  mock.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const resume = screen.getByRole('button', { name: 'runControl.continue' });
  fireEvent.click(resume); fireEvent.click(resume);
  expect(mock.fetch).toHaveBeenCalledTimes(2);
  expect((resume as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { finish!({ json: async () => ({ run: { ...snapshot(), revision: 4, status: 'running' } }) }); });
  await waitFor(() => expect(screen.queryByText('runControl.paused')).toBeNull());
});

it('requires explicit result review and preserves an actionable error on rejection', async () => {
  mock.fetch.mockResolvedValueOnce({ json: async () => ({ run: { ...snapshot(), status: 'needs_attention',
    reason: 'unknown_write', pendingTools: [{ id: 'write-1', name: 'write', write: true }] } }) });
  render(<ExecutionRunNotice sessionPath="/fixture" />);
  await screen.findByText('runControl.needs_attention');
  const acknowledge = screen.getByRole('button', { name: 'runControl.acknowledge', hidden: true });
  expect((acknowledge as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { hidden: true }));
  mock.fetch.mockRejectedValueOnce(new Error('conflict'));
  fireEvent.click(acknowledge);
  expect((await screen.findByRole('alert')).textContent).toContain('runControl.actionFailed');
});
