import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';

describe('runtime timeline slice', () => {
  beforeEach(() => {
    useStore.setState({
      runtimeTimelineByTrace: {},
      runtimeTimelineTraceIdsBySession: {},
    });
  });

  it('creates a trace and indexes it by session', () => {
    useStore.getState().upsertRuntimeTimelineEvent({
      id: 'trace-1:queued',
      turnTraceId: 'trace-1',
      sessionPath: 'sessions/a.jsonl',
      type: 'queued',
      label: 'Queued',
      status: 'success',
      startedAt: '2026-05-21T00:00:00.000Z',
    });

    expect(useStore.getState().runtimeTimelineByTrace['trace-1']).toMatchObject({
      turnTraceId: 'trace-1',
      sessionPath: 'sessions/a.jsonl',
      status: 'running',
    });
    expect(useStore.getState().runtimeTimelineTraceIdsBySession['sessions/a.jsonl']).toEqual(['trace-1']);
  });

  it('marks failed traces failed and keeps failure rows visible', () => {
    const state = useStore.getState();
    state.upsertRuntimeTimelineEvent({
      id: 'trace-2:thinking',
      turnTraceId: 'trace-2',
      sessionPath: 'sessions/a.jsonl',
      type: 'thinking',
      label: 'Thinking',
      status: 'running',
      startedAt: '2026-05-21T00:00:00.000Z',
    });
    state.upsertRuntimeTimelineEvent({
      id: 'trace-2:failed',
      turnTraceId: 'trace-2',
      sessionPath: 'sessions/a.jsonl',
      type: 'failed',
      label: 'Failed',
      status: 'error',
      startedAt: '2026-05-21T00:00:01.000Z',
      details: { message: 'model error' },
    });

    const trace = useStore.getState().runtimeTimelineByTrace['trace-2'];
    expect(trace.status).toBe('failed');
    expect(trace.events.map(event => event.type)).toEqual(['thinking', 'failed']);
  });
});
