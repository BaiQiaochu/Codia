/**
 * WorkflowInlineCard - 聊天流里的 workflow 概览块（信息架构：inline 只给「大概状态」）
 *
 * 聊天流里只显示 workflow 名、终态耗时和状态，不订阅 streamKey、不展开实时流。
 * 详细节点分布在右侧 WorkflowCard。
 */
import { memo } from 'react';
import { useStore } from '../../stores';
import { selectAgentActivities } from '../../stores/agent-activity-slice';
import { formatElapsed } from '../../utils/format-duration';
import { ChatResourceCard } from './ChatResourceCard';
import type { ChatResourceCardStatusTone } from './ChatResourceCard';
import { WorkflowResourceIcon } from './ChatResourceIcons';
import { WorkflowProgressDots } from '../shared/WorkflowProgressDots';

interface WorkflowInlineCardProps {
  block: {
    taskId: string;
    taskTitle: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted' | string;
    summary?: string | null;
    startedAt?: number | null;
    finishedAt?: number | null;
  };
}

const STATUS_LABEL: Record<string, string> = {
  running: '◐ 运行中',
  done: '✓ 已完成',
  failed: '✗ 失败',
  aborted: '⊘ 已终止',
};

const STATUS_TONE: Record<string, ChatResourceCardStatusTone> = {
  running: 'accent',
  done: 'success',
  failed: 'danger',
  aborted: 'muted',
};

function statusTone(status: WorkflowInlineCardProps['block']['streamStatus']) {
  return STATUS_TONE[status] ?? 'neutral';
}

function statusLabel(status: WorkflowInlineCardProps['block']['streamStatus']) {
  return STATUS_LABEL[status] ?? status;
}

export const WorkflowInlineCard = memo(function WorkflowInlineCard({ block }: WorkflowInlineCardProps) {
  const t: (k: string, v?: Record<string, string | number>) => string = window.t ?? ((k: string) => k);
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));
  const agents = useStore((s) => s.agents);

  const childNodes = all.filter(
    (activity) =>
      (activity.kind === 'workflow_agent' || activity.kind === 'workflow_step') &&
      activity.parentTaskId === block.taskId,
  );
  const agentCount = childNodes.filter((activity) => activity.kind === 'workflow_agent').length;

  let duration = '';
  if (block.finishedAt && block.startedAt) {
    duration = formatElapsed(block.finishedAt - block.startedAt);
  }

  const metaParts: string[] = [];
  if (agentCount > 0) metaParts.push(t('rightWorkspace.workflow.agents', { n: agentCount }));
  if (duration) metaParts.push(duration);
  const titleMeta = metaParts.join(' · ') || undefined;

  return (
    <ChatResourceCard
      icon={<WorkflowResourceIcon />}
      title={block.taskTitle || t('rightWorkspace.workflow.title')}
      titleMeta={titleMeta}
      subtitle={childNodes.length > 0
        ? <WorkflowProgressDots nodes={childNodes} agents={agents} size="sm" />
        : (block.summary || undefined)
      }
      statusLabel={statusLabel(block.streamStatus)}
      statusTone={statusTone(block.streamStatus)}
    />
  );
});
