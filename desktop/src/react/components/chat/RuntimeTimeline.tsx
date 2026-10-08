import { memo, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import {
  selectRuntimeTimelineTrace,
  type RuntimeTimelineEvent,
  type RuntimeTimelineEventType,
} from '../../stores/runtime-timeline-slice';
import styles from './Chat.module.css';

interface Props {
  turnTraceId?: string | null;
}

const LABEL_KEYS: Record<RuntimeTimelineEventType, string> = {
  queued: 'chat.runtimeTimeline.queued',
  model_route: 'chat.runtimeTimeline.modelRoute',
  thinking: 'chat.runtimeTimeline.thinking',
  generating: 'chat.runtimeTimeline.generating',
  tool_call: 'chat.runtimeTimeline.toolCall',
  media_generation: 'chat.runtimeTimeline.mediaGeneration',
  completed: 'chat.runtimeTimeline.completed',
  failed: 'chat.runtimeTimeline.failed',
};

const STATUS_LABEL_KEYS = {
  completed: 'chat.runtimeTimeline.summary.completed',
  failed: 'chat.runtimeTimeline.summary.failed',
  running: 'chat.runtimeTimeline.summary.running',
  queued: 'chat.runtimeTimeline.summary.queued',
} as const;

function copy(key: string, fallback: string): string {
  const value = window.t?.(key);
  return value && value !== key ? value : fallback;
}

function toolLabel(event: RuntimeTimelineEvent): string | null {
  const name = event.tool?.name || event.label;
  if (name === 'todo_write') return copy('chat.runtimeTimeline.tools.todoWrite', '更新任务清单');
  return name || null;
}

function eventLabel(event: RuntimeTimelineEvent): string {
  if (event.type === 'tool_call') {
    return toolLabel(event) || copy(LABEL_KEYS[event.type], '调用工具');
  }
  const fallback = event.label || event.type.replace(/_/g, ' ');
  return copy(LABEL_KEYS[event.type], fallback);
}

function summaryLabel(status: keyof typeof STATUS_LABEL_KEYS): string {
  const fallbacks = {
    completed: '已完成',
    failed: '失败',
    running: '执行中',
    queued: '排队中',
  };
  return copy(STATUS_LABEL_KEYS[status], fallbacks[status]);
}

function formatDuration(event: RuntimeTimelineEvent): string | null {
  if (typeof event.durationMs === 'number') return `${event.durationMs}ms`;
  if (!event.endedAt) return null;
  const duration = Date.parse(event.endedAt) - Date.parse(event.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? `${duration}ms` : null;
}

export const RuntimeTimeline = memo(function RuntimeTimeline({ turnTraceId }: Props) {
  const trace = useStore(s => selectRuntimeTimelineTrace(s, turnTraceId));
  const autoExpand = trace?.status === 'failed';
  const [expanded, setExpanded] = useState(Boolean(autoExpand));

  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);

  const visibleEvents = useMemo(() => trace?.events ?? [], [trace?.events]);
  if (!trace || visibleEvents.length === 0) return null;

  const summary = summaryLabel(trace.status);
  const toggleLabel = expanded
    ? copy('chat.runtimeTimeline.toggleCollapse', '收起执行时间线')
    : copy('chat.runtimeTimeline.toggleExpand', '展开执行时间线');

  return (
    <div className={styles.runtimeTimeline} data-testid="runtime-timeline" data-status={trace.status}>
      <button
        type="button"
        className={styles.runtimeTimelineToggle}
        aria-expanded={expanded}
        aria-label={toggleLabel}
        onClick={() => setExpanded(value => !value)}
      >
        <span className={styles.runtimeTimelineDot} data-status={trace.status} aria-hidden="true" />
        <span className={styles.runtimeTimelineSummary}>{summary}</span>
        <span className={styles.runtimeTimelineChevron} aria-hidden="true">{expanded ? '-' : '+'}</span>
      </button>
      {expanded && (
        <ol className={styles.runtimeTimelineList}>
          {visibleEvents.map(event => (
            <li key={event.id} className={styles.runtimeTimelineItem} data-status={event.status}>
              <span className={styles.runtimeTimelineItemDot} aria-hidden="true" />
              <span className={styles.runtimeTimelineItemLabel}>{eventLabel(event)}</span>
              {formatDuration(event) && (
                <span className={styles.runtimeTimelineItemMeta}>{formatDuration(event)}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});
