// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListItem } from '../../stores/chat-types';
import { useStore } from '../../stores';

const transcriptProps: Array<Record<string, unknown>> = [];

vi.mock('../../components/chat/ChatTranscript', () => ({
  ChatTranscript: (props: Record<string, unknown>) => {
    transcriptProps.push(props);
    return <div data-testid="chat-transcript" />;
  },
}));

vi.mock('../../components/chat/ChatTimelineNavigator', () => ({
  ChatTimelineNavigator: (props: Record<string, unknown>) => (
    <div data-testid="timeline-nav" data-rail-visible={String(props.railVisible)} />
  ),
}));

describe('chat original parity migration', () => {
  const sessionPath = '/sessions/read-only.jsonl';
  const items: ChatListItem[] = [
    {
      type: 'message',
      data: {
        id: 'u1',
        role: 'user',
        text: 'hello',
        textHtml: '<p>hello</p>',
        timestamp: 1,
      },
    },
  ];

  beforeEach(() => {
    transcriptProps.length = 0;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as never;
    useStore.setState({
      welcomeVisible: false,
      currentSessionPath: sessionPath,
      sessions: [{
        path: sessionPath,
        title: 'Read only',
        firstMessage: '',
        modified: '',
        messageCount: 1,
        agentId: 'agent-1',
        agentName: 'Agent',
        agentDeleted: true,
        cwd: null,
      }],
      chatSessions: {
        [sessionPath]: {
          items,
          hasMore: false,
          loadingMore: false,
        },
      },
      streamingSessions: [],
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('passes the original read-only and identity props from ChatArea into ChatTranscript', async () => {
    const { ChatArea } = await import('../../components/chat/ChatArea');

    render(<ChatArea />);

    await waitFor(() => expect(transcriptProps.length).toBeGreaterThan(0));
    expect(transcriptProps.at(-1)).toMatchObject({
      readOnly: true,
      hideUserIdentity: false,
    });
    expect(transcriptProps.at(-1)).toHaveProperty('userIdentity');
  });

  it('keeps the original hover rail behavior for the timeline navigator', async () => {
    const { ChatArea } = await import('../../components/chat/ChatArea');

    render(<ChatArea />);

    const shell = document.querySelector('[class*="sessionShell"]') as HTMLElement;
    expect(shell).toBeTruthy();
    expect(screen.getByTestId('timeline-nav')).toHaveAttribute('data-rail-visible', 'false');

    shell.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 1000,
      width: 1000,
      height: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.pointerMove(shell, { clientX: 970, clientY: 120 });

    expect(screen.getByTestId('timeline-nav')).toHaveAttribute('data-rail-visible', 'true');
  });

  it('removes the conflicting runtime timeline from assistant chat bubbles', () => {
    const assistantSource = fs.readFileSync(
      path.join(process.cwd(), 'desktop/src/react/components/chat/AssistantMessage.tsx'),
      'utf8',
    );

    expect(assistantSource).not.toContain("import { RuntimeTimeline }");
    expect(assistantSource).not.toContain('<RuntimeTimeline');
  });
});
