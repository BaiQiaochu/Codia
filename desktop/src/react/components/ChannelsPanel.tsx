/** Channels panel entry and channel-specific chat surfaces. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import { fetchConfig } from '../hooks/use-config';
import { gsapFetch } from '../hooks/use-gsap-fetch';
import { useI18n } from '../hooks/use-i18n';
import { attachFilesFromPaths } from '../MainContent';
import { renderMarkdown } from '../utils/markdown';
import { extOfName, inferKindByExt } from '../utils/file-kind';
import { resolveBrowserFilePaths } from '../utils/browser-file-paths';
import { notifyPasteUploadFailure } from '../utils/paste-upload-feedback';
import { MarkdownContent } from './chat/MarkdownContent';
import {
  addChannelMember,
  loadChannels,
  removeChannelMember,
  saveConversationAgentPhoneSettings,
  sendChannelMessage,
} from '../stores/channel-actions';
import { loadMessages } from '../stores/session-actions';
import { subscribeStreamKey, type StreamKeyEvent } from '../services/stream-key-dispatcher';
import { buildAgentMap, formatChannelTime, MemberAvatar, resolveChannelMember } from './channels/channel-member-utils';
import type { MemberInfo } from './channels/channel-member-utils';
import { ChatTranscript } from './chat/ChatTranscript';
import { ContentBlockView } from './chat/AssistantMessage';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { AttachedFilesBar } from './input/AttachedFilesBar';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { buildSlashDraftText, getSlashMatches, parseSlashInput, type SlashItem } from './input/slash-commands';
import { useSkillSlashItems } from '../hooks/use-slash-items';
import type { ChatListItem, ChatMessage, ContentBlock, ResourceEnvelope, ToolCall } from '../stores/chat-types';
import type { AttachedFile } from '../stores/input-slice';
import type { AgentPhoneActivity, ChannelTickerStatus, Model } from '../types';
import styles from './channels/Channels.module.css';
import chatStyles from './chat/Chat.module.css';
import skillBadgeStyles from './input/SkillBadgeView.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CHANNEL_SCROLL_THRESHOLD = 80;
const EMPTY_CHAT_ITEMS: ChatListItem[] = [];
const PHONE_STREAM_MESSAGE_PREFIX = 'agent-phone-stream';

function isChannelContentBlock(block: unknown): block is ContentBlock {
  return !!block && typeof block === 'object' && typeof (block as { type?: unknown }).type === 'string';
}

function channelBlockSessionPath(block: ContentBlock, fallbackChannel: string): string {
  const maybeSessionPath = (block as ContentBlock & { sessionPath?: unknown }).sessionPath;
  return typeof maybeSessionPath === 'string' && maybeSessionPath
    ? maybeSessionPath
    : `channel:${fallbackChannel}`;
}

function buildChannelFileBlocks(files: readonly AttachedFile[]): ContentBlock[] {
  return files
    .filter(file => file && typeof file.path === 'string' && file.path)
    .map((file) => {
      const ext = file.resource?.ext || extOfName(file.name || file.path) || '';
      const mime = file.mimeType || file.resource?.mime;
      const kind = file.isDirectory ? 'folder' : (file.resource?.kind || inferKindByExt(ext));
      const missingAt = file.resource?.lifecycle?.missingAt;
      return {
        type: 'file' as const,
        fileId: file.fileId,
        resourceId: file.resource?.resourceId,
        resource: file.resource,
        filePath: file.path,
        label: file.name || file.path.split(/[\\/]/).pop() || file.path,
        ext,
        mime,
        kind,
        storageKind: file.resource?.storage?.storageKind,
        status: file.resource?.lifecycle?.status,
        missingAt: typeof missingAt === 'number' ? missingAt : null,
      };
    });
}

function channelResourceLabel(resource: ResourceEnvelope): string {
  const rawName = resource.displayName || resource.filename || resource.name || resource.resourceId;
  return rawName.split(/[\\/]/).pop() || rawName;
}

function channelResourceToBlock(resource: ResourceEnvelope): ContentBlock | null {
  if (!resource?.resourceId || !resource.links?.self) return null;
  const label = channelResourceLabel(resource);
  const ext = resource.ext || extOfName(label) || '';
  const missingAt = resource.lifecycle?.missingAt;
  return {
    type: 'file',
    fileId: resource.fileId,
    resourceId: resource.resourceId,
    resource,
    filePath: resource.links.content || resource.links.self,
    label,
    ext,
    mime: resource.mime,
    kind: resource.kind || inferKindByExt(ext),
    storageKind: resource.storage?.storageKind,
    status: resource.lifecycle?.status,
    missingAt: typeof missingAt === 'number' ? missingAt : null,
  };
}

function mergeChannelRichBlocks(blocks: unknown, resources: unknown): ContentBlock[] {
  const richBlocks = Array.isArray(blocks) ? blocks.filter(isChannelContentBlock) : [];
  const seenResources = new Set(
    richBlocks
      .map((block) => (block as ContentBlock & { resourceId?: string; resource?: ResourceEnvelope }).resourceId
        || (block as ContentBlock & { resource?: ResourceEnvelope }).resource?.resourceId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  const resourceBlocks = Array.isArray(resources)
    ? resources
        .filter((resource): resource is ResourceEnvelope => (
          !!resource && typeof resource === 'object' && typeof (resource as { resourceId?: unknown }).resourceId === 'string'
        ))
        .filter((resource) => {
          if (seenResources.has(resource.resourceId)) return false;
          seenResources.add(resource.resourceId);
          return true;
        })
        .map(channelResourceToBlock)
        .filter((block): block is ContentBlock => !!block)
    : [];
  return [...richBlocks, ...resourceBlocks];
}

function buildChannelSkillLink(item: SlashItem): string {
  if (!item.filePath) return `/${item.name}`;
  return `[$${item.name}](${item.filePath})`;
}

function resolveDmOwnerId(channel: { isDM?: boolean; dmOwnerId?: string } | undefined, currentAgentId: string | null): string {
  return channel?.isDM ? (channel.dmOwnerId || currentAgentId || '') : (currentAgentId || '');
}

export function ChannelsPanel() {
  const channelsEnabled = useStore(s => s.channelsEnabled);
  const activeServerConnection = useStore(s => s.activeServerConnection);

  // Load channel settings and channel list after the server connection is ready.
  useEffect(() => {
    if (!activeServerConnection) return;
    fetchConfig().then(cfg => {
      const enabled = cfg?.channels?.enabled === true;
      useStore.getState().setChannelsEnabled(enabled);
      if (enabled) loadChannels();
    }).catch(err => console.warn('[channels] init failed:', err));
  }, [activeServerConnection]);

  // Reload the channel list when the channel feature is enabled.
  useEffect(() => {
    if (channelsEnabled && activeServerConnection) loadChannels();
  }, [channelsEnabled, activeServerConnection]);

  return null;
}


export function ChannelMessages() {
  const { t } = useI18n();
  const messages = useStore(s => s.channelMessages);
  const currentChannel = useStore(s => s.currentChannel);
  const channels = useStore(s => s.channels);
  const agents = useStore(s => s.agents);
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const currentAgentId = useStore(s => s.currentAgentId);
  const agentMap = useMemo(() => buildAgentMap(agents), [agents]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const previousChannelRef = useRef<string | null>(null);
  const previousLengthRef = useRef(0);
  const [showNewMessages, setShowNewMessages] = useState(false);

  const getScrollContainer = useCallback(() => (
    wrapperRef.current?.closest('.channel-messages') as HTMLElement | null
  ), []);

  const checkNearBottom = useCallback(() => {
    const el = getScrollContainer();
    if (!el) return true;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= CHANNEL_SCROLL_THRESHOLD;
    isNearBottomRef.current = near;
    if (near) setShowNewMessages(false);
    return near;
  }, [getScrollContainer]);

  const scrollToBottom = useCallback(() => {
    const el = getScrollContainer();
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    isNearBottomRef.current = true;
    setShowNewMessages(false);
  }, [getScrollContainer]);

  useEffect(() => {
    isNearBottomRef.current = true;
    previousChannelRef.current = null;
    previousLengthRef.current = 0;
    setShowNewMessages(false);
  }, [currentChannel]);

  useEffect(() => {
    const el = getScrollContainer();
    if (!el) return;
    const onScroll = () => { checkNearBottom(); };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [checkNearBottom, getScrollContainer, messages.length]);

  useEffect(() => {
    const el = getScrollContainer();
    const channelChanged = previousChannelRef.current !== currentChannel;
    const previousLength = previousLengthRef.current;
    const grew = messages.length > previousLength;

    if (el && messages.length > 0) {
      if (channelChanged || previousLength === 0) {
        scrollToBottom();
      } else if (grew) {
        const nearNow = el.scrollHeight - el.scrollTop - el.clientHeight <= CHANNEL_SCROLL_THRESHOLD;
        if (isNearBottomRef.current || nearNow) {
          scrollToBottom();
        } else {
          setShowNewMessages(true);
        }
      }
    }

    previousChannelRef.current = currentChannel;
    previousLengthRef.current = messages.length;
  }, [currentChannel, getScrollContainer, messages.length, scrollToBottom]);

  if (!currentChannel || messages.length === 0) {
    return <div className={styles.channelWelcome}>{t('channel.noMessages')}</div>;
  }

  const ch = channels.find((c) => c.id === currentChannel);
  const isDM = ch?.isDM ?? false;
  const dmOwnerId = resolveDmOwnerId(ch, currentAgentId);
  let lastSender: string | null = null;

  return (
    <>
      <div ref={wrapperRef}>
        {messages.map((msg, idx) => {
          const isContinuation = msg.sender === lastSender;
          const senderInfo = resolveChannelMember(msg.sender, userName, userAvatarUrl, agents, isDM ? dmOwnerId : currentAgentId, agentMap);
          const isSelf = senderInfo.isUser || (isDM && msg.sender === dmOwnerId);
          const richBlocks = mergeChannelRichBlocks(msg.blocks, msg.resources);
          const messageId = `channel-${currentChannel}-${msg.timestamp}-${idx}`;
          const el = (
            <div
              key={`${msg.timestamp}-${msg.sender}-${idx}`}
              className={
                styles.channelMsg
                + (isContinuation ? ` ${styles.channelMsgContinuation}` : '')
                + (isSelf ? ` ${styles.channelMsgSelf}` : '')
              }
            >
              <div className={styles.channelMsgAvatar}>
                <MemberAvatar info={senderInfo} className={styles.channelMsgAvatarImg} />
              </div>
              <div className={styles.channelMsgBody}>
                {!isContinuation && (
                  <div className={styles.channelMsgHeader}>
                    <span className={styles.channelMsgSender}>{senderInfo.displayName}</span>
                    <span className={styles.channelMsgTime}>{formatChannelTime(msg.timestamp)}</span>
                  </div>
                )}
                {msg.body?.trim() && (
                  <MarkdownContent
                    className={styles.channelMsgText}
                    html={renderMarkdown(msg.body || '')}
                  />
                )}
                {richBlocks.length > 0 && (
                  <div className={styles.channelMsgBlocks}>
                    {richBlocks.map((block, blockIdx) => (
                      <ContentBlockView
                        key={`${messageId}-block-${blockIdx}-${block.type}`}
                        block={block}
                        agentName={senderInfo.displayName}
                        agentId={senderInfo.isUser ? null : msg.sender}
                        yuan={senderInfo.yuan || 'gsap'}
                        sessionPath={channelBlockSessionPath(block, currentChannel)}
                        messageId={messageId}
                        blockIdx={blockIdx}
                        isStreaming={false}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
          lastSender = msg.sender;
          return el;
        })}
      </div>
      {showNewMessages && (
        <button
          type="button"
          className={styles.channelNewMessagesBtn}
          onClick={scrollToBottom}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
          <span>{t('channel.newMessages')}</span>
        </button>
      )}
    </>
  );
}


function MemberItem({ info, memberId, onRemove, removeDisabled, removeTitle }: {
  info: MemberInfo;
  memberId?: string;
  onRemove?: (memberId: string, info: MemberInfo) => void;
  removeDisabled?: boolean;
  removeTitle?: string;
}) {
  return (
    <div className={styles.channelMemberItem}>
      <div className={styles.channelMemberAvatar}>
        <MemberAvatar info={info} className={styles.channelMemberAvatarImg} />
      </div>
      <div className={styles.channelMemberName}>{info.displayName}</div>
      {onRemove && (
        <button
          type="button"
          className={styles.channelMemberRemoveButton}
          title={removeTitle}
          disabled={removeDisabled}
          onClick={() => onRemove(memberId || info.id, info)}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

export function ChannelMembers() {
  const { t } = useI18n();
  const currentChannel = useStore(s => s.currentChannel);
  const channelMembers = useStore(s => s.channelMembers);
  const isDM = useStore(s => s.channelIsDM);
  const agents = useStore(s => s.agents);
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const currentAgentId = useStore(s => s.currentAgentId);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);

  const agentMap = useMemo(() => buildAgentMap(agents), [agents]);

  if (!currentChannel) return null;

  const resolve = (id: string) => resolveChannelMember(id, userName, userAvatarUrl, agents, currentAgentId, agentMap);

  if (isDM) {
    const peerInfo = resolve(channelMembers[0] || '');
    const selfInfo = resolve(currentAgentId || '');
    return <>{[peerInfo, selfInfo].map(i => <MemberItem key={i.id} info={i} />)}</>;
  }

  const availableAgents = agents.filter((agent) => !channelMembers.includes(agent.id));
  const canRemoveMembers = channelMembers.length > 0;

  const handleAddClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPos({ x: rect.left, y: rect.bottom + 4 });
  };

  const handleRemove = (memberId: string, info: MemberInfo) => {
    if (!currentChannel || !canRemoveMembers) return;
    const confirmed = confirm(t('channel.removeMemberConfirm', { name: info.displayName }));
    if (!confirmed) return;
    setBusyMemberId(memberId);
    removeChannelMember(currentChannel, memberId)
      .then(() => loadChannels())
      .catch((err) => alert(err?.message || t('channel.removeMemberFailed')))
      .finally(() => setBusyMemberId(null));
  };

  const userInfo = resolve('user');
  const menuItems: ContextMenuItem[] = availableAgents.length > 0
    ? availableAgents.map((agent): ContextMenuItem => ({
      label: agent.name || agent.id,
      action: () => {
        if (!currentChannel) return;
        setBusyMemberId(agent.id);
        addChannelMember(currentChannel, agent.id)
          .catch((err) => alert(err?.message || t('channel.addMemberFailed')))
          .finally(() => setBusyMemberId(null));
      },
    }))
    : [{ label: t('channel.noAvailableMembers'), disabled: true }];

  return (
    <>
      <MemberItem info={userInfo} />
      {channelMembers.map((memberId) => (
        <MemberItem
          key={memberId}
          memberId={memberId}
          info={resolve(memberId)}
          onRemove={handleRemove}
          removeDisabled={!canRemoveMembers || busyMemberId === memberId}
          removeTitle={canRemoveMembers ? t('channel.removeMember') : t('channel.minMembers')}
        />
      ))}
      <button
        type="button"
        className={styles.channelMemberAddButton}
        onClick={handleAddClick}
        disabled={!!busyMemberId}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
        <span>{t('channel.addMember')}</span>
      </button>
      {menuPos && (
        <ContextMenu
          items={menuItems}
          position={menuPos}
          onClose={() => setMenuPos(null)}
        />
      )}
    </>
  );
}


function activitySessionPath(activity: AgentPhoneActivity | undefined): string | null {
  const value = activity?.details?.sessionPath;
  return typeof value === 'string' && value ? value : null;
}

function channelTickerText(status: ChannelTickerStatus | null | undefined, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  if (!status) return null;
  const active = status.active;
  if (active) {
    return t('channel.deliveryActive', {
      agent: active.agentId || active.activeAgentId || '',
      done: active.delivered ?? 0,
      total: active.agentCount ?? 0,
    });
  }
  const dueAt = status.nextReminder?.dueAtMs || (status.nextReminder?.dueAt ? Date.parse(status.nextReminder.dueAt) : 0);
  if (dueAt && Number.isFinite(dueAt)) {
    const time = new Date(dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return t('channel.nextReminder', { time });
  }
  if (status.queued) return t('channel.deliveryQueued');
  return null;
}

type PhoneStreamMessage = ChatMessage & { _streamSignature?: string };
type AgentWorkflowState = 'pending' | 'active' | 'done' | 'skipped' | 'error';

interface AgentWorkflowStep {
  key: string;
  label: string;
  value: string;
  state: AgentWorkflowState;
  title?: string;
}

interface AgentLiveWorkflowEvent {
  id: string;
  label: string;
  detail: string;
  state: AgentWorkflowState;
  timestamp: number;
}

const MAX_LIVE_WORKFLOW_EVENTS = 8;

function channelText(
  t: (key: string, vars?: Record<string, string | number>) => string,
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
): string {
  const value = t(key, vars);
  return !value || value === key ? fallback : value;
}

function activityDetailNumber(activity: AgentPhoneActivity | undefined, key: string): number | null {
  const value = activity?.details?.[key];
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

function isActivityWorking(state: string): boolean {
  return ['replying', 'triaging', 'using_tool', 'waiting_permission', 'compacting'].includes(state);
}

function buildAgentWorkflowSteps(
  history: AgentPhoneActivity[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): AgentWorkflowStep[] {
  const latest = history[0];
  const latestState = String(latest?.state || '');
  const states = new Set(history.map((item) => String(item.state || '')));
  const messageCount =
    activityDetailNumber(latest, 'messageCount') ??
    activityDetailNumber(latest, 'totalUnreadCount');
  const hasViewed = states.has('viewed') || history.length > 0;
  const isWorking = isActivityWorking(latestState);
  const hasSession = history.some((item) => !!activitySessionPath(item));
  const hasNoReply = latestState === 'no_reply' || states.has('no_reply');
  const hasError = latestState === 'error';
  const hasReplied = latestState === 'idle' || !!latest?.details?.replyTimestamp;
  const hasOutcome = hasNoReply || hasError || hasReplied;

  return [
    {
      key: 'receive',
      label: channelText(t, 'channel.workflowReceive', '收件'),
      value: messageCount
        ? channelText(t, 'channel.workflowMessageCount', `${messageCount} 条`, { count: messageCount })
        : hasViewed
          ? channelText(t, 'channel.workflowViewed', '已查看')
          : channelText(t, 'channel.workflowWaiting', '等待'),
      state: hasViewed ? 'done' : 'pending',
    },
    {
      key: 'decide',
      label: channelText(t, 'channel.workflowDecide', '研判'),
      value: hasError
        ? channelText(t, 'channel.workflowError', '异常')
        : hasNoReply
          ? channelText(t, 'channel.workflowNoReply', '不发言')
          : hasOutcome
            ? channelText(t, 'channel.workflowDecided', '已决定')
            : isWorking
              ? channelText(t, 'channel.workflowRunning', '处理中')
              : channelText(t, 'channel.workflowWaiting', '等待'),
      state: hasError ? 'error' : hasOutcome ? 'done' : isWorking ? 'active' : hasViewed ? 'active' : 'pending',
    },
    {
      key: 'execute',
      label: channelText(t, 'channel.workflowExecute', '执行'),
      value: hasError
        ? channelText(t, 'channel.workflowInterrupted', '已中断')
        : hasNoReply
          ? channelText(t, 'channel.workflowSkipped', '跳过')
          : hasSession
            ? channelText(t, 'channel.workflowSessionLinked', '会话已连接')
            : isWorking
              ? channelText(t, 'channel.workflowRunning', '运行中')
              : channelText(t, 'channel.workflowWaiting', '等待'),
      state: hasError ? 'error' : hasNoReply ? 'skipped' : hasSession || hasReplied ? 'done' : isWorking ? 'active' : 'pending',
    },
    {
      key: 'report',
      label: channelText(t, 'channel.workflowReport', '回报'),
      value: hasError
        ? channelText(t, 'channel.workflowFailed', '失败')
        : hasNoReply
          ? channelText(t, 'channel.workflowNoReply', '不发言')
          : hasReplied
            ? channelText(t, 'channel.workflowReplied', '已回复')
            : isWorking
              ? channelText(t, 'channel.workflowAwaitReport', '等待回报')
              : channelText(t, 'channel.workflowWaiting', '等待'),
      state: hasError ? 'error' : hasNoReply ? 'skipped' : hasReplied ? 'done' : isWorking ? 'active' : 'pending',
    },
  ];
}

function AgentWorkflowStrip({ steps }: { steps: AgentWorkflowStep[] }) {
  return (
    <div className={styles.agentWorkflowStrip} aria-label="Agent 工作流步骤">
      {steps.map((step) => (
        <div
          key={step.key}
          className={styles.agentWorkflowStep}
          data-state={step.state}
          title={step.title || `${step.label}: ${step.value}`}
        >
          <span className={styles.agentWorkflowDot} aria-hidden="true" />
          <span className={styles.agentWorkflowLabel}>{step.label}</span>
          <strong>{step.value}</strong>
        </div>
      ))}
    </div>
  );
}

function upsertLiveWorkflowEvent(
  events: AgentLiveWorkflowEvent[],
  nextEvent: AgentLiveWorkflowEvent,
): AgentLiveWorkflowEvent[] {
  const index = events.findIndex((event) => event.id === nextEvent.id);
  const next = [...events];
  if (index >= 0) {
    next[index] = { ...next[index], ...nextEvent, timestamp: next[index].timestamp };
  } else {
    next.push(nextEvent);
  }
  return next.slice(-MAX_LIVE_WORKFLOW_EVENTS);
}

function AgentLiveWorkflowTimeline({ events }: { events: AgentLiveWorkflowEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className={styles.agentLiveWorkflowTimeline} aria-label="实时执行步骤">
      {events.map((event) => (
        <div key={event.id} className={styles.agentLiveWorkflowItem} data-state={event.state}>
          <span className={styles.agentLiveWorkflowRail} aria-hidden="true" />
          <div className={styles.agentLiveWorkflowText}>
            <strong>{event.label}</strong>
            <span>{event.detail}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function createPhoneStreamMessage(agentId: string, turnToken: number, streamSignature?: string | null): PhoneStreamMessage {
  return {
    id: `${PHONE_STREAM_MESSAGE_PREFIX}-${agentId}-${turnToken}`,
    role: 'assistant',
    blocks: [],
    ...(streamSignature ? { turnTraceId: streamSignature, _streamSignature: streamSignature } : {}),
  };
}

function upsertPhoneBlock(
  blocks: ContentBlock[],
  match: (block: ContentBlock) => boolean,
  nextBlock: ContentBlock,
  insertAtStart = false,
): ContentBlock[] {
  const idx = blocks.findIndex(match);
  if (idx >= 0) {
    const next = [...blocks];
    next[idx] = nextBlock;
    return next;
  }
  return insertAtStart ? [nextBlock, ...blocks] : [...blocks, nextBlock];
}

type PhoneStreamTextBlock = Extract<ContentBlock, { type: 'text' }> & { _raw?: string; source?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function streamEventSignature(event: StreamKeyEvent): string | null {
  const turnTraceId = typeof event.turnTraceId === 'string' && event.turnTraceId.trim()
    ? event.turnTraceId.trim()
    : '';
  if (turnTraceId) return turnTraceId;
  const streamId = typeof event.streamId === 'string' && event.streamId.trim()
    ? event.streamId.trim()
    : '';
  return streamId || null;
}

function streamWorkflowKey(event: StreamKeyEvent, suffix: string): string {
  return `${streamEventSignature(event) || 'live'}:${suffix}`;
}

function streamBlockWorkflow(block: unknown): Pick<AgentLiveWorkflowEvent, 'label' | 'detail' | 'state'> | null {
  if (!block || typeof block !== 'object') return null;
  const data = block as Record<string, unknown>;
  const type = String(data.type || '');
  if (type === 'subagent') {
    const status = String(data.streamStatus || '');
    return {
      label: '子任务',
      detail: String(data.taskTitle || data.task || '正在执行'),
      state: status === 'failed' || status === 'aborted' ? 'error' : status === 'done' ? 'done' : 'active',
    };
  }
  if (type === 'media_generation') {
    const status = String(data.status || '');
    return {
      label: '媒体生成',
      detail: String(data.kind || data.taskId || '生成中'),
      state: status === 'failed' || status === 'aborted' ? 'error' : status === 'pending' ? 'active' : 'done',
    };
  }
  if (type === 'artifact' || type === 'file') {
    return {
      label: type === 'artifact' ? '产物' : '文件',
      detail: String(data.title || data.label || data.filePath || '已生成'),
      state: 'done',
    };
  }
  return null;
}

export function AgentPhoneSessionPreview({ sessionPath, agentId, agentYuan }: {
  sessionPath: string | null;
  agentId: string;
  agentYuan?: string | null;
}) {
  const { t } = useI18n();
  const session = useStore(s => (sessionPath ? sessionScopedValue(s, s.chatSessions, sessionPath) ?? null : null));
  const items = session?.items ?? EMPTY_CHAT_ITEMS;
  const [loading, setLoading] = useState(false);
  const [streamMessages, setStreamMessages] = useState<PhoneStreamMessage[]>([]);
  const [streamRevision, setStreamRevision] = useState(0);
  const [liveWorkflowEvents, setLiveWorkflowEvents] = useState<AgentLiveWorkflowEvent[]>([]);
  const streamTurnRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const moodYuan = agentYuan || 'gsap';

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    stickToBottomRef.current = true;
    streamTurnRef.current = 0;
    setStreamMessages([]);
    setStreamRevision(0);
    setLiveWorkflowEvents([]);
    requestAnimationFrame(scrollToBottom);
  }, [scrollToBottom, sessionPath]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const syncStickyState = () => {
      stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    syncStickyState();
    el.addEventListener('scroll', syncStickyState, { passive: true });
    return () => el.removeEventListener('scroll', syncStickyState);
  }, [sessionPath]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const raf = window.requestAnimationFrame(scrollToBottom);
    return () => window.cancelAnimationFrame(raf);
  }, [items.length, loading, scrollToBottom, streamRevision]);

  useEffect(() => {
    const content = contentRef.current;
    const ResizeObserverImpl = window.ResizeObserver;
    if (!content || !ResizeObserverImpl) return;
    const ro = new ResizeObserverImpl(() => {
      if (stickToBottomRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom, items.length, streamRevision]);

  useEffect(() => {
    if (!sessionPath || items.length > 0 || loading) return;
    let cancelled = false;
    setLoading(true);
    void loadMessages(sessionPath)
      .catch((err: unknown) => console.warn('[channels] load phone session failed:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [items.length, loading, sessionPath]);

  useEffect(() => {
    if (!sessionPath) return;

    const updateStreamMessage = (
      event: StreamKeyEvent,
      updater: (message: PhoneStreamMessage) => PhoneStreamMessage,
    ) => {
      const signature = streamEventSignature(event);
      setStreamMessages((prev) => {
        const targetIndex = signature
          ? prev.findIndex((message) => message._streamSignature === signature)
          : prev.length - 1;
        const next = [...prev];
        const base = targetIndex >= 0
          ? next[targetIndex]
          : createPhoneStreamMessage(agentId, ++streamTurnRef.current, signature);
        const updated = {
          ...updater(base),
          ...(signature ? { turnTraceId: signature, _streamSignature: signature } : {}),
        };
        if (targetIndex >= 0) next[targetIndex] = updated;
        else next.push(updated);
        return next;
      });
      setStreamRevision((value) => value + 1);
    };

    const markWorkflowEvent = (
      event: StreamKeyEvent,
      suffix: string,
      patch: Pick<AgentLiveWorkflowEvent, 'label' | 'detail' | 'state'>,
    ) => {
      setLiveWorkflowEvents((prev) => upsertLiveWorkflowEvent(prev, {
        id: streamWorkflowKey(event, suffix),
        timestamp: Date.now(),
        ...patch,
      }));
    };

    const unsubscribe = subscribeStreamKey(sessionPath, (event: StreamKeyEvent) => {
      switch (event.type) {
        case 'thinking_start':
          markWorkflowEvent(event, 'thinking', { label: '思考', detail: '整理频道上下文', state: 'active' });
          updateStreamMessage(event, (message) => ({
            ...message,
            blocks: upsertPhoneBlock(
              message.blocks || [],
              (block) => block.type === 'thinking',
              { type: 'thinking', content: '', sealed: false },
              true,
            ),
          }));
          break;
        case 'thinking_delta':
          updateStreamMessage(event, (message) => {
            const blocks = message.blocks || [];
            const thinking = blocks.find((block) => block.type === 'thinking') as Extract<ContentBlock, { type: 'thinking' }> | undefined;
            return {
              ...message,
              blocks: upsertPhoneBlock(
                blocks,
                (block) => block.type === 'thinking',
                { type: 'thinking', content: `${thinking?.content || ''}${event.delta || ''}`, sealed: false },
                true,
              ),
            };
          });
          break;
        case 'thinking_end':
          markWorkflowEvent(event, 'thinking', { label: '思考', detail: '已完成', state: 'done' });
          updateStreamMessage(event, (message) => {
            const blocks = message.blocks || [];
            const thinking = blocks.find((block) => block.type === 'thinking') as Extract<ContentBlock, { type: 'thinking' }> | undefined;
            return {
              ...message,
              blocks: upsertPhoneBlock(
                blocks,
                (block) => block.type === 'thinking',
                { type: 'thinking', content: thinking?.content || '', sealed: true },
                true,
              ),
            };
          });
          break;
        case 'mood_start':
          updateStreamMessage(event, (message) => ({
            ...message,
            blocks: upsertPhoneBlock(
              message.blocks || [],
              (block) => block.type === 'mood',
              { type: 'mood', yuan: moodYuan, text: '' },
            ),
          }));
          break;
        case 'mood_text':
          updateStreamMessage(event, (message) => {
            const blocks = message.blocks || [];
            const mood = blocks.find((block) => block.type === 'mood') as Extract<ContentBlock, { type: 'mood' }> | undefined;
            return {
              ...message,
              blocks: upsertPhoneBlock(
                blocks,
                (block) => block.type === 'mood',
                { type: 'mood', yuan: moodYuan, text: `${mood?.text || ''}${event.delta || ''}` },
              ),
            };
          });
          break;
        case 'text_delta':
          markWorkflowEvent(event, 'generating', { label: '生成', detail: '组织回复内容', state: 'active' });
          updateStreamMessage(event, (message) => {
            const blocks = message.blocks || [];
            const textBlock = blocks.find((block) => block.type === 'text') as PhoneStreamTextBlock | undefined;
            const prevText = textBlock?.source ?? textBlock?._raw ?? '';
            const nextText = `${prevText}${event.delta || ''}`;
            return {
              ...message,
              blocks: upsertPhoneBlock(
                blocks,
                (block) => block.type === 'text',
                { type: 'text', html: renderMarkdown(nextText), source: nextText } as PhoneStreamTextBlock,
              ),
            };
          });
          break;
        case 'tool_start':
          markWorkflowEvent(event, `tool:${String(event.name || 'tool')}`, {
            label: '工具',
            detail: String(event.name || '调用工具'),
            state: 'active',
          });
          updateStreamMessage(event, (message) => {
            const blocks = [...(message.blocks || [])];
            const groupIndex = [...blocks]
              .reverse()
              .findIndex((block) => block.type === 'tool_group' && block.tools.some((tool) => !tool.done));
            const actualIndex = groupIndex >= 0 ? blocks.length - 1 - groupIndex : -1;
            if (actualIndex >= 0) {
              const group = blocks[actualIndex] as Extract<ContentBlock, { type: 'tool_group' }>;
              blocks[actualIndex] = {
                ...group,
                tools: [...group.tools, { name: event.name || '', args: asRecord(event.args), done: false, success: false }],
              };
            } else {
              blocks.push({
                type: 'tool_group',
                tools: [{ name: event.name || '', args: asRecord(event.args), done: false, success: false }],
                collapsed: false,
              });
            }
            return { ...message, blocks };
          });
          break;
        case 'tool_end':
          markWorkflowEvent(event, `tool:${String(event.name || 'tool')}`, {
            label: '工具',
            detail: String(event.name || '工具') + (event.success === false ? ' 失败' : ' 完成'),
            state: event.success === false ? 'error' : 'done',
          });
          updateStreamMessage(event, (message) => {
            const blocks = [...(message.blocks || [])];
            for (let i = blocks.length - 1; i >= 0; i -= 1) {
              const block = blocks[i];
              if (block.type !== 'tool_group') continue;
              const toolIndex = block.tools.findIndex((tool) => tool.name === event.name && !tool.done);
              if (toolIndex < 0) continue;
              const tools = [...block.tools];
              tools[toolIndex] = {
                ...tools[toolIndex],
                done: true,
                success: !!event.success,
                details: event.details as ToolCall['details'],
              };
              blocks[i] = { ...block, tools, collapsed: tools.length > 1 && tools.every((tool) => tool.done) };
              break;
            }
            return { ...message, blocks };
          });
          break;
        case 'content_block':
          if (event.block) {
            const workflowBlock = streamBlockWorkflow(event.block);
            if (workflowBlock) {
              const blockType = String((event.block as Record<string, unknown>).type || 'content');
              markWorkflowEvent(event, `block:${blockType}`, workflowBlock);
            }
            updateStreamMessage(event, (message) => ({
              ...message,
              blocks: [...(message.blocks || []), event.block as ContentBlock],
            }));
          }
          break;
        case 'turn_end':
          setLiveWorkflowEvents((prev) => upsertLiveWorkflowEvent(
            prev.map((item) => (item.state === 'active' ? { ...item, state: 'done' as const } : item)),
            {
              id: streamWorkflowKey(event, 'done'),
              label: '完成',
              detail: '本轮执行结束',
              state: 'done',
              timestamp: Date.now(),
            },
          ));
          void loadMessages(sessionPath).then(() => setStreamMessages([])).catch(() => {});
          break;
        case 'error':
          markWorkflowEvent(event, 'error', {
            label: '异常',
            detail: typeof event.message === 'string' ? event.message : '执行失败',
            state: 'error',
          });
          break;
        default:
          break;
      }
    });

    return unsubscribe;
  }, [agentId, moodYuan, sessionPath]);

  const phoneNotice = t('channel.phoneReceivedNewMessages') || 'Received new channel messages';
  const displayItems = useMemo(() => {
    const mergedItems = streamMessages.length > 0
      ? [...items, ...streamMessages.map((message) => ({ type: 'message' as const, data: message }))]
      : items;
    return mergedItems.map((item) => {
      if (item.type !== 'message' || item.data.role !== 'user') return item;
      return {
        ...item,
        data: {
          ...item.data,
          text: phoneNotice,
          textHtml: renderMarkdown(phoneNotice),
          attachments: [],
          deskContext: null,
          skills: [],
        },
      };
    });
  }, [items, phoneNotice, streamMessages]);

  return (
    <div ref={scrollRef} className={`${styles.agentActivityTranscriptScroll} ${chatStyles.subagentPreviewTranscript}`}>
      <div ref={contentRef}>
        <AgentLiveWorkflowTimeline events={liveWorkflowEvents} />
        {!sessionPath ? (
          <div className={styles.agentActivityEmpty}>{t('channel.agentIdle')}</div>
        ) : loading && displayItems.length === 0 ? (
          <div className={styles.agentActivityEmpty}>{t('common.loading')}</div>
        ) : displayItems.length === 0 ? (
          <div className={styles.agentActivityEmpty}>{t('channel.agentIdle')}</div>
        ) : (
          <ChatTranscript
            items={displayItems}
            sessionPath={sessionPath}
            agentId={agentId}
            readOnly
            hideUserIdentity
          />
        )}
      </div>
    </div>
  );
}

export function ChannelAgentActivityPanel() {
  const { t } = useI18n();
  const currentChannel = useStore(s => s.currentChannel);
  const channelMembers = useStore(s => s.channelMembers);
  const isDM = useStore(s => s.channelIsDM);
  const agents = useStore(s => s.agents);
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const currentAgentId = useStore(s => s.currentAgentId);
  const allActivities = useStore(s => s.channelAgentActivities);
  const tickerStatuses = useStore(s => s.channelTickerStatus);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const agentMap = useMemo(() => buildAgentMap(agents), [agents]);

  if (!currentChannel) return null;

  const ids = isDM
    ? [currentAgentId, channelMembers[0]].filter((id): id is string => !!id)
    : channelMembers;
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return null;

  const byAgent = allActivities?.[currentChannel] || {};
  const tickerText = channelTickerText(tickerStatuses?.[currentChannel], t);
  const resolve = (id: string) => resolveChannelMember(id, userName, userAvatarUrl, agents, currentAgentId, agentMap);

  return (
    <div className="universal-card jian-card">
      <div className="channel-info-section">
        <div className={styles.agentActivityHeader}>
          <div className="channel-info-label">{t('channel.agentActivity')}</div>
        </div>
        {tickerText && <div className={styles.agentActivityScheduler}>{tickerText}</div>}
        <div className={styles.agentActivityList}>
          {uniqueIds.map((agentId) => {
            const info = resolve(agentId);
            const history = byAgent[agentId] || [];
            const latest = history[0];
            const open = expanded[agentId] === true;
            const sessionPath = history.map(activitySessionPath).find((path): path is string => !!path) || null;
            return (
              <div key={agentId} className={styles.agentActivityItem}>
                <button
                  type="button"
                  className={styles.agentActivityRow}
                  onClick={() => setExpanded(prev => ({ ...prev, [agentId]: !prev[agentId] }))}
                  aria-expanded={open}
                >
                  <span className={styles.agentActivityAvatar}>
                    <MemberAvatar info={info} className={styles.agentActivityAvatarImg} />
                  </span>
                  <span className={styles.agentActivityName}>{info.displayName}</span>
                  <span className={styles.agentActivitySummary}>{latest?.summary || t('channel.agentIdle')}</span>
                </button>
                {history.length > 0 && (
                  <AgentWorkflowStrip steps={buildAgentWorkflowSteps(history, t)} />
                )}
                {open && (
                  <div className={styles.agentActivityDetails}>
                    <AgentPhoneSessionPreview
                      sessionPath={sessionPath}
                      agentId={agentId}
                      agentYuan={info.yuan}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function parseOptionalIntInput(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function modelKey(model: { id: string; provider: string } | null | undefined): string {
  return model ? `${model.provider}/${model.id}` : '';
}

export function ChannelAgentSettingsPanel() {
  const { t } = useI18n();
  const currentChannel = useStore(s => s.currentChannel);
  const isDM = useStore(s => s.channelIsDM);
  const models = useStore(s => s.models);
  const toolMode = useStore(s => s.channelAgentPhoneToolMode);
  const replyMinChars = useStore(s => s.channelAgentReplyMinChars);
  const replyMaxChars = useStore(s => s.channelAgentReplyMaxChars);
  const proactiveEnabled = useStore(s => s.channelAgentProactiveEnabled);
  const reminderIntervalMinutes = useStore(s => s.channelAgentReminderIntervalMinutes);
  const guardLimit = useStore(s => s.channelAgentGuardLimit);
  const modelOverrideEnabled = useStore(s => s.channelAgentModelOverrideEnabled);
  const modelOverrideModel = useStore(s => s.channelAgentModelOverrideModel);
  const [saving, setSaving] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [draftMin, setDraftMin] = useState(replyMinChars ? String(replyMinChars) : '');
  const [draftMax, setDraftMax] = useState(replyMaxChars ? String(replyMaxChars) : '');
  const [draftReminder, setDraftReminder] = useState(String(reminderIntervalMinutes || 31));
  const [draftGuardLimit, setDraftGuardLimit] = useState(String(guardLimit || 36));
  const modelSelectRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setDraftMin(replyMinChars ? String(replyMinChars) : '');
    setDraftMax(replyMaxChars ? String(replyMaxChars) : '');
    setDraftReminder(String(reminderIntervalMinutes || 31));
    setDraftGuardLimit(String(guardLimit || 36));
  }, [currentChannel, replyMinChars, replyMaxChars, reminderIntervalMinutes, guardLimit]);

  useEffect(() => {
    if (models.length > 0) return;
    void gsapFetch('/api/models')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data?.models) useStore.setState({ models: data.models });
      })
      .catch((err: unknown) => console.warn('[channels] load models failed:', err));
  }, [models.length]);

  useEffect(() => {
    if (!modelOpen) return;
    const handler = (event: MouseEvent) => {
      if (modelSelectRef.current && !modelSelectRef.current.contains(event.target as Node)) {
        setModelOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelOpen]);

  if (!currentChannel) return null;

  const saveSettings = async (patch: Parameters<typeof saveConversationAgentPhoneSettings>[0]) => {
    setSaving(true);
    try {
      await saveConversationAgentPhoneSettings(patch);
    } catch (err: any) {
      console.error('[channels] save phone settings failed:', err);
      alert(err?.message || t('channel.settingsSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const commitTextSettings = () => {
    const min = parseOptionalIntInput(draftMin);
    const max = parseOptionalIntInput(draftMax);
    const reminder = parseOptionalIntInput(draftReminder) || 31;
    const guard = parseOptionalIntInput(draftGuardLimit) || 36;
    if (min && max && min > max) {
      alert(t('channel.replyRangeInvalid'));
      return;
    }
    void saveSettings({
      replyMinChars: min,
      replyMaxChars: max,
      ...(!isDM ? { reminderIntervalMinutes: reminder, guardLimit: guard } : {}),
    });
  };

  const changeMode = (mode: 'read_only' | 'write') => {
    if (mode === toolMode || saving) return;
    void saveSettings({ mode });
  };

  const changeProactiveEnabled = (enabled: boolean) => {
    if (saving || enabled === proactiveEnabled) return;
    void saveSettings({ proactiveEnabled: enabled });
  };

  const changeModelOverrideEnabled = (enabled: boolean) => {
    if (saving || enabled === modelOverrideEnabled) return;
    if (!enabled) {
      void saveSettings({ modelOverrideEnabled: false, modelOverrideModel: modelOverrideModel });
      return;
    }
    const selected = modelOverrideModel || models[0] || null;
    if (!selected) {
      alert(t('channel.noModelsAvailable'));
      return;
    }
    void saveSettings({
      modelOverrideEnabled: true,
      modelOverrideModel: { id: selected.id, provider: selected.provider },
    });
  };

  const selectOverrideModel = (model: Model) => {
    setModelOpen(false);
    void saveSettings({
      modelOverrideEnabled: true,
      modelOverrideModel: { id: model.id, provider: model.provider },
    });
  };

  const selectedModel = modelOverrideModel
    ? models.find(m => m.id === modelOverrideModel.id && m.provider === modelOverrideModel.provider)
    : null;
  const modelLabel = selectedModel?.name || modelOverrideModel?.id || t('channel.selectModel');
  const groupedModels = models.reduce<Record<string, Model[]>>((acc, model) => {
    const key = model.provider || '';
    if (!acc[key]) acc[key] = [];
    acc[key].push(model);
    return acc;
  }, {});
  const providerKeys = Object.keys(groupedModels);
  const hasMultipleProviders = providerKeys.length > 1 || (providerKeys.length === 1 && providerKeys[0] !== '');

  return (
    <div className={`universal-card jian-card ${styles.agentSettingsCard}`}>
      <div className="channel-info-section">
        <div className={styles.agentSettingsHeader}>
          <div className="channel-info-label">{t('channel.agentSettings')}</div>
        </div>
        <div className={!isDM ? styles.agentSettingsInlineGrid : undefined}>
          <div className={styles.agentSettingsField}>
            <div className={styles.agentSettingsLabel}>{t('channel.toolPermission')}</div>
            <div className={`${styles.agentToolModeToggle}${!isDM ? ` ${styles.agentToolModeToggleFill}` : ''}`}>
              <button
                type="button"
                className={`${styles.agentToolModeButton}${toolMode === 'read_only' ? ` ${styles.agentToolModeButtonActive}` : ''}`}
                disabled={saving}
                onClick={() => changeMode('read_only')}
              >
                {t('channel.toolReadOnly')}
              </button>
              <button
                type="button"
                className={`${styles.agentToolModeButton}${toolMode === 'write' ? ` ${styles.agentToolModeButtonActive}` : ''}`}
                disabled={saving}
                onClick={() => changeMode('write')}
              >
                {t('channel.toolWrite')}
              </button>
            </div>
          </div>
          {!isDM && (
            <div className={styles.agentSettingsField}>
              <div className={styles.agentSettingsLabel}>{t('channel.guardLimit')}</div>
              <input
                className={styles.agentReplyRangeInput}
                inputMode="numeric"
                placeholder="36"
                value={draftGuardLimit}
                onChange={(event) => setDraftGuardLimit(event.target.value.replace(/[^\d]/g, ''))}
                onBlur={commitTextSettings}
                disabled={saving}
              />
            </div>
          )}
        </div>
        {!isDM && (
          <div className={`${styles.agentSettingsInlineGrid} ${styles.agentSettingsInlineGridSpaced}`}>
            <div className={styles.agentSettingsField}>
              <div className={styles.agentSettingsLabel}>{t('channel.proactiveInitiation')}</div>
              <div className={`${styles.agentToolModeToggle} ${styles.agentToolModeToggleFill}`}>
                <button
                  type="button"
                  className={`${styles.agentToolModeButton}${!proactiveEnabled ? ` ${styles.agentToolModeButtonActive}` : ''}`}
                  disabled={saving}
                  onClick={() => changeProactiveEnabled(false)}
                >
                  {t('channel.proactiveOff')}
                </button>
                <button
                  type="button"
                  className={`${styles.agentToolModeButton}${proactiveEnabled ? ` ${styles.agentToolModeButtonActive}` : ''}`}
                  disabled={saving}
                  onClick={() => changeProactiveEnabled(true)}
                >
                  {t('channel.proactiveOn')}
                </button>
              </div>
            </div>
            <div className={styles.agentSettingsField}>
              <div className={styles.agentSettingsLabel}>{t('channel.proactiveInterval')}</div>
              <input
                className={styles.agentReplyRangeInput}
                inputMode="numeric"
                placeholder="31"
                value={draftReminder}
                onChange={(event) => setDraftReminder(event.target.value.replace(/[^\d]/g, ''))}
                onBlur={commitTextSettings}
                disabled={saving || !proactiveEnabled}
              />
            </div>
          </div>
        )}
        <div className={styles.agentSettingsField}>
          <div className={styles.agentSettingsLabel}>{t('channel.replyRange')}</div>
          <div className={styles.agentReplyRangeRow}>
            <input
              className={styles.agentReplyRangeInput}
              inputMode="numeric"
              placeholder={t('channel.replyMinPlaceholder')}
              value={draftMin}
              onChange={(event) => setDraftMin(event.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitTextSettings}
              disabled={saving}
            />
            <span className={styles.agentReplyRangeSep}>-</span>
            <input
              className={styles.agentReplyRangeInput}
              inputMode="numeric"
              placeholder={t('channel.replyMaxPlaceholder')}
              value={draftMax}
              onChange={(event) => setDraftMax(event.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitTextSettings}
              disabled={saving}
            />
          </div>
        </div>
        {!isDM && (
          <div className={styles.agentSettingsField}>
            <div className={styles.agentSettingsLabel}>{t('channel.modelOverride')}</div>
            <div className={styles.agentModelOverrideRow}>
              <div className={styles.agentToolModeToggle}>
                <button
                  type="button"
                  className={`${styles.agentToolModeButton}${!modelOverrideEnabled ? ` ${styles.agentToolModeButtonActive}` : ''}`}
                  disabled={saving}
                  onClick={() => changeModelOverrideEnabled(false)}
                >
                  {t('channel.modelDefault')}
                </button>
                <button
                  type="button"
                  className={`${styles.agentToolModeButton}${modelOverrideEnabled ? ` ${styles.agentToolModeButtonActive}` : ''}`}
                  disabled={saving}
                  onClick={() => changeModelOverrideEnabled(true)}
                >
                  {t('channel.modelOverrideOn')}
                </button>
              </div>
              <div className={styles.agentModelSelect} ref={modelSelectRef}>
                <button
                  type="button"
                  className={styles.agentModelSelectButton}
                  disabled={!modelOverrideEnabled || saving}
                  onClick={() => setModelOpen(open => !open)}
                >
                  <span>{modelLabel}</span>
                  <span className={styles.agentModelSelectArrow}>v</span>
                </button>
                {modelOpen && modelOverrideEnabled && (
                  <div className={styles.agentModelDropdown}>
                    {providerKeys.map(provider => (
                      <div key={provider || '__none'}>
                        {hasMultipleProviders && (
                          <div className={styles.agentModelGroupHeader}>{provider || '-'}</div>
                        )}
                        {groupedModels[provider].map(model => (
                          <button
                            key={modelKey(model)}
                            type="button"
                            className={`${styles.agentModelOption}${modelKey(modelOverrideModel) === modelKey(model) ? ` ${styles.agentModelOptionActive}` : ''}`}
                            onClick={() => selectOverrideModel(model)}
                          >
                            {model.name || model.id}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChannelInput() {
  const { t } = useI18n();
  const currentChannel = useStore(s => s.currentChannel);
  const isDM = useStore(s => s.channelIsDM);
  const channelMembers = useStore(s => s.channelMembers);
  const agents = useStore(s => s.agents);
  const userName = useStore(s => s.userName);
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const currentAgentId = useStore(s => s.currentAgentId);
  const attachedFiles = useStore(s => Array.isArray(s.attachedFiles) ? s.attachedFiles : []);
  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearAttachedFiles = useStore(s => s.clearAttachedFiles);
  const pendingChannelResourceAction = useStore(s => s.pendingChannelResourceAction);
  const consumePendingChannelResourceAction = useStore(s => s.consumePendingChannelResourceAction);

  const agentMap = useMemo(() => buildAgentMap(agents), [agents]);
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [mentionActive, setMentionActive] = useState(false);
  const [mentionItems, setMentionItems] = useState<MemberInfo[]>([]);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [mentionStartPos, setMentionStartPos] = useState(-1);
  const [dragActive, setDragActive] = useState(false);
  const [skillMenuOpen, setSkillMenuOpen] = useState(false);
  const [skillSelectedIdx, setSkillSelectedIdx] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<SlashItem | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skillMenuRef = useRef<HTMLDivElement>(null);
  const skillBtnRef = useRef<HTMLButtonElement>(null);
  const consumedResourceActionIdsRef = useRef<Set<string>>(new Set());
  const attachLabel = window.t?.('input.attachFiles') || '添加文件';
  const skillMenuLabel = window.t?.('input.commandMenu') || '技能';
  const skillItems = useSkillSlashItems();
  const filteredSkillItems = useMemo(() => {
    const text = inputValue.trim();
    if (text.startsWith('/')) return getSlashMatches(text, skillItems);
    return skillItems;
  }, [inputValue, skillItems]);

  const closeSkillMenu = useCallback(() => {
    setSkillMenuOpen(false);
    setSkillSelectedIdx(0);
  }, []);

  const resolveChannelInputText = useCallback(() => {
    const text = inputValue.trim();
    if (selectedSkill) {
      return [buildChannelSkillLink(selectedSkill), inputValue.trim()].filter(Boolean).join(' ').trim();
    }
    const parsed = parseSlashInput(text);
    if (!parsed.name) return text;
    const item = skillItems.find(skill => skill.name.toLowerCase() === parsed.name && skill.filePath);
    if (!item) return text;
    return [buildChannelSkillLink(item), parsed.args].filter(Boolean).join(' ').trim();
  }, [inputValue, selectedSkill, skillItems]);

  const handleSend = useCallback(async () => {
    const text = resolveChannelInputText();
    const blocks = buildChannelFileBlocks(attachedFiles);
    if (sending || (!text && blocks.length === 0)) return;
    setSending(true);
    try {
      await sendChannelMessage(text, { blocks });
      setInputValue('');
      setSelectedSkill(null);
      closeSkillMenu();
      if (attachedFiles.length > 0) clearAttachedFiles();
    }
    finally { setSending(false); }
  }, [attachedFiles, clearAttachedFiles, closeSkillMenu, resolveChannelInputText, sending]);

  const handleAttachFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    try {
      const { paths, nameMap } = await resolveBrowserFilePaths(files);
      if (paths.length > 0) await attachFilesFromPaths(paths, nameMap, { channelId: currentChannel });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      useStore.getState().addToast?.(message, 'error', 6000);
    }
  }, [currentChannel]);

  const handleFileInputChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    await handleAttachFiles(files);
  }, [handleAttachFiles]);

  const handleAttach = useCallback(async () => {
    try {
      const paths = await window.platform?.selectFiles?.();
      if (paths && paths.length > 0) {
        await attachFilesFromPaths(paths, {}, { channelId: currentChannel });
        return;
      }
    } catch (err) {
      console.warn('[channels] native file picker failed, falling back to browser picker:', err);
    }
    fileInputRef.current?.click();
  }, [currentChannel]);

  const hasDraggedFiles = (event: React.DragEvent<HTMLElement>) => (
    Array.from(event.dataTransfer?.types || []).includes('Files')
  );

  const handleDragOverFiles = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, []);

  const handleDragLeaveFiles = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }, []);

  const handleDropFiles = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    setDragActive(false);
    await handleAttachFiles(files);
  }, [handleAttachFiles]);

  const handlePasteFiles = useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue;
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (!match) return;
          const [, mimeType, base64Data] = match;
          const ext = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png');
          const name = `${t('input.pastedImage')}.${ext}`;
          try {
            const res = await gsapFetch('/api/upload-blob', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name,
                base64Data,
                mimeType,
                resourceScope: 'channel',
                channelId: currentChannel,
              }),
            });
            const data = await res.json();
            const upload = data?.uploads?.[0];
            if (upload?.dest) {
              addAttachedFile({
                fileId: upload.fileId,
                path: upload.dest,
                name: upload.name || name,
                isDirectory: false,
                mimeType,
                ...(upload.resource ? { resource: upload.resource } : {}),
              });
            } else {
              notifyPasteUploadFailure(t, upload?.error);
              console.warn('[channels paste] upload-blob failed', upload?.error || data);
            }
          } catch (err) {
            notifyPasteUploadFailure(t, err);
            console.warn('[channels paste] upload-blob error', err);
          }
        };
        reader.readAsDataURL(file);
        return;
      }
    }

    const files = Array.from(event.clipboardData?.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    await handleAttachFiles(files);
  }, [addAttachedFile, currentChannel, handleAttachFiles, t]);

  const checkMention = useCallback(() => {
    if (!inputRef.current) return;
    const val = inputRef.current.value;
    const pos = inputRef.current.selectionStart ?? 0;
    const before = val.slice(0, pos);
    const atIdx = before.lastIndexOf('@');
    if (atIdx < 0 || (atIdx > 0 && /\S/.test(before[atIdx - 1]))) { setMentionActive(false); return; }
    const keyword = before.slice(atIdx + 1).toLowerCase();
    setMentionStartPos(atIdx);
    const members = (channelMembers || [])
      .map(id => resolveChannelMember(id, userName, userAvatarUrl, agents, currentAgentId, agentMap))
      .filter(m => !m.isUser);
    const filtered = keyword
      ? members.filter(m => m.displayName.toLowerCase().includes(keyword) || (m.yuan || '').toLowerCase().includes(keyword))
      : members;
    if (filtered.length === 0) { setMentionActive(false); return; }
    setMentionItems(filtered);
    setMentionSelectedIdx(0);
    setMentionActive(true);
  }, [channelMembers, agents, agentMap, userName, userAvatarUrl, currentAgentId]);

  const insertMention = useCallback((name: string) => {
    if (!inputRef.current || mentionStartPos < 0) return;
    const val = inputRef.current.value;
    const pos = inputRef.current.selectionStart ?? 0;
    const before = val.slice(0, mentionStartPos);
    const inserted = `@${name} `;
    setInputValue(before + inserted + val.slice(pos));
    setMentionActive(false);
    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      const c = before.length + inserted.length;
      inputRef.current.setSelectionRange(c, c);
      inputRef.current.focus();
    });
  }, [mentionStartPos]);

  const handleSlashSkillPick = useCallback((item: SlashItem) => {
    const parsed = parseSlashInput(inputValue);
    const args = parsed.args;
    if (item.filePath) {
      setSelectedSkill(item);
      setInputValue(args);
    } else {
      setSelectedSkill(null);
      const next = buildSlashDraftText(item.name, inputValue);
      setInputValue(`${next}${next.endsWith(' ') ? '' : ' '}`);
    }
    closeSkillMenu();
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      const end = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(end, end);
    });
  }, [closeSkillMenu, inputValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMenuOpen && filteredSkillItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSkillSelectedIdx(i => (i + 1) % filteredSkillItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillSelectedIdx(i => (i - 1 + filteredSkillItems.length) % filteredSkillItems.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const item = filteredSkillItems[skillSelectedIdx];
        if (item) handleSlashSkillPick(item);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSkillMenu();
        return;
      }
    }
    if (selectedSkill && e.key === 'Backspace' && !inputValue) {
      e.preventDefault();
      setSelectedSkill(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !(e.nativeEvent as any).isComposing) {
      e.preventDefault();
      if (mentionActive) { const s = mentionItems[mentionSelectedIdx]; if (s) insertMention(s.displayName); }
      else handleSend();
      return;
    }
    if (!mentionActive) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIdx(i => (i + 1) % mentionItems.length); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIdx(i => (i - 1 + mentionItems.length) % mentionItems.length); }
    if (e.key === 'Escape') { e.preventDefault(); setMentionActive(false); }
  }, [
    closeSkillMenu,
    filteredSkillItems,
    handleSend,
    handleSlashSkillPick,
    insertMention,
    mentionActive,
    mentionItems,
    mentionSelectedIdx,
    inputValue,
    selectedSkill,
    skillMenuOpen,
    skillSelectedIdx,
  ]);

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    const parsed = parseSlashInput(next);
    if (!selectedSkill && next.endsWith(' ') && parsed.name && !parsed.args) {
      const exactSkill = skillItems.find(skill => skill.name.toLowerCase() === parsed.name && skill.filePath);
      if (exactSkill) {
        setSelectedSkill(exactSkill);
        setInputValue('');
        closeSkillMenu();
        setMentionActive(false);
        requestAnimationFrame(() => inputRef.current?.focus());
        return;
      }
    }
    setInputValue(next);
    if (next.trim().startsWith('/')) {
      setSkillMenuOpen(true);
      setSkillSelectedIdx(0);
      setMentionActive(false);
    } else {
      setSkillMenuOpen(false);
    }
    requestAnimationFrame(() => checkMention());
  }, [checkMention, closeSkillMenu, selectedSkill, skillItems]);

  useEffect(() => {
    if (!skillMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (skillMenuRef.current?.contains(target) || skillBtnRef.current?.contains(target))) return;
      closeSkillMenu();
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [closeSkillMenu, skillMenuOpen]);

  useEffect(() => {
    const action = pendingChannelResourceAction;
    if (!action || action.target !== 'input' || action.channelId !== currentChannel) return;
    if (consumedResourceActionIdsRef.current.has(action.id)) return;
    consumedResourceActionIdsRef.current.add(action.id);
    consumePendingChannelResourceAction(action.id);
    addAttachedFile(action.file);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [addAttachedFile, consumePendingChannelResourceAction, currentChannel, pendingChannelResourceAction]);

  useEffect(() => {
    const onFocusRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ channelId?: string }>).detail || {};
      if (detail.channelId && detail.channelId !== currentChannel) return;
      inputRef.current?.focus();
    };
    window.addEventListener('gsap-channel-focus-input', onFocusRequest);
    return () => window.removeEventListener('gsap-channel-focus-input', onFocusRequest);
  }, [currentChannel]);

  if (isDM || !currentChannel) return null;

  return (
    <div
      className={`${styles.channelInputWrapper}${dragActive ? ` ${styles.channelInputWrapperDrag}` : ''}`}
      data-byoung-chat-color-scope=""
      onDrop={handleDropFiles}
      onDragOver={handleDragOverFiles}
      onDragLeave={handleDragLeaveFiles}
    >
      {attachedFiles.length > 0 && (
        <div className={styles.channelInputAttachments}>
          <AttachedFilesBar files={attachedFiles} onRemove={removeAttachedFile} />
        </div>
      )}
      {mentionActive && mentionItems.length > 0 && (
        <div className={styles.channelMentionDropdown}>
          {mentionItems.map((m, index) => (
            <div
              key={m.id}
              className={`${styles.channelMentionItem}${index === mentionSelectedIdx ? ` ${styles.channelMentionItemActive}` : ''}`}
              data-name={m.displayName}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(m.displayName);
              }}
            >
              <div className={styles.channelMentionAvatar}>
                <MemberAvatar info={m} />
              </div>
              <div className={styles.channelMentionText}>
                <span className={styles.channelMentionName}>{m.displayName}</span>
                <span className={styles.channelMentionMeta}>{m.yuan ? `${m.id} · ${m.yuan}` : m.id}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={styles.channelSkillMenuAnchor} ref={skillMenuRef}>
        {skillMenuOpen && filteredSkillItems.length > 0 && (
          <SlashCommandMenu
            commands={filteredSkillItems}
            selected={skillSelectedIdx}
            busy={null}
            onSelect={handleSlashSkillPick}
            onHover={(i) => setSkillSelectedIdx(i)}
          />
        )}
      </div>
      <input
        ref={fileInputRef}
        className={styles.channelFileInput}
        type="file"
        multiple
        onChange={handleFileInputChange}
      />
      <button
        type="button"
        className={styles.channelAttachBtn}
        data-testid="channel-attach-files"
        title={attachLabel}
        aria-label={attachLabel}
        onClick={handleAttach}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
      <button
        ref={skillBtnRef}
        type="button"
        className={`${styles.channelAttachBtn} ${styles.channelSkillBtn}`}
        data-testid="channel-skill-menu"
        title={skillMenuLabel}
        aria-label={skillMenuLabel}
        onClick={() => {
          setMentionActive(false);
          setSkillMenuOpen(open => !open);
          setSkillSelectedIdx(0);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2 14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
        </svg>
      </button>
      {selectedSkill && (
        <span
          className={skillBadgeStyles.badge}
          data-testid="channel-selected-skill"
          title={selectedSkill.filePath || selectedSkill.name}
        >
          <svg className={skillBadgeStyles.icon} width="13" height="13" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
            <path d="M8 1 L9.5 6 L15 8 L9.5 10 L8 15 L6.5 10 L1 8 L6.5 6 Z" />
          </svg>
          <span className={skillBadgeStyles.name}>{selectedSkill.name}</span>
          <button
            type="button"
            className={skillBadgeStyles.remove}
            aria-label={`移除技能 ${selectedSkill.name}`}
            onClick={() => {
              setSelectedSkill(null);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            ×
          </button>
        </span>
      )}
      <textarea
        ref={inputRef}
        className={styles.channelInputBox}
        placeholder={window.t?.('channel.inputPlaceholder') || 'Send a message...'}
        rows={1}
        spellCheck={false}
        value={inputValue}
        onChange={handleInput}
        onPaste={handlePasteFiles}
        onKeyDown={handleKeyDown}
      />
      <button type="button"
        className={styles.channelSendBtn}
        disabled={(!inputValue.trim() && attachedFiles.length === 0 && !selectedSkill) || sending}
        onClick={handleSend}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" />
        </svg>
      </button>
    </div>
  );
}

// ── ChannelReadonly

export function ChannelReadonly() {
  const isDM = useStore(s => s.channelIsDM);
  const currentChannel = useStore(s => s.currentChannel);

  if (!isDM || !currentChannel) return null;

  return (
    <span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'middle', marginRight: 4 }}>
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
      {window.t?.('channel.readOnly') || '\u8fd9\u662f Agent \u4e4b\u95f4\u7684\u79c1\u4fe1\uff0c\u4ec5\u53ef\u67e5\u770b'}
    </span>
  );
}
