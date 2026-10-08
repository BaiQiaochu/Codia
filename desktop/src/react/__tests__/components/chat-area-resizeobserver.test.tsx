/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatArea } from '../../components/chat/ChatArea';
import { useStore } from '../../stores';

describe('ChatArea ResizeObserver fallback', () => {
  const originalResizeObserver = globalThis.ResizeObserver;

  afterEach(() => {
    cleanup();
    globalThis.ResizeObserver = originalResizeObserver;
    useStore.setState({
      welcomeVisible: true,
      currentSessionPath: null,
      sessions: [],
      chatSessions: {},
      streamingSessions: [],
    } as never);
  });

  it('renders a chat transcript when ResizeObserver is unavailable', async () => {
    // Some embedded desktop/web runtimes do not expose ResizeObserver during early startup.
    // The chat pane should still render instead of falling into the regional error boundary.
    globalThis.ResizeObserver = undefined as never;
    useStore.setState({
      welcomeVisible: false,
      currentSessionPath: '/sessions/no-resize-observer.jsonl',
      sessions: [{ path: '/sessions/no-resize-observer.jsonl', agentId: 'agent-1', title: '对话' }],
      chatSessions: {
        '/sessions/no-resize-observer.jsonl': {
          items: [
            {
              type: 'message',
              data: {
                id: 'm1',
                role: 'user',
                text: '你好',
                textHtml: '<p>你好</p>',
                timestamp: Date.now(),
              },
            },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
      streamingSessions: [],
    } as never);

    render(<ChatArea />);

    const matches = await screen.findAllByText('你好');
    expect(matches.some((element) => element.closest('.md-content'))).toBe(true);
  });

  it('keeps the chat pane visible when a malformed message appears before transcript rendering', async () => {
    useStore.setState({
      welcomeVisible: false,
      currentSessionPath: '/sessions/malformed-item.jsonl',
      sessions: [{ path: '/sessions/malformed-item.jsonl', agentId: 'agent-1', title: '对话' }],
      chatSessions: {
        '/sessions/malformed-item.jsonl': {
          items: [
            { type: 'message', data: null },
            {
              type: 'message',
              data: {
                id: 'ok-1',
                role: 'user',
                text: '还在吗',
                textHtml: '<p>还在吗</p>',
                timestamp: Date.now(),
              },
            },
          ],
          hasMore: false,
          loadingMore: false,
        },
      },
      streamingSessions: [],
    } as never);

    render(<ChatArea />);

    const matches = await screen.findAllByText('还在吗');
    expect(matches.some((element) => element.closest('.md-content'))).toBe(true);
  });
});
