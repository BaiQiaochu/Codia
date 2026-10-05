import { describe, expect, it } from 'vitest';
import type { ChatListItem } from '../../../stores/chat-types';
import { buildTimelineAnchors } from '../timeline-anchors';

describe('buildTimelineAnchors malformed item tolerance', () => {
  it('ignores malformed items instead of throwing', () => {
    const items = [
      { type: 'message', data: null },
      null,
      {
        type: 'message',
        data: {
          id: 'user-1',
          role: 'user',
          text: 'hello',
          timestamp: 1,
        },
      },
      { type: 'message', data: { id: '', role: 'assistant' } },
    ] as unknown as ChatListItem[];

    expect(() => buildTimelineAnchors(items)).not.toThrow();
    expect(buildTimelineAnchors(items)).toEqual([
      expect.objectContaining({
        messageId: 'user-1',
        role: 'user',
        label: 'hello',
      }),
    ]);
  });
});
