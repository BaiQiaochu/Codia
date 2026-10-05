import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = {
  currentSessionPath: 'session-a.jsonl',
  currentSessionId: 'sess-a',
  sessions: [
    { path: 'session-a.jsonl', sessionId: 'sess-a' },
    { path: 'session-child.jsonl', sessionId: 'sess-child' },
  ],
  sessionLocatorsById: {
    'sess-a': { path: 'session-a.jsonl' },
    'sess-child': { path: 'session-child.jsonl' },
  },
};

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => storeState,
  },
}));

vi.mock('../../hooks/use-stream-buffer', () => ({
  streamBufferManager: {
    clear: vi.fn(),
    finishTurn: vi.fn(),
  },
}));

vi.mock('../../stores/agent-actions', () => ({
  clearChat: vi.fn(),
}));

vi.mock('../../stores/session-actions', () => ({
  loadMessages: vi.fn(async () => {}),
}));

describe('stream resume websocket injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses an injected websocket getter when requesting stream resume', async () => {
    const sent: string[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn((payload: string) => sent.push(payload)),
    };
    const { injectWebSocketGetter, requestStreamResume } = await import('../../services/stream-resume');

    injectWebSocketGetter(() => ws as unknown as WebSocket);
    requestStreamResume('session-child.jsonl', { streamId: 'stream-1', sinceSeq: 12 });

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sent[0])).toEqual({
      type: 'resume_stream',
      sessionPath: 'session-child.jsonl',
      sessionId: 'sess-child',
      streamId: 'stream-1',
      sinceSeq: 12,
    });
  });

  it('accepts a sessionId-first ref when requesting stream resume', async () => {
    const sent: string[] = [];
    const ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn((payload: string) => sent.push(payload)),
    };
    const { injectWebSocketGetter, requestStreamResume } = await import('../../services/stream-resume');

    injectWebSocketGetter(() => ws as unknown as WebSocket);
    requestStreamResume({ sessionId: 'sess-child', sessionPath: 'stale-child.jsonl' }, { sinceSeq: 7 });

    expect(JSON.parse(sent[0])).toEqual({
      type: 'resume_stream',
      sessionPath: 'session-child.jsonl',
      sessionId: 'sess-child',
      streamId: null,
      sinceSeq: 7,
    });
  });
});
