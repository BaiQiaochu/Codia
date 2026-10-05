import { memo, useCallback, useId, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { AssistantMessage } from './AssistantMessage';
import { MessageFooterActions, formatMessageTime } from './MessageFooterActions';
import { buildProcessFoldSummary, type ProcessFoldRenderItem } from './process-fold';
import styles from './Chat.module.css';

interface Props {
  group: ProcessFoldRenderItem;
  showAvatar: boolean;
  sessionPath: string;
  agentId?: string | null;
  readOnly: boolean;
  turnCompletionAssistantIndexes?: ReadonlySet<number>;
  assistantTurnSelectionIdsByCompletionIndex?: ReadonlyMap<number, readonly string[]>;
  completionTimePersistent?: boolean;
  registerMessageElement?: (messageId: string, element: HTMLDivElement | null) => void;
}

export const ProcessFoldBlock = memo(function ProcessFoldBlock({
  group,
  showAvatar,
  sessionPath,
  agentId,
  readOnly,
  turnCompletionAssistantIndexes,
  assistantTurnSelectionIdsByCompletionIndex,
  completionTimePersistent = false,
  registerMessageElement,
}: Props) {
  const agents = useStore(s => s.agents);
  const globalAgentName = useStore(s => s.agentName) || '助手';
  const globalYuan = useStore(s => s.agentYuan) || 'gsap';
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const t = window.t ?? ((p: string) => p);

  const displayInfo = resolveAgentDisplayInfo({
    id: agentId || null,
    agents,
    fallbackAgentName: globalAgentName,
    fallbackAgentYuan: globalYuan,
  });
  const displayName = displayInfo.displayName;
  const summary = useMemo(
    () => buildProcessFoldSummary(
      group.stats,
      displayName,
      (key, vars) => String(t(key, vars as Record<string, string | number> | undefined)),
    ),
    [displayName, group.stats, t],
  );

  const toggle = useCallback(() => setOpen(value => !value), []);
  const messageRef = useCallback((messageId: string) => (
    (element: HTMLDivElement | null) => registerMessageElement?.(messageId, element)
  ), [registerMessageElement]);
  const turnCompletionEntry = turnCompletionAssistantIndexes
    ? group.items.find((entry) => turnCompletionAssistantIndexes.has(entry.originalIndex))
    : null;
  const completionTimeText = formatMessageTime(turnCompletionEntry?.item.data.timestamp);

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}`}>
      {showAvatar && (
        <div className={styles.avatarRow}>
          <AgentAvatar
            info={displayInfo}
            className={`${styles.avatar} ${styles.gsapAvatar}`}
            alt={displayName}
          />
          <span className={styles.avatarName}>{displayName}</span>
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant} ${styles.processFoldMessage}`}>
        <button
          type="button"
          className={`${styles.processFoldSummary}${open ? ` ${styles.processFoldSummaryOpen}` : ''}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          <span className={styles.processFoldTitle}>
            <span className={styles.processFoldTitleText}>{summary}</span>
            <span className={styles.processFoldArrow} aria-hidden="true">&gt;</span>
          </span>
        </button>
      </div>
      {open && (
        <div id={panelId} className={`${styles.message} ${styles.messageAssistant} ${styles.processFoldPanel}`}>
          {group.items.map((entry) => (
            <AssistantMessage
              key={entry.item.data.id}
              message={entry.item.data}
              showAvatar={false}
              sessionPath={sessionPath}
              agentId={agentId}
              readOnly={readOnly}
              showTurnCompletionTime={turnCompletionAssistantIndexes?.has(entry.originalIndex) ?? false}
              assistantTurnSelectionIds={assistantTurnSelectionIdsByCompletionIndex?.get(entry.originalIndex)}
              messageRef={messageRef(entry.item.data.id)}
            />
          ))}
        </div>
      )}
      {!open && completionTimeText && (
        <MessageFooterActions
          align="left"
          timeText={completionTimeText}
          timePersistent={completionTimePersistent}
          actions={[]}
        />
      )}
    </div>
  );
});
