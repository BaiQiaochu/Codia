import { Component, memo, useCallback, useMemo } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import type { ChatListItem, ChatMessage } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { selectIsStreamingSession } from '../../stores/session-selectors';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { InterludeBlock } from './InterludeBlock';
import { ProcessFoldBlock } from './ProcessFoldBlock';
import { ExecutionRunNotice } from './ExecutionRunNotice';
import { buildTranscriptRenderItems, type TranscriptRenderItem } from './process-fold';
import styles from './Chat.module.css';

type TranscriptRenderItemSafe =
  | TranscriptRenderItem
  | { type: 'invalid'; id: string; originalIndex: number };

interface MessageRenderBoundaryProps {
  resetKey: string;
  renderItemKey: string;
  children: ReactNode;
}

interface MessageRenderBoundaryState {
  error: Error | null;
  resetKey: string;
}

class MessageRenderBoundary extends Component<MessageRenderBoundaryProps, MessageRenderBoundaryState> {
  state: MessageRenderBoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  };

  static getDerivedStateFromError(error: Error): Partial<MessageRenderBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(
    props: MessageRenderBoundaryProps,
    state: MessageRenderBoundaryState,
  ): Partial<MessageRenderBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ChatTranscript:message]', {
      renderItemKey: this.props.renderItemKey,
      error,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.error) return <InvalidTranscriptItem />;
    return this.props.children;
  }
}

interface Props {
  items: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly?: boolean;
  hideUserIdentity?: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
  enableProcessFold?: boolean;
}

export const ChatTranscript = memo(function ChatTranscript({
  items,
  sessionPath,
  agentId,
  readOnly = false,
  hideUserIdentity = false,
  userIdentity,
  registerMessageElement,
  enableProcessFold = false,
}: Props) {
  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const renderItems = useMemo<TranscriptRenderItemSafe[]>(
    () => buildSafeTranscriptRenderItems(items, { enableProcessFold, isStreaming }),
    [enableProcessFold, isStreaming, items],
  );
  const latestUserIndex = useMemo(() => {
    if (readOnly) return -1;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (isRenderableChatItem(item) && item.type === 'message' && item.data.role === 'user') return i;
    }
    return -1;
  }, [items, readOnly]);
  const turnState = useMemo(() => buildTurnState(items), [items]);

  return (
    <>
      {renderItems.map((renderItem) => {
        const itemKey = invalidRenderItemKey(renderItem);
        return (
          <MessageRenderBoundary
            key={itemKey}
            renderItemKey={itemKey}
            resetKey={renderItemResetKey(renderItem)}
          >
            <TranscriptRenderItemView
              renderItem={renderItem}
              sourceItems={items}
              sessionPath={sessionPath}
              agentId={agentId}
              readOnly={readOnly}
              hideUserIdentity={hideUserIdentity}
              userIdentity={userIdentity}
              latestUserIndex={latestUserIndex}
              latestTurnUserIndex={turnState.latestUserIndex}
              latestAssistantIndex={turnState.latestAssistantIndex}
              latestUserMessage={turnState.latestUserMessage}
              turnCompletionAssistantIndexes={turnState.turnCompletionAssistantIndexes}
              assistantTurnSelectionIdsByCompletionIndex={turnState.assistantTurnSelectionIdsByCompletionIndex}
              isStreamingSession={isStreaming}
              registerMessageElement={registerMessageElement}
            />
          </MessageRenderBoundary>
        );
      })}
      {!readOnly && enableProcessFold && <ExecutionRunNotice sessionPath={sessionPath} />}
    </>
  );
});

function renderItemKey(renderItem: TranscriptRenderItem): string {
  if (renderItem.type === 'process_fold') return renderItem.id;
  const item = renderItem.item;
  if (item.type === 'message') return item.data.id;
  if (item.type === 'interlude') return `i-${item.id}`;
  return `c-${renderItem.originalIndex}`;
}

function isRenderableChatItem(item: unknown): item is ChatListItem {
  if (!item || typeof item !== 'object') return false;
  const typed = item as { type?: unknown; data?: unknown; id?: unknown };
  if (typed.type === 'compaction') return typeof typed.id === 'string';
  if (typed.type === 'interlude') {
    return typeof typed.id === 'string'
      && !!typed.data
      && typeof typed.data === 'object'
      && (typed.data as { type?: unknown }).type === 'interlude';
  }
  if (typed.type !== 'message') return false;
  if (!typed.data || typeof typed.data !== 'object') return false;
  const data = typed.data as { id?: unknown; role?: unknown; blocks?: unknown };
  if (typeof data.id !== 'string' || (data.role !== 'user' && data.role !== 'assistant')) return false;
  if (data.role === 'assistant' && data.blocks !== undefined && !Array.isArray(data.blocks)) return false;
  return true;
}

function buildSafeTranscriptRenderItems(
  items: ChatListItem[],
  options: { enableProcessFold: boolean; isStreaming: boolean },
): TranscriptRenderItemSafe[] {
  const safeItems: ChatListItem[] = [];
  const safeIndexToOriginalIndex: number[] = [];
  const invalidItems: TranscriptRenderItemSafe[] = [];

  items.forEach((item, originalIndex) => {
    if (isRenderableChatItem(item)) {
      safeIndexToOriginalIndex.push(originalIndex);
      safeItems.push(item);
      return;
    }
    invalidItems.push({
      type: 'invalid',
      id: `invalid-${originalIndex}`,
      originalIndex,
    });
  });

  const rendered = options.enableProcessFold
    ? buildTranscriptRenderItems(safeItems, { isStreaming: options.isStreaming })
    : safeItems.map((item, originalIndex) => ({ type: 'source' as const, item, originalIndex }));

  const safeRendered = rendered.map((renderItem) => {
    if (renderItem.type === 'process_fold') {
      return {
        ...renderItem,
        originalIndex: safeIndexToOriginalIndex[renderItem.originalIndex] ?? renderItem.originalIndex,
        items: renderItem.items.map((entry) => ({
          ...entry,
          originalIndex: safeIndexToOriginalIndex[entry.originalIndex] ?? entry.originalIndex,
        })),
      };
    }
    return {
      ...renderItem,
      originalIndex: safeIndexToOriginalIndex[renderItem.originalIndex] ?? renderItem.originalIndex,
    };
  });

  return [...safeRendered, ...invalidItems]
    .sort((a, b) => a.originalIndex - b.originalIndex);
}

function invalidRenderItemKey(renderItem: TranscriptRenderItemSafe): string {
  return renderItem.type === 'invalid' ? renderItem.id : renderItemKey(renderItem);
}

function renderItemResetKey(renderItem: TranscriptRenderItemSafe): string {
  if (renderItem.type === 'invalid') return renderItem.id;
  if (renderItem.type === 'process_fold') {
    return [
      renderItem.id,
      renderItem.items.length,
      renderItem.items.map(entry => `${entry.originalIndex}:${sourceItemSignature(entry.item)}`).join('|'),
    ].join(':');
  }
  return sourceItemSignature(renderItem.item);
}

function sourceItemSignature(item: ChatListItem): string {
  if (item.type === 'message') {
    const msg = item.data;
    const blocks = Array.isArray(msg.blocks)
      ? msg.blocks.map((block) => {
        if (!block || typeof block !== 'object') return 'bad';
        const typed = block as Record<string, unknown>;
        const content = typeof typed.html === 'string'
          ? typed.html
          : typeof typed.source === 'string'
            ? typed.source
            : typeof typed.content === 'string'
              ? typed.content
              : '';
        return `${String(typed.type || 'unknown')}:${content.length}`;
      }).join(',')
      : 'no-blocks';
    return `m:${msg.id}:${msg.role}:${msg.text?.length || 0}:${blocks}`;
  }
  if (item.type === 'interlude') return `i:${item.id}:${item.data?.type || 'interlude'}`;
  return `c:${item.id}`;
}

function buildTurnState(items: ChatListItem[]): {
  latestUserIndex: number;
  latestAssistantIndex: number;
  latestUserMessage: ChatMessage | null;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex: ReadonlyMap<number, readonly string[]>;
} {
  let latestUserIndex = -1;
  let latestAssistantIndex = -1;
  let latestUserMessage: ChatMessage | null = null;
  let pendingAssistantIndex = -1;
  let pendingAssistantTurnIds: string[] = [];
  const turnCompletionAssistantIndexes = new Set<number>();
  const assistantTurnSelectionIdsByCompletionIndex = new Map<number, readonly string[]>();

  const completePendingAssistantTurn = () => {
    if (pendingAssistantIndex < 0) return;
    turnCompletionAssistantIndexes.add(pendingAssistantIndex);
    assistantTurnSelectionIdsByCompletionIndex.set(pendingAssistantIndex, pendingAssistantTurnIds);
    pendingAssistantIndex = -1;
    pendingAssistantTurnIds = [];
  };

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isRenderableChatItem(item) || item.type !== 'message') continue;

    if (item.data.role === 'user') {
      completePendingAssistantTurn();
      latestUserIndex = i;
      latestUserMessage = item.data;
      continue;
    }

    if (item.data.role === 'assistant') {
      pendingAssistantIndex = i;
      pendingAssistantTurnIds = [...pendingAssistantTurnIds, item.data.id];
      latestAssistantIndex = i;
    }
  }

  completePendingAssistantTurn();
  return {
    latestUserIndex,
    latestAssistantIndex,
    latestUserMessage,
    turnCompletionAssistantIndexes,
    assistantTurnSelectionIdsByCompletionIndex,
  };
}

function groupLastOriginalIndex(renderItem: Extract<TranscriptRenderItem, { type: 'process_fold' }>): number {
  return renderItem.items[renderItem.items.length - 1]?.originalIndex ?? renderItem.originalIndex;
}

const TranscriptRenderItemView = memo(function TranscriptRenderItemView({
  renderItem,
  sourceItems,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  latestUserIndex,
  latestTurnUserIndex,
  latestAssistantIndex,
  latestUserMessage,
  turnCompletionAssistantIndexes,
  assistantTurnSelectionIdsByCompletionIndex,
  isStreamingSession,
  registerMessageElement,
}: {
  renderItem: TranscriptRenderItemSafe;
  sourceItems: ChatListItem[];
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  latestUserIndex: number;
  latestTurnUserIndex: number;
  latestAssistantIndex: number;
  latestUserMessage: ChatMessage | null;
  turnCompletionAssistantIndexes: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex: ReadonlyMap<number, readonly string[]>;
  isStreamingSession: boolean;
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const originalIndex = renderItem.originalIndex;
  const prevItem = previousMessageItem(sourceItems, originalIndex);

  if (renderItem.type === 'invalid') {
    return <InvalidTranscriptItem />;
  }

  if (renderItem.type === 'process_fold') {
    const prevRole = prevItem?.data.role ?? null;
    const groupLastIndex = groupLastOriginalIndex(renderItem);
    return (
      <ProcessFoldBlock
        group={renderItem}
        showAvatar={prevRole !== 'assistant'}
        sessionPath={sessionPath}
        agentId={agentId}
        readOnly={readOnly}
        turnCompletionAssistantIndexes={turnCompletionAssistantIndexes}
        assistantTurnSelectionIdsByCompletionIndex={assistantTurnSelectionIdsByCompletionIndex}
        completionTimePersistent={
          turnCompletionAssistantIndexes.has(groupLastIndex)
          && groupLastIndex === latestAssistantIndex
          && latestAssistantIndex > latestTurnUserIndex
          && !isStreamingSession
        }
        registerMessageElement={registerMessageElement}
      />
    );
  }

  return (
    <TranscriptItemView
      item={renderItem.item}
      prevItem={prevItem}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      hideUserIdentity={hideUserIdentity}
      userIdentity={userIdentity}
      isLatestUserMessage={originalIndex === latestUserIndex}
      isLatestAssistantMessage={originalIndex === latestAssistantIndex && latestAssistantIndex > latestTurnUserIndex}
      showTurnCompletionTime={turnCompletionAssistantIndexes.has(originalIndex)}
      assistantTurnSelectionIds={
        turnCompletionAssistantIndexes.has(originalIndex)
          ? assistantTurnSelectionIdsByCompletionIndex.get(originalIndex)
          : undefined
      }
      retrySourceMessage={latestUserMessage}
      registerMessageElement={registerMessageElement}
    />
  );
});

function InvalidTranscriptItem() {
  const t = window.t ?? ((key: string) => key);
  const label = t('chat.messageUnavailable') === 'chat.messageUnavailable'
    ? '消息暂时不可用'
    : t('chat.messageUnavailable');
  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}`}>
      <div className={`${styles.message} ${styles.messageAssistant}`}>
        <div className={styles.blockRenderFallback} role="status">{label}</div>
      </div>
    </div>
  );
}

function previousMessageItem(items: ChatListItem[], beforeIndex: number): Extract<ChatListItem, { type: 'message' }> | undefined {
  for (let i = beforeIndex - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (isRenderableChatItem(item) && item.type === 'message') return item;
  }
  return undefined;
}

const TranscriptItemView = memo(function TranscriptItemView({
  item,
  prevItem,
  sessionPath,
  agentId,
  readOnly,
  hideUserIdentity,
  userIdentity,
  isLatestUserMessage,
  isLatestAssistantMessage,
  showTurnCompletionTime,
  assistantTurnSelectionIds,
  retrySourceMessage,
  registerMessageElement,
}: {
  item: ChatListItem;
  prevItem?: ChatListItem;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  hideUserIdentity: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  isLatestUserMessage: boolean;
  isLatestAssistantMessage: boolean;
  showTurnCompletionTime: boolean;
  assistantTurnSelectionIds?: readonly string[];
  retrySourceMessage: ChatMessage | null;
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}) {
  const messageId = item.type === 'message' ? item.data.id : null;
  const messageRef = useCallback((element: HTMLDivElement | null) => {
    if (messageId) registerMessageElement?.(messageId, element);
  }, [messageId, registerMessageElement]);

  if (item.type === 'compaction') return null;
  if (item.type === 'interlude') return <InterludeBlock block={item.data} />;

  const msg = item.data;
  const prevRole = prevItem?.type === 'message' ? prevItem.data.role : null;
  const showAvatar = msg.role !== prevRole;

  if (msg.role === 'user') {
    return (
      <UserMessage
        message={msg}
        showAvatar={showAvatar}
        sessionPath={sessionPath}
        readOnly={readOnly}
        hideIdentity={hideUserIdentity}
        userIdentity={userIdentity}
        isLatestUserMessage={isLatestUserMessage}
        messageRef={messageRef}
      />
    );
  }

  return (
    <AssistantMessage
      message={msg}
      showAvatar={showAvatar}
      sessionPath={sessionPath}
      agentId={agentId}
      readOnly={readOnly}
      isLatestAssistantMessage={isLatestAssistantMessage}
      showTurnCompletionTime={showTurnCompletionTime}
      assistantTurnSelectionIds={assistantTurnSelectionIds}
      retrySourceMessage={retrySourceMessage}
      messageRef={messageRef}
    />
  );
});
