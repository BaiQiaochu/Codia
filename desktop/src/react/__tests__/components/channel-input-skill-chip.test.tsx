// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashItem } from '../../components/input/slash-commands';

type MockStoreState = {
  currentChannel: string;
  channelIsDM: boolean;
  channelMembers: string[];
  agents: Array<{ id: string; name: string }>;
  userName: string;
  userAvatarUrl: string | null;
  currentAgentId: string;
  attachedFiles: unknown[];
  addAttachedFile: ReturnType<typeof vi.fn>;
  removeAttachedFile: ReturnType<typeof vi.fn>;
  clearAttachedFiles: ReturnType<typeof vi.fn>;
};

let storeState: MockStoreState;

const useStoreMock = Object.assign(
  <T,>(selector: (state: MockStoreState) => T): T => selector(storeState),
  {
    getState: () => storeState,
    setState: vi.fn(),
  },
);

const skillItem: SlashItem = {
  name: 'image-gen-guide',
  label: '/image-gen-guide',
  description: 'Image generation guide',
  busyLabel: '',
  icon: '<svg viewBox="0 0 16 16"></svg>',
  type: 'skill',
  filePath: 'C:/Users/ghost/.codex/skills/image-gen-guide/SKILL.md',
  execute: () => {},
};

vi.mock('../../stores', () => ({
  useStore: useStoreMock,
}));

vi.mock('../../hooks/use-slash-items', () => ({
  useSkillSlashItems: () => [skillItem],
}));

vi.mock('../../stores/channel-actions', () => ({
  addChannelMember: vi.fn(),
  loadChannels: vi.fn(),
  removeChannelMember: vi.fn(),
  saveConversationAgentPhoneSettings: vi.fn(),
  sendChannelMessage: vi.fn(),
}));

vi.mock('../../stores/session-actions', () => ({
  loadMessages: vi.fn(),
}));

vi.mock('../../MainContent', () => ({
  attachFilesFromPaths: vi.fn(),
}));

vi.mock('../../hooks/use-config', () => ({
  fetchConfig: vi.fn(),
}));

vi.mock('../../hooks/use-codia-fetch', () => ({
  codiaFetch: vi.fn(),
}));

vi.mock('../../components/chat/ChatTranscript', () => ({
  ChatTranscript: () => null,
}));

vi.mock('../../components/chat/AssistantMessage', () => ({
  ContentBlockView: () => null,
}));

vi.mock('../../components/chat/MarkdownContent', () => ({
  MarkdownContent: ({ html, className }: { html: string; className?: string }) => (
    <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
  ),
}));

describe('ChannelInput skill chip', () => {
  beforeEach(() => {
    storeState = {
      currentChannel: 'work',
      channelIsDM: false,
      channelMembers: ['agent-a'],
      agents: [{ id: 'agent-a', name: 'Agent A' }],
      userName: 'ghost',
      userAvatarUrl: null,
      currentAgentId: 'agent-a',
      attachedFiles: [],
      addAttachedFile: vi.fn(),
      removeAttachedFile: vi.fn(),
      clearAttachedFiles: vi.fn(),
    };
    Object.assign(window, {
      t: (key: string) => key,
      platform: {},
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders a skill badge instead of putting the skill markdown link in the textarea', async () => {
    const { ChannelInput } = await import('../../components/ChannelsPanel');

    render(<ChannelInput />);

    fireEvent.click(screen.getByTestId('channel-skill-menu'));
    fireEvent.click(screen.getByText('/image-gen-guide'));

    expect(screen.getByTestId('channel-selected-skill').textContent).toContain('image-gen-guide');
    const input = screen.getByPlaceholderText('channel.inputPlaceholder') as HTMLTextAreaElement;
    expect(input.value).toBe('');
    expect(input.value).not.toContain('[$image-gen-guide]');
  });
});
