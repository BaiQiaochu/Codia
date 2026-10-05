// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListItem } from '../../../stores/chat-types';

const mocks = vi.hoisted(() => ({
  state: {},
}));

vi.mock('../../../stores', () => ({
  useStore: Object.assign(
    <T,>(selector: (state: typeof mocks.state) => T): T => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}));

vi.mock('../../../stores/session-selectors', () => ({
  selectIsStreamingSession: () => false,
}));

vi.mock('../AssistantMessage', () => ({
  AssistantMessage: () => {
    throw new Error('assistant message render crashed');
  },
}));

vi.mock('../UserMessage', () => ({
  UserMessage: ({ message }: { message: { text?: string } }) => (
    <div>{message.text}</div>
  ),
}));

describe('ChatTranscript message render isolation', () => {
  const originalConsoleError = console.error;

  beforeEach(() => {
    console.error = vi.fn();
    window.t = ((key: string) => {
      if (key === 'chat.messageUnavailable') return '消息暂时无法显示';
      return key;
    }) as typeof window.t;
  });

  afterEach(() => {
    console.error = originalConsoleError;
    cleanup();
    delete window.t;
  });

  it('keeps the transcript usable when one assistant message crashes during render', async () => {
    const items = [
      {
        type: 'message',
        data: {
          id: 'assistant-crash',
          role: 'assistant',
          blocks: [{ type: 'text', html: '<p>bad</p>', source: 'bad' }],
        },
      },
      {
        type: 'message',
        data: {
          id: 'user-ok',
          role: 'user',
          text: '后续消息仍然显示',
          textHtml: '<p>后续消息仍然显示</p>',
        },
      },
    ] as unknown as ChatListItem[];
    const { ChatTranscript } = await import('../ChatTranscript');

    expect(() => {
      render(<ChatTranscript items={items} sessionPath="/s1" readOnly />);
    }).not.toThrow();

    expect(screen.getByText('消息暂时无法显示')).toBeTruthy();
    expect(screen.getByText('后续消息仍然显示')).toBeTruthy();
  });
});
