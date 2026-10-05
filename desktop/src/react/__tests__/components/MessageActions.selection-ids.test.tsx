// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActions } from '../../components/chat/MessageActions';
import { useStore } from '../../stores';

describe('MessageActions grouped selection targets', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    Object.assign(window, {
      t: (key: string) => ({
        'common.copyText': '复制文本',
        'common.screenshot': '截图',
        'common.selectAllMessages': '选择全部消息',
        'common.selectMessage': '选择消息',
      }[key] || key),
    });
    useStore.setState({
      selectedIdsBySession: {
        '/session/a.jsonl': ['u1'],
      },
      streamingSessions: [],
      chatSessions: {
        '/session/a.jsonl': {
          hasMore: false,
          loadingMore: false,
          items: [
            { type: 'message', data: { id: 'u1', role: 'user', text: 'user' } },
            { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [] } },
            { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [] } },
          ],
        },
      },
      voiceSpeakingMessageId: null,
    } as never);
  });

  it('toggles all ids from a grouped assistant turn without clearing unrelated selections', () => {
    render(
      <MessageActions
        messageId="a2"
        selectionIds={['a1', 'a2']}
        sessionPath="/session/a.jsonl"
        onCopy={vi.fn()}
        onScreenshot={vi.fn()}
        copied={false}
        isStreaming={false}
      />,
    );

    fireEvent.click(screen.getByTitle('选择消息'));
    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['u1', 'a1', 'a2']);

    fireEvent.click(screen.getByTitle('选择消息'));
    expect(useStore.getState().selectedIdsBySession['/session/a.jsonl']).toEqual(['u1']);
  });
});
