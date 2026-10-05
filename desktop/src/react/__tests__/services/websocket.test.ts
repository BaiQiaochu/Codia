import { describe, expect, it } from 'vitest';

import { resolveStreamingSessionResumeTargets } from '../../services/websocket';

describe('websocket session resume targets', () => {
  it('resolves sessionId-keyed streaming state back to current locators', () => {
    expect(resolveStreamingSessionResumeTargets({
      streamingSessions: ['sess_a', '/legacy.jsonl', 'sess_missing'],
      sessionLocatorsById: {
        sess_a: { path: '/sessions/a.jsonl' },
        sess_missing: { path: null },
      },
    })).toEqual(['/sessions/a.jsonl', '/legacy.jsonl']);
  });
});
