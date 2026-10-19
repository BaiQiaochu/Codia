// @ts-nocheck
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../hub/scheduler.ts';
afterEach(() => vi.useRealTimers());
describe('automation original result references', () => {
  it('returns exact original activity/session on success and failure without reusing same-millisecond IDs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    const entries = [];
    const engine = {
      agentsDir: '/synthetic/agents',
      executeIsolated: vi.fn().mockResolvedValueOnce({ sessionPath: '/synthetic/one.jsonl' }).mockResolvedValueOnce({ sessionPath: '/synthetic/two.jsonl', error: 'synthetic failure' }),
      getAgent: () => ({ agentName: 'Synthetic' }),
      summarizeActivity: vi.fn(async () => 'Synthetic result'),
      getActivityStore: () => ({ add: entry => entries.push(entry) }),
      emitDevLog: vi.fn(),
    };
    const scheduler = new Scheduler({ hub: { engine, eventBus: { emit: vi.fn() } } });
    const result = await scheduler._executeCronJobForAgent('owner', { id: 'one', label: 'One', prompt: 'synthetic' });
    expect(result).toMatchObject({ activityId: entries[0].id, sessionPath: '/synthetic/one.jsonl' });
    await expect(scheduler._executeCronJobForAgent('owner', { id: 'two', label: 'Two', prompt: 'synthetic' })).rejects.toMatchObject({ runDetails: { activityId: expect.any(String), sessionPath: '/synthetic/two.jsonl' } });
    expect(entries[0].id).not.toBe(entries[1].id);
    expect(entries.map(entry => entry.sessionFile)).toEqual(['one.jsonl', 'two.jsonl']);
  });
});
