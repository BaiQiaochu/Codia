import { describe, expect, it } from 'vitest';
import {
  SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT,
  readScreenshotSegmentVisibleCharLimit,
  splitScreenshotMessages,
} from '../../utils/screenshot-segments';
import type { ChatMessage } from '../../stores/chat-types';

function user(id: string, text: string): ChatMessage {
  return { id, role: 'user', text };
}

function assistant(id: string, html: string): ChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', html }] };
}

describe('splitScreenshotMessages', () => {
  it('defaults to 10000 visible characters per screenshot segment', () => {
    expect(SCREENSHOT_SEGMENT_VISIBLE_CHAR_LIMIT).toBe(10_000);
    expect(readScreenshotSegmentVisibleCharLimit({
      getItem: () => null,
    } as unknown as Storage)).toBe(10_000);
  });

  it('uses the G-SAP storage key and clamps custom limits', () => {
    const storage = {
      getItem: (key: string) => key === 'gsap-screenshot-segment-char-limit' ? '500' : null,
    } as unknown as Storage;

    expect(readScreenshotSegmentVisibleCharLimit(storage)).toBe(1_000);
  });

  it('splits by visible text budget while keeping full conversation rounds together', () => {
    const messages = [
      user('u1', 'aaaa'),
      assistant('a1', '<p>bbbb</p>'),
      user('u2', 'cccc'),
      assistant('a2', '<p>dddd</p>'),
      user('u3', 'eeee'),
      assistant('a3', '<p>ffff</p>'),
    ];

    const chunks = splitScreenshotMessages(messages, 12);

    expect(chunks.map(chunk => chunk.map(message => message.id))).toEqual([
      ['u1', 'a1'],
      ['u2', 'a2'],
      ['u3', 'a3'],
    ]);
  });

  it('keeps an oversized single round intact instead of cutting through a reply', () => {
    const messages = [
      user('u1', 'question'),
      assistant('a1', `<p>${'long answer '.repeat(20)}</p>`),
      user('u2', 'next'),
      assistant('a2', '<p>short</p>'),
    ];

    const chunks = splitScreenshotMessages(messages, 20);

    expect(chunks.map(chunk => chunk.map(message => message.id))).toEqual([
      ['u1', 'a1'],
      ['u2', 'a2'],
    ]);
  });

  it('counts inline screenshots and user image attachments as visible content', () => {
    const messages = [
      user('u1', 'small'),
      {
        id: 'a1',
        role: 'assistant' as const,
        blocks: [{ type: 'screenshot' as const, base64: 'ABC', mimeType: 'image/png' }],
      },
      {
        id: 'u2',
        role: 'user' as const,
        text: 'with image',
        attachments: [{
          path: '/tmp/picture.png',
          name: 'picture.png',
          isDir: false,
          mimeType: 'image/png',
        }],
      },
    ];

    const chunks = splitScreenshotMessages(messages, 6_500);

    expect(chunks.map(chunk => chunk.map(message => message.id))).toEqual([
      ['u1', 'a1'],
      ['u2'],
    ]);
  });
});
