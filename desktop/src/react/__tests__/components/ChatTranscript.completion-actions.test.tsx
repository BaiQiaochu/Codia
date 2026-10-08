// @vitest-environment jsdom

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatListItem } from '../../stores/chat-types';

type StoreState = {
  streamingSessions: string[];
};

let storeState: StoreState;

const assistantProps: unknown[] = [];
const processFoldProps: unknown[] = [];

vi.mock('../../stores', () => ({
  useStore: <T,>(selector: (state: StoreState) => T): T => selector(storeState),
}));

vi.mock('../../stores/session-selectors', () => ({
  selectIsStreamingSession: (state: StoreState, sessionPath: string) =>
    state.streamingSessions.includes(sessionPath),
}));

vi.mock('../../components/chat/UserMessage', () => ({
  UserMessage: () => <div data-testid="user-message" />,
}));

vi.mock('../../components/chat/AssistantMessage', () => ({
  AssistantMessage: (props: unknown) => {
    assistantProps.push(props);
    return <div data-testid="assistant-message" />;
  },
}));

vi.mock('../../components/chat/ProcessFoldBlock', () => ({
  ProcessFoldBlock: (props: unknown) => {
    processFoldProps.push(props);
    return <div data-testid="process-fold" />;
  },
}));

describe('ChatTranscript completion actions', () => {
  beforeEach(() => {
    storeState = { streamingSessions: [] };
    assistantProps.length = 0;
    processFoldProps.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  it('marks the latest assistant reply with completion time and retry source', async () => {
    const retrySourceMessage = { id: 'u1', role: 'user' as const, text: 'retry this' };
    const items: ChatListItem[] = [
      { type: 'message', data: retrySourceMessage },
      { type: 'message', data: { id: 'a1', role: 'assistant', timestamp: 1_779_100_800_000, blocks: [{ type: 'text', html: '<p>done</p>' }] } },
    ];
    const { ChatTranscript } = await import('../../components/chat/ChatTranscript');

    render(<ChatTranscript items={items} sessionPath="/session/a.jsonl" />);

    expect(assistantProps).toHaveLength(1);
    expect(assistantProps[0]).toMatchObject({
      isLatestAssistantMessage: true,
      showTurnCompletionTime: true,
      retrySourceMessage,
    });
  });

  it('passes completion metadata to a folded process group', async () => {
    const items: ChatListItem[] = [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'run steps' } },
      { type: 'message', data: { id: 'a1', role: 'assistant', timestamp: 1_779_100_740_000, blocks: [{ type: 'thinking', content: 'step 1', sealed: true }] } },
      { type: 'message', data: { id: 'a2', role: 'assistant', timestamp: 1_779_100_800_000, blocks: [{ type: 'thinking', content: 'step 2', sealed: true }] } },
      { type: 'message', data: { id: 'a3', role: 'assistant', timestamp: 1_779_100_860_000, blocks: [{ type: 'thinking', content: 'step 3', sealed: true }] } },
    ];
    const { ChatTranscript } = await import('../../components/chat/ChatTranscript');

    render(<ChatTranscript items={items} sessionPath="/session/a.jsonl" enableProcessFold />);

    expect(processFoldProps).toHaveLength(1);
    expect(processFoldProps[0]).toMatchObject({
      turnCompletionAssistantIndexes: expect.any(Set),
      completionTimePersistent: true,
    });
    expect((processFoldProps[0] as { turnCompletionAssistantIndexes: Set<number> }).turnCompletionAssistantIndexes.has(3)).toBe(true);
  });

  it('passes all assistant message ids from one turn to the completion action target', async () => {
    const items: ChatListItem[] = [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'answer in parts' } },
      { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [{ type: 'text', html: '<p>part 1</p>' }] } },
      { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [{ type: 'text', html: '<p>part 2</p>' }] } },
    ];
    const { ChatTranscript } = await import('../../components/chat/ChatTranscript');

    render(<ChatTranscript items={items} sessionPath="/session/a.jsonl" />);

    expect(assistantProps).toHaveLength(2);
    expect(assistantProps[0]).toMatchObject({
      showTurnCompletionTime: false,
    });
    expect(assistantProps[1]).toMatchObject({
      showTurnCompletionTime: true,
      assistantTurnSelectionIds: ['a1', 'a2'],
    });
  });

  it('ignores malformed assistant blocks before process folding so the chat region stays renderable', async () => {
    const items = [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'model produced malformed blocks' } },
      { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [null, 'bad-block', { nope: true }] } },
      { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [{ type: 'text', html: '<p>still visible</p>' }] } },
    ] as unknown as ChatListItem[];
    const { ChatTranscript } = await import('../../components/chat/ChatTranscript');

    expect(() => {
      render(<ChatTranscript items={items} sessionPath="/session/a.jsonl" enableProcessFold />);
    }).not.toThrow();

    expect(assistantProps).toHaveLength(2);
  });
});
