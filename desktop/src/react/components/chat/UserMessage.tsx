import { QUICK_ACTIONS } from '../../../../../shared/quick-actions';
import { AgentReviewCard } from './AgentReviewCard';
/**
 * UserMessage — 用户消息气泡
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { AttachmentChip } from '../shared/AttachmentChip';
import { MessageFooterActions, formatMessageTime, type MessageFooterAction } from './MessageFooterActions';
import { useMessageFooterActions } from './MessageActions';
const lazyScreenshot = () => import('../../utils/screenshot').then(m => m.takeScreenshot);
import type { ChatMessage, UserAttachment, DeskContext } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { sessionScopedValue } from '../../stores/session-slice';
import { selectIsStreamingSession, selectSelectedIdsBySession } from '../../stores/session-selectors';
import { serializeChatMessageForCopy } from '../../utils/chat-copy';
import { writeClipboardText } from '../../utils/clipboard';
import { openFilePreview } from '../../utils/file-preview';
import { extOfName, isImageOrSvgExt } from '../../utils/file-kind';
import { getUserAttachmentImageSrc } from '../../utils/user-attachment-media';
import { replayLatestUserMessage } from '../../stores/message-turn-actions';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { Plug } from '@phosphor-icons/react';
import styles from './Chat.module.css';
import badgeStyles from '../input/SkillBadgeView.module.css';

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  sessionPath: string;
  readOnly?: boolean;
  hideIdentity?: boolean;
  userIdentity?: { name?: string | null; avatarUrl?: string | null };
  isLatestUserMessage?: boolean;
  messageRef?: (element: HTMLDivElement | null) => void;
}

export const UserMessage = memo(function UserMessage({
  message,
  showAvatar,
  sessionPath,
  readOnly = false,
  hideIdentity = false,
  userIdentity,
  isLatestUserMessage = false,
  messageRef,
}: Props) {
  const userAvatarUrl = useStore(s => s.userAvatarUrl);
  const t = window.t ?? ((p: string) => p);
  const storeUserName = useStore(s => s.userName) || t('common.me');
  const userName = userIdentity?.name || storeUserName;
  const displayAvatarUrl = userIdentity ? (userIdentity.avatarUrl || null) : userAvatarUrl;
  const userDisplayInfo = useMemo(() => resolveAgentDisplayInfo({
    id: 'user',
    agents: [],
    userName,
    userAvatarUrl: displayAvatarUrl,
  }), [displayAvatarUrl, userName]);

  const isStreaming = useStore(s => selectIsStreamingSession(s, sessionPath));
  const selectedIds = useStore(s => selectSelectedIdsBySession(s, sessionPath));
  const isSelected = selectedIds.includes(message.id);

  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(message.text || '');
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setEditValue(message.text || '');
  }, [editing, message.text]);

  useEffect(() => {
    if (!editing) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const handleCopy = useCallback(() => {
    const state = useStore.getState();
    const ids = selectSelectedIdsBySession(state, sessionPath);

    if (ids.length > 0) {
      const session = sessionScopedValue(state, state.chatSessions, sessionPath);
      if (!session) return;
      const texts: string[] = [];
      for (const item of session.items) {
        if (item.type !== 'message') continue;
        if (!ids.includes(item.data.id)) continue;
        const text = serializeChatMessageForCopy(item.data);
        if (text) texts.push(text);
      }
      writeClipboardText(texts.join('\n\n')).then((ok) => {
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    } else {
      const text = serializeChatMessageForCopy(message);
      if (!text) return;
      writeClipboardText(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  }, [message, sessionPath]);

  const handleScreenshot = useCallback(async () => {
    const fn = await lazyScreenshot();
    fn(message.id, sessionPath);
  }, [message.id, sessionPath]);

  const handleRegenerate = useCallback(async () => {
    if (busy || isStreaming) return;
    setBusy(true);
    try {
      await replayLatestUserMessage(sessionPath, message);
    } finally {
      setBusy(false);
    }
  }, [busy, isStreaming, message, sessionPath]);

  const handleEdit = useCallback(() => {
    if (busy || isStreaming) return;
    setEditValue(message.text || '');
    setEditing(true);
  }, [busy, isStreaming, message.text]);

  const handleCancelEdit = useCallback(() => {
    if (busy) return;
    setEditing(false);
    setEditValue(message.text || '');
  }, [busy, message.text]);

  const handleConfirmEdit = useCallback(async () => {
    const nextText = editValue.trim();
    if (!nextText || busy || isStreaming) return;
    setBusy(true);
    try {
      const ok = await replayLatestUserMessage(sessionPath, message, nextText);
      if (ok) setEditing(false);
    } finally {
      setBusy(false);
    }
  }, [busy, editValue, isStreaming, message, sessionPath]);

  const canShowLatestActions = !readOnly && isLatestUserMessage && !message.agentReview && !message.reviewSourceSessionId;
  const timeText = formatMessageTime(message.timestamp);
  const editingActions: MessageFooterAction[] = useMemo(() => [
    {
      id: 'cancel',
      title: t('common.cancel'),
      icon: <XIcon />,
      onClick: () => handleCancelEdit(),
      disabled: busy,
    },
    {
      id: 'confirm',
      title: t('common.confirm'),
      icon: <CheckIcon />,
      onClick: () => { void handleConfirmEdit(); },
      disabled: busy || !editValue.trim(),
    },
  ], [busy, editValue, handleCancelEdit, handleConfirmEdit, t]);
  const standardMessageActions = useMessageFooterActions({
    messageId: message.id,
    sessionPath,
    onCopy: handleCopy,
    onScreenshot: () => { void handleScreenshot(); },
    copied,
    isStreaming: isStreaming || busy,
  });
  const messageActions = readOnly || editing ? [] : standardMessageActions;
  const latestActions: MessageFooterAction[] = useMemo(() => canShowLatestActions ? [
    {
      id: 'regenerate',
      title: t('common.regenerate'),
      icon: <RegenerateIcon />,
      onClick: () => { void handleRegenerate(); },
      disabled: isStreaming || busy,
    },
    {
      id: 'edit',
      title: t('common.edit'),
      icon: <EditIcon />,
      onClick: () => handleEdit(),
      disabled: isStreaming || busy,
    },
  ] : [], [busy, canShowLatestActions, handleEdit, handleRegenerate, isStreaming, t]);
  const footerActions = editing ? editingActions : latestActions;
  const hasSkillBadges = !!message.skills?.length;
  const hasPluginBadges = !!message.plugins?.length;
  const hasWorkspaceToolBadge = !!message.workspaceTool?.title;
  const hasReferenceBadges = hasSkillBadges || hasPluginBadges || hasWorkspaceToolBadge || !!message.quickAction || !!message.agentMentions?.length || !!message.sessionRefs?.length;
  const hasTextBubble = editing || !!message.textHtml || hasReferenceBadges || !!message.agentReview || !!message.reviewSourceSessionId;

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupUser}${isSelected ? ` ${styles.messageGroupSelected}` : ''}`}
         ref={messageRef}
         data-message-id={message.id}>
      {showAvatar && !hideIdentity && (
        <div className={`${styles.avatarRow} ${styles.avatarRowUser}`}>
          <span className={styles.avatarName}>{userName}</span>
          <AgentAvatar
            info={userDisplayInfo}
            className={`${styles.avatar} ${styles.userAvatar}`}
            alt={userName}
          />
        </div>
      )}
      {message.quotedText && (
        <div className={styles.userAttachments}>
          <AttachmentChip
            icon={<GridIcon />}
            name={message.quotedText}
          />
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <UserAttachmentsView
          attachments={message.attachments}
          deskContext={message.deskContext}
          sessionPath={sessionPath}
          messageId={message.id}
        />
      )}
      {hasTextBubble && (
        <div className={`${styles.message} ${styles.messageUser}${editing ? ` ${styles.messageUserEditing}` : ''}`}>
          {hasReferenceBadges && (
            <div className={styles.userMessageReferences} aria-label={t('chat.messageReferences')}>
              {message.workspaceTool?.title && (
                <span
                  className={badgeStyles.badge}
                  style={{ cursor: 'default' }}
                  title={message.workspaceTool.description || message.workspaceTool.title}
                >
                  <svg className={badgeStyles.icon} width="13" height="13" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 3h10v10H3z" />
                    <path d="M6 6h4" />
                    <path d="M6 10h3" />
                  </svg>
                  <span className={badgeStyles.name}>工具 {message.workspaceTool.title}</span>
                </span>
              )}
              {message.quickAction && <span className={badgeStyles.badge}>✧ {QUICK_ACTIONS[message.quickAction]?.title}</span>}
              {message.agentMentions?.map(ref => <span key={ref.agentId} className={badgeStyles.badge}>@{ref.label}</span>)}
              {message.sessionRefs?.map(ref => <span key={ref.sessionId} className={badgeStyles.badge}>@{ref.label}</span>)}
              {message.skills?.map(skillName => (
                <span key={skillName} className={badgeStyles.badge} style={{ cursor: 'default' }} title={skillName}>
                  <svg className={badgeStyles.icon} width="13" height="13" viewBox="0 0 16 16" fill="none"
                    stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
                    <path d="M8 1 L9.5 6 L15 8 L9.5 10 L8 15 L6.5 10 L1 8 L6.5 6 Z" />
                  </svg>
                  <span className={badgeStyles.name}>{skillName}</span>
                </span>
              ))}
              {message.plugins?.map(plugin => (
                <span key={plugin.id} className={badgeStyles.badge} style={{ cursor: 'default' }} title={plugin.name || plugin.id}>
                  <Plug className={badgeStyles.icon} size={13} weight="bold" aria-hidden="true" />
                  <span className={badgeStyles.name}>{plugin.name || plugin.id}</span>
                </span>
              ))}
            </div>
          )}
          {message.agentReview && <AgentReviewCard review={message.agentReview} />}
          {message.reviewSourceSessionId && <AgentReviewCard sourceSessionId={message.reviewSourceSessionId} />}
          {editing ? (
            <textarea
              ref={textareaRef}
              className={styles.userEditTextarea}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void handleConfirmEdit();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelEdit();
                }
              }}
              disabled={busy}
            />
          ) : (
            message.textHtml && <MarkdownContent className={styles.userText} html={message.textHtml} linkContext={{ origin: 'session', sessionPath, messageId: message.id }} />
          )}
        </div>
      )}
      {(timeText || messageActions.length > 0 || footerActions.length > 0) && (
        <MessageFooterActions
          align="right"
          timeText={timeText}
          leadingActions={footerActions}
          visible={editing}
          actions={messageActions}
          testId="user-message-footer-actions"
        />
      )}
    </div>
  );
});

// ── 附件区 ──

const UserAttachmentsView = memo(function UserAttachmentsView({ attachments, deskContext, sessionPath, messageId }: {
  attachments: UserAttachment[];
  deskContext?: DeskContext | null;
  sessionPath: string;
  messageId: string;
}) {
  const isImage = useCallback((att: UserAttachment) => {
    return isImageOrSvgExt(extOfName(att.name));
  }, []);

  const t = window.t ?? ((p: string) => p);

  return (
    <div className={styles.userAttachments}>
      {attachments.map((att, i) => {
        const expired = att.status === 'expired';
        const expiredLabel = t('chat.fileExpired') === 'chat.fileExpired' ? '已过期' : t('chat.fileExpired');
        const imageSrc = !expired && isImage(att) ? getUserAttachmentImageSrc(att) : null;
        if (imageSrc) {
          return (
            <div key={att.name || `att-${i}`} className={styles.attachImageWrap}>
              <img
                className={styles.attachImage}
                src={imageSrc}
                alt={att.name}
                loading="lazy"
                onClick={(event) => {
                  event.stopPropagation();
                  openFilePreview(att.path, att.name, extOfName(att.name) || '', {
                    origin: 'session',
                    sessionPath,
                    messageId,
                  });
                }}
                style={{ cursor: 'pointer' }}
              />
              {att.visionAuxiliary && (
                <div className={styles.visionAuxiliaryLabel}>
                  {t('chat.visionAuxiliary')}
                </div>
              )}
            </div>
          );
        }
        return (
          <AttachmentChip
            key={att.name || `att-${i}`}
            icon={att.isDir ? <FolderIcon /> : <FileIcon />}
            name={expired ? `${att.name} · ${expiredLabel}` : att.name}
            variant={expired ? 'expired' : 'normal'}
          />
        );
      })}
      {deskContext && (
        <AttachmentChip
          icon={<FolderIcon />}
          name={`${t('sidebar.jian')} (${deskContext.fileCount})`}
        />
      )}
    </div>
  );
});

// ── Icons ──

function GridIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="18" y1="4" x2="18" y2="20" />
      <line x1="6" y1="8" x2="18" y2="8" />
      <line x1="6" y1="16" x2="18" y2="16" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function RegenerateIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
