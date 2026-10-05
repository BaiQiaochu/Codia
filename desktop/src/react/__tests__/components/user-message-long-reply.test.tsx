// @vitest-environment jsdom
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../stores/chat-types';
import chatStyles from '../../components/chat/Chat.module.css';

type MockStoreState = {
  userAvatarUrl: string | null;
  userName: string;
  chatSessions: Record<string, { items: Array<{ type: 'message'; data: ChatMessage }> }>;
};

let storeState: MockStoreState;

const useStoreMock = Object.assign(
  <T,>(selector: (state: MockStoreState) => T): T => selector(storeState),
  {
    getState: () => storeState,
  },
);

vi.mock('../../stores', () => ({
  useStore: useStoreMock,
}));

vi.mock('../../stores/session-selectors', () => ({
  selectIsStreamingSession: () => false,
  selectSelectedIdsBySession: () => [],
}));

vi.mock('../../utils/chat-copy', () => ({
  serializeChatMessageForCopy: vi.fn(() => ''),
}));

vi.mock('../../components/chat/MessageActions', () => ({
  MessageActions: () => null,
  useMessageFooterActions: () => [],
}));

describe('UserMessage long reply rendering', () => {
  beforeEach(() => {
    storeState = {
      userAvatarUrl: null,
      userName: 'Me',
      chatSessions: {},
    };

    Object.assign(window, {
      t: (key: string) => key,
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders long user markdown, quoted text and skills without dropping content', async () => {
    const longToken = 'USER_LONG_TOKEN_'.repeat(70);
    const html = `
      <p>${longToken}</p>
      <p>用户超长正文第二段也应完整显示。</p>
      <table>
        <tbody><tr><td>${longToken}</td><td>用户表格单元格</td></tr></tbody>
      </table>
    `;

    const message: ChatMessage = {
      id: 'msg-user-long-reply',
      role: 'user',
      quotedText: '这是被引用的一段很长内容',
      skills: ['hermes_agent'],
      textHtml: html,
    };

    const { UserMessage } = await import('../../components/chat/UserMessage');

    const { container } = render(
      <UserMessage
        message={message}
        showAvatar={false}
        sessionPath="session://user-long-reply"
        readOnly
      />,
    );

    const messageGroup = container.querySelector('[data-message-id="msg-user-long-reply"]');
    expect(messageGroup).toBeTruthy();

    const userBubble = messageGroup?.querySelector(`.${chatStyles.messageUser}`);
    expect(userBubble).toBeTruthy();

    const markdownRoot = userBubble?.querySelector('.md-content') as HTMLDivElement | null;
    expect(markdownRoot).toBeTruthy();
    expect(markdownRoot?.textContent).toContain(longToken);
    expect(markdownRoot?.textContent).toContain('用户超长正文第二段也应完整显示。');
    expect(markdownRoot?.querySelectorAll('p')).toHaveLength(2);
    expect(markdownRoot?.querySelector('table')?.textContent).toContain('用户表格单元格');

    expect(messageGroup?.textContent).toContain('这是被引用的一段很长内容');
    expect(messageGroup?.textContent).toContain('hermes_agent');
  });
});
