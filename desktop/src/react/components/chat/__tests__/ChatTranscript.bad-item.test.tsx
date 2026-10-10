// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListItem } from '../../../stores/chat-types';

const mocks = vi.hoisted(() => ({
  state: {
    agents: [],
    agentName: 'Codia',
    agentYuan: 'codia',
    chatSessions: {},
    voiceSpeakingMessageId: null,
    setVoiceSpeakingMessageId: vi.fn(),
  },
}));

vi.mock('../../../stores', () => ({
  useStore: Object.assign(
    <T,>(selector: (state: typeof mocks.state) => T): T => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}));

vi.mock('../../../stores/session-selectors', () => ({
  selectIsStreamingSession: () => false,
  selectSelectedIdsBySession: () => [],
}));

vi.mock('../../../utils/agent-display', () => ({
  AgentAvatar: () => <span data-testid="agent-avatar" />,
  resolveAgentDisplayInfo: () => ({ displayName: 'Codia', yuan: 'codia' }),
}));

vi.mock('../../../utils/agent-helpers', () => ({
  yuanFallbackAvatar: () => 'avatar://fallback',
}));

vi.mock('../../../utils/chat-copy', () => ({
  serializeChatMessageForCopy: vi.fn(() => ''),
}));

vi.mock('../../../utils/clipboard', () => ({
  writeClipboardText: vi.fn(async () => true),
}));

vi.mock('../../../hooks/use-codia-fetch', () => ({
  codiaFetch: vi.fn(),
  codiaUrl: (url: string) => url,
}));

vi.mock('../MessageActions', () => ({
  MessageActions: () => null,
  useMessageFooterActions: () => [],
}));

vi.mock('../RuntimeTimeline', () => ({
  RuntimeTimeline: () => null,
}));

describe('ChatTranscript malformed item tolerance', () => {
  beforeEach(() => {
    Object.assign(window, {
      t: (key: string, vars?: Record<string, string | number>) => {
        if (key === 'chat.messageUnavailable') return '消息暂时不可用';
        if (vars) return `${key}:${JSON.stringify(vars)}`;
        return key;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a fallback for malformed transcript items instead of throwing', async () => {
    const items = [
      { type: 'message', data: { id: 'ok-1', role: 'assistant', blocks: [{ type: 'text', html: '<p>正常回复</p>', source: '正常回复' }] } },
      { type: 'message', data: null },
    ] as unknown as ChatListItem[];
    const { ChatTranscript } = await import('../ChatTranscript');

    render(<ChatTranscript items={items} sessionPath="/s1" readOnly />);

    expect(screen.getByText('正常回复')).toBeTruthy();
    expect(screen.getByText('消息暂时不可用')).toBeTruthy();
  });

  it('renders a fallback for assistant messages with malformed blocks instead of crashing', async () => {
    const items = [
      {
        type: 'message',
        data: {
          id: 'bad-blocks',
          role: 'assistant',
          blocks: { type: 'text', html: '<p>bad</p>' },
        },
      },
    ] as unknown as ChatListItem[];
    const { ChatTranscript } = await import('../ChatTranscript');

    render(<ChatTranscript items={items} sessionPath="/s1" readOnly />);

    expect(screen.getByText('消息暂时不可用')).toBeTruthy();
  });
});
