import { memo, useCallback, useId, useMemo, useState } from 'react';
import {
  Brain,
  CaretDown,
  CheckCircle,
  CircleNotch,
  FileText,
  Plug,
  TerminalWindow,
  Wrench,
  XCircle,
} from '@phosphor-icons/react';
import { useStore } from '../../stores';
import type { ContentBlock, ToolCall } from '../../stores/chat-types';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { extractToolDetail } from '../../utils/message-parser';
import { openInternalLink } from '../../utils/link-open';
import { MessageFooterActions, formatMessageTime } from './MessageFooterActions';
import type { ProcessFoldRenderItem } from './process-fold';
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

type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface ProcessActivity {
  id: string;
  kind: 'thinking' | 'narration' | 'tool' | 'plugin';
  label: string;
  detail?: string;
  href?: string;
  status: 'running' | 'success' | 'failed' | 'info';
}

const PREVIEW_ACTIVITY_COUNT = 4;

function htmlToPlainText(html?: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactText(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pluginName(tool: ToolCall): string | null {
  const detailPluginId = tool.details?.pluginId;
  if (typeof detailPluginId === 'string' && detailPluginId.trim()) return detailPluginId.trim();
  const cardPluginId = tool.details?.card?.pluginId;
  if (typeof cardPluginId === 'string' && cardPluginId.trim()) return cardPluginId.trim();
  const argumentPluginId = tool.args?.pluginId ?? tool.args?.plugin_id;
  if (typeof argumentPluginId === 'string' && argumentPluginId.trim()) return argumentPluginId.trim();
  if (tool.name.startsWith('mcp__')) {
    const [, server] = tool.name.split('__');
    return server || 'MCP';
  }
  return null;
}

function toolActionKey(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes('write') || normalized.includes('edit') || normalized.includes('patch')) return 'edit';
  if (normalized.includes('read')) return 'read';
  if (normalized.includes('grep') || normalized.includes('find') || normalized.includes('search') || normalized.includes('glob')) return 'search';
  if (normalized.includes('exec') || normalized.includes('bash') || normalized.includes('terminal') || normalized.includes('command')) return 'command';
  if (normalized.includes('image')) return 'image';
  if (normalized.includes('video')) return 'video';
  if (normalized.includes('browser')) return 'browser';
  if (normalized.includes('subagent') || normalized.includes('agent')) return 'agent';
  if (normalized.includes('automation') || normalized.includes('cron') || normalized.includes('workflow')) return 'automation';
  return 'tool';
}

function activityFromTool(tool: ToolCall, id: string, translate: Translate): ProcessActivity {
  const plugin = pluginName(tool);
  const detail = extractToolDetail(tool.name, tool.args);
  const actionKey = plugin ? 'plugin' : toolActionKey(tool.name);
  const label = translate(`processFold.step.${actionKey}`, { name: plugin || tool.name });
  const pluginToolName = plugin && tool.name.startsWith(`${plugin}_`)
    ? tool.name.slice(plugin.length + 1).replace(/[_-]+/g, ' ')
    : '';
  const detailText = [pluginToolName, detail.text].filter(Boolean).join(' · ');

  return {
    id,
    kind: plugin ? 'plugin' : 'tool',
    label,
    detail: detailText || undefined,
    href: detail.href,
    status: tool.done ? (tool.success ? 'success' : 'failed') : 'running',
  };
}

function activeToolLabel(name: string, translate: Translate): string {
  const plugin = name.startsWith('mcp__') ? (name.split('__')[1] || 'MCP') : null;
  const actionKey = plugin ? 'plugin' : toolActionKey(name);
  return translate(`processFold.step.${actionKey}`, { name: plugin || name });
}

function activitiesFromBlock(
  block: ContentBlock,
  messageId: string,
  blockIndex: number,
  translate: Translate,
): ProcessActivity[] {
  const baseId = `${messageId}-${blockIndex}`;
  if (block.type === 'thinking') {
    return [{
      id: baseId,
      kind: 'thinking',
      label: translate(block.sealed ? 'thinking.done' : 'thinking.active'),
      detail: compactText(block.content) || undefined,
      status: block.sealed ? 'success' : 'running',
    }];
  }
  if (block.type === 'tool_group') {
    return (Array.isArray(block.tools) ? block.tools : []).map((tool, toolIndex) => (
      activityFromTool(tool, `${baseId}-${tool.id || toolIndex}`, translate)
    ));
  }
  if (block.type === 'invoke') {
    return [{
      id: baseId,
      kind: 'tool',
      label: translate('processFold.step.command', { name: block.name }),
      detail: compactText(block.content) || undefined,
      status: 'info',
    }];
  }
  if (block.type === 'mood') {
    return [{
      id: baseId,
      kind: 'thinking',
      label: translate('processFold.step.reasoning'),
      detail: compactText(block.text) || undefined,
      status: 'info',
    }];
  }
  if (block.type === 'text') {
    const text = compactText(block.source || htmlToPlainText(block.html));
    return text ? [{
      id: baseId,
      kind: 'narration',
      label: text,
      status: 'info',
    }] : [];
  }
  return [];
}

function collectActivities(group: ProcessFoldRenderItem, translate: Translate): ProcessActivity[] {
  return group.items.flatMap((entry) => (
    (Array.isArray(entry.item.data.blocks) ? entry.item.data.blocks : []).flatMap((block, blockIndex) => (
      activitiesFromBlock(block, entry.item.data.id, blockIndex, translate)
    ))
  ));
}

function activityIcon(activity: ProcessActivity) {
  if (activity.status === 'running') return <CircleNotch size={15} weight="bold" className={styles.processFoldSpinner} />;
  if (activity.status === 'failed') return <XCircle size={15} weight="fill" />;
  if (activity.kind === 'plugin') return <Plug size={15} weight="regular" />;
  if (activity.kind === 'thinking') return <Brain size={15} weight="regular" />;
  if (activity.kind === 'narration') return <FileText size={15} weight="regular" />;
  if (activity.label.toLowerCase().includes('command')) return <TerminalWindow size={15} weight="regular" />;
  return activity.status === 'success'
    ? <CheckCircle size={15} weight="regular" />
    : <Wrench size={15} weight="regular" />;
}

function activityMeta(group: ProcessFoldRenderItem, translate: Translate): string {
  const parts: string[] = [];
  if (group.stats.toolCount > 0) parts.push(translate('processFold.tools', { n: group.stats.toolCount }));
  if (group.stats.thinkingCount > 0) parts.push(translate('processFold.thinking', { n: group.stats.thinkingCount }));
  if ((group.stats.fileCount || 0) > 0) parts.push(translate('processFold.files', { n: group.stats.fileCount || 0 }));
  if (group.stats.unsuccessfulCount > 0) parts.push(translate('processFold.unsuccessful', { n: group.stats.unsuccessfulCount }));
  return parts.join(' · ');
}

export const ProcessFoldBlock = memo(function ProcessFoldBlock({
  group,
  showAvatar,
  agentId,
  turnCompletionAssistantIndexes,
  completionTimePersistent = false,
  registerMessageElement,
}: Props) {
  const agents = useStore(s => s.agents);
  const globalAgentName = useStore(s => s.agentName) || '助手';
  const globalYuan = useStore(s => s.agentYuan) || 'codia';
  const [open, setOpen] = useState(group.active);
  const panelId = useId();
  const runtimeTranslate = window.t ?? ((key: string) => key);
  const translate = useCallback<Translate>((key, vars) => (
    String(runtimeTranslate(key, vars as Record<string, string | number> | undefined))
  ), [runtimeTranslate]);

  const displayInfo = resolveAgentDisplayInfo({
    id: agentId || null,
    agents,
    fallbackAgentName: globalAgentName,
    fallbackAgentYuan: globalYuan,
  });
  const displayName = displayInfo.displayName;
  const activities = useMemo(() => collectActivities(group, translate), [group, translate]);
  const visibleActivities = open
    ? activities
    : activities.slice(Math.max(0, activities.length - PREVIEW_ACTIVITY_COUNT));
  const hiddenActivityCount = Math.max(0, activities.length - visibleActivities.length);
  const meta = activityMeta(group, translate);
  const toggle = useCallback(() => setOpen(value => !value), []);
  const messageIds = useMemo(() => group.items.map(entry => entry.item.data.id), [group.items]);
  const groupRef = useCallback((element: HTMLDivElement | null) => {
    for (const messageId of messageIds) registerMessageElement?.(messageId, element);
  }, [messageIds, registerMessageElement]);
  const turnCompletionEntry = turnCompletionAssistantIndexes
    ? group.items.find((entry) => turnCompletionAssistantIndexes.has(entry.originalIndex))
    : null;
  const completionTimeText = formatMessageTime(turnCompletionEntry?.item.data.timestamp);

  return (
    <div ref={groupRef} className={`${styles.messageGroup} ${styles.messageGroupAssistant}`}>
      {showAvatar && (
        <div className={styles.avatarRow}>
          <AgentAvatar
            info={displayInfo}
            className={`${styles.avatar} ${styles.codiaAvatar}`}
            alt={displayName}
          />
          <span className={styles.avatarName}>{displayName}</span>
        </div>
      )}
      <section
        className={`${styles.processFoldTrace}${open ? ` ${styles.processFoldTraceOpen}` : ''}`}
        aria-label={translate('processFold.summary')}
      >
        <button
          type="button"
          className={`${styles.processFoldSummary}${open ? ` ${styles.processFoldSummaryOpen}` : ''}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={toggle}
        >
          <span className={styles.processFoldTitle}>
            <span className={styles.processFoldTitleText}>
              {group.active && group.stats.currentTool
                ? translate('processFold.running', { name: activeToolLabel(group.stats.currentTool, translate) })
                : translate('processFold.summary')}
            </span>
            {meta && <span className={styles.processFoldMeta}>{meta}</span>}
          </span>
          <CaretDown className={styles.processFoldArrow} size={14} weight="bold" aria-hidden="true" />
        </button>

        <div id={panelId} className={styles.processFoldActivityList}>
          {visibleActivities.map((activity) => (
            <div
              key={activity.id}
              className={`${styles.processFoldActivity} ${
                activity.status === 'failed' ? styles.processFoldActivityFailed : ''
              }`}
            >
              <span className={styles.processFoldActivityIcon} aria-hidden="true">{activityIcon(activity)}</span>
              <div className={styles.processFoldActivityContent}>
                <span className={styles.processFoldActivityLabel}>{activity.label}</span>
                {activity.detail && (
                  activity.href ? (
                    <button
                      type="button"
                      className={styles.processFoldActivityDetailLink}
                      title={activity.detail}
                      onClick={() => { void openInternalLink(activity.href!, { origin: 'session' }); }}
                    >
                      {activity.detail}
                    </button>
                  ) : (
                    <span className={styles.processFoldActivityDetail} title={activity.detail}>{activity.detail}</span>
                  )
                )}
              </div>
            </div>
          ))}
          {hiddenActivityCount > 0 && (
            <button type="button" className={styles.processFoldMore} onClick={toggle}>
              {translate('processFold.showAll', { n: activities.length })}
            </button>
          )}
        </div>
      </section>
      {completionTimeText && (
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
