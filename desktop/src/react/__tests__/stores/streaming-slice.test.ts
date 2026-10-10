import { beforeEach, describe, expect, it } from 'vitest';
import { createStreamingSlice, type StreamingSlice } from '../../stores/streaming-slice';

function makeSlice(): StreamingSlice {
  let state: StreamingSlice & Record<string, unknown>;
  const set = (partial: Partial<StreamingSlice> | ((s: StreamingSlice) => Partial<StreamingSlice>)) => {
    const patch = typeof partial === 'function' ? partial(state as StreamingSlice) : partial;
    state = { ...state, ...patch };
  };
  state = createStreamingSlice(set, () => state as StreamingSlice) as StreamingSlice & Record<string, unknown>;
  return new Proxy({} as StreamingSlice, {
    get: (_, key: string) => (state as unknown as Record<string, unknown>)[key],
    set: (_, key: string, value: unknown) => {
      state = { ...state, [key]: value };
      return true;
    },
  });
}

describe('streaming-slice', () => {
  let slice: StreamingSlice;

  beforeEach(() => {
    slice = makeSlice();
  });

  it('tracks path-keyed streaming sessions without a locator', () => {
    expect(slice.streamingSessions).toEqual([]);

    slice.addStreamingSession('/s1');
    slice.addStreamingSession('/s2');
    expect(slice.streamingSessions).toEqual(['/s1', '/s2']);

    expect(slice.removeStreamingSession('/s1')).toBe(true);
    expect(slice.streamingSessions).toEqual(['/s2']);
  });

  it('handles missing streamingSessions defensively', () => {
    (slice as unknown as { streamingSessions: unknown }).streamingSessions = undefined;

    slice.addStreamingSession('/s1');
    expect(slice.streamingSessions).toEqual(['/s1']);

    (slice as unknown as { streamingSessions: unknown }).streamingSessions = undefined;
    expect(slice.removeStreamingSession('/s1')).toBe(false);
    expect(slice.streamingSessions).toEqual([]);
  });

  it('known locator streaming state uses sessionId key and guards stale completion events', () => {
    (slice as unknown as Record<string, unknown>).currentSessionId = 'sess_1';
    (slice as unknown as Record<string, unknown>).currentSessionPath = '/s1';
    (slice as unknown as Record<string, unknown>).sessions = [{ path: '/s1', sessionId: 'sess_1' }];
    (slice as unknown as Record<string, unknown>).sessionLocatorsById = { sess_1: { path: '/s1' } };

    slice.addStreamingSession('/s1', { streamId: 'stream_1', turnId: 'turn_1' });
    expect(slice.streamingSessions).toEqual(['sess_1']);
    expect(slice.activeSessionStreams).toEqual({
      sess_1: { streamId: 'stream_1', turnId: 'turn_1' },
    });

    expect(slice.removeStreamingSession('/s1', { streamId: 'other', turnId: 'turn_1' })).toBe(false);
    expect(slice.streamingSessions).toEqual(['sess_1']);

    expect(slice.removeStreamingSession('/s1', { streamId: 'stream_1', turnId: 'turn_1' })).toBe(true);
    expect(slice.streamingSessions).toEqual([]);
    expect(slice.activeSessionStreams).toEqual({});
  });
});
