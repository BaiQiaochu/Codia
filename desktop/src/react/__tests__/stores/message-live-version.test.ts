import { afterEach, describe, expect, it } from 'vitest';

import {
  bumpMessageLiveVersion,
  clearMessageLiveVersion,
  configureMessageLiveVersionSessionKeyResolver,
  readMessageLiveVersion,
} from '../../stores/message-live-version';

describe('message live version session identity', () => {
  afterEach(() => {
    configureMessageLiveVersionSessionKeyResolver(null);
    clearMessageLiveVersion();
  });

  it('keys live versions by session id while reading by path', () => {
    configureMessageLiveVersionSessionKeyResolver((sessionPath) => (
      sessionPath === '/sessions/a.jsonl' ? 'sess_a' : null
    ));

    expect(bumpMessageLiveVersion('/sessions/a.jsonl')).toBe(1);
    expect(readMessageLiveVersion('/sessions/a.jsonl')).toBe(1);

    clearMessageLiveVersion('/sessions/a.jsonl');
    expect(readMessageLiveVersion('/sessions/a.jsonl')).toBe(0);
  });
});
