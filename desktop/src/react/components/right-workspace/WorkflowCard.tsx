import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectAgentActivities, type AgentActivityEntry } from '../../stores/agent-activity-slice';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { SubagentSessionPreview } from '../chat/SubagentSessionPreview';
import { formatElapsed } from '../../utils/format-duration';
import { LogStepIcon, ParallelStepIcon, PipelineStepIcon } from '../shared/WorkflowStepIcons';
import type { Agent } from '../../types';
import styles from './WorkflowCard.module.css';

const STATUS_ICON: Record<AgentActivityEntry['status'], string> = {
  running: '⟳',
  done: '✓',
  failed: '!',
  aborted: '-',
};

const STEP_LABEL: Record<string, string> = {
  parallel: '并行',
  pipeline: '流水线',
  log: '日志',
};

function rank(status: AgentActivityEntry['status']): number {
  return status === 'running' ? 0 : 1;
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function durationLabel(entry: AgentActivityEntry, now: number, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (entry.status === 'running' && entry.startedAt) {
    return t('rightWorkspace.workflow.running', { text: formatElapsed(now - entry.startedAt) });
  }
  if (entry.finishedAt && entry.startedAt) {
    return t('activity.duration', { text: formatElapsed(entry.finishedAt - entry.startedAt) });
  }
  return '';
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function StepShape({ stepKind, size = 16 }: { stepKind: string | null | undefined; size?: number }) {
  switch (stepKind) {
    case 'parallel':
      return <ParallelStepIcon size={size} />;
    case 'pipeline':
      return <PipelineStepIcon size={size} />;
    case 'log':
      return <LogStepIcon size={size} />;
    default:
      return <PipelineStepIcon size={size} />;
  }
}

function groupByPhase(nodes: AgentActivityEntry[]): { phaseLabel: string | null; nodes: AgentActivityEntry[] }[] {
  const map = new Map<string | null, AgentActivityEntry[]>();
  for (const node of nodes) {
    const key = node.phaseLabel || null;
    const list = map.get(key) || [];
    list.push(node);
    map.set(key, list);
  }

  const groups: { phaseLabel: string | null; nodes: AgentActivityEntry[] }[] = [];
  if (map.has(null)) groups.push({ phaseLabel: null, nodes: map.get(null)! });
  for (const [key, list] of map) {
    if (key !== null) groups.push({ phaseLabel: key, nodes: list });
  }
  return groups;
}

function WorkflowNodeRow({
  node,
  agents,
  open,
  onToggle,
}: {
  node: AgentActivityEntry;
  agents: Agent[];
  open: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isStep = node.kind === 'workflow_step';
  const info = isStep ? null : resolveAgentDisplayInfo({
    id: node.agentId,
    agents,
    fallbackAgentName: node.label || node.agentName || node.agentId || 'Agent',
  });
  const displayName = isStep
    ? (node.label || STEP_LABEL[node.stepKind || ''] || node.stepKind || '步骤')
    : (node.label || info!.displayName);
  const tokenText = typeof node.tokens === 'number' ? `${formatTokens(node.tokens)} tok` : '';

  useEffect(() => {
    if (!isStep && open && node.childSessionPath) {
      useStore.getState().setSubagentPreviewSessionPath(node.id, node.childSessionPath);
    }
  }, [isStep, open, node.childSessionPath, node.id]);

  return (
    <div className={styles.nodeItem}>
      <button
        type="button"
        className={styles.nodeRow}
        data-status={node.status}
        onClick={isStep ? undefined : onToggle}
        aria-expanded={isStep ? undefined : open}
      >
        <span className={`${styles.statusIcon} ${styles[`status-${node.status}`] ?? ''}`} aria-hidden="true">{STATUS_ICON[node.status]}</span>
        {isStep ? (
          <span className={styles.stepIcon} data-step-kind={node.stepKind}>
            <StepShape stepKind={node.stepKind} />
          </span>
        ) : (
          <span className={styles.nodeAvatar}><AgentAvatar info={info!} className={styles.nodeAvatarImg} alt={displayName} /></span>
        )}
        <span className={styles.nodeName} title={displayName}>{displayName}</span>
        {tokenText && <span className={styles.nodeTokens}>{tokenText}</span>}
      </button>
      {!isStep && open && (
        <div className={styles.details}>
          <div ref={scrollRef} className={styles.scroll}>
            <SubagentSessionPreview
              taskId={node.id}
              sessionPath={node.childSessionPath}
              agentId={node.agentId}
              streamStatus={node.status}
              summary={node.summary}
              scrollContainerRef={scrollRef}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseSection({
  phaseLabel,
  nodes,
  agents,
  expandedNodes,
  onToggleNode,
}: {
  phaseLabel: string | null;
  nodes: AgentActivityEntry[];
  agents: Agent[];
  expandedNodes: Record<string, boolean>;
  onToggleNode: (id: string) => void;
}) {
  const hasRunning = nodes.some((node) => node.status === 'running');
  const [open, setOpen] = useState(hasRunning);
  const doneCount = nodes.filter((node) => node.status === 'done').length;
  const sorted = [...nodes].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const preview = sorted.slice(0, 5);

  useEffect(() => {
    if (hasRunning) setOpen(true);
  }, [hasRunning]);

  return (
    <div className={styles.phaseSection}>
      {phaseLabel && (
        <button type="button" className={styles.phaseHeader} onClick={() => setOpen((value) => !value)}>
          <Chevron open={open} />
          <span className={styles.phaseName} title={phaseLabel}>{phaseLabel}</span>
          <span className={styles.headerDots}>
            {preview.map((node) => {
              if (node.kind === 'workflow_step') {
                return (
                  <span key={node.id} className={styles.miniDot} data-step-kind={node.stepKind}>
                    <StepShape stepKind={node.stepKind} size={12} />
                  </span>
                );
              }
              const info = resolveAgentDisplayInfo({
                id: node.agentId,
                agents,
                fallbackAgentName: node.label || node.agentName || node.agentId || 'Agent',
              });
              return (
                <span key={node.id} className={styles.miniAvatar}>
                  <AgentAvatar info={info} alt={info.displayName} />
                </span>
              );
            })}
            {sorted.length > 5 && <span className={styles.miniEllipsis}>...</span>}
          </span>
          <span className={styles.phaseCount}>{doneCount}/{nodes.length}</span>
        </button>
      )}
      {(open || !phaseLabel) && (
        <div className={styles.phaseNodes}>
          {nodes.map((node) => (
            <WorkflowNodeRow
              key={node.id}
              node={node}
              agents={agents}
              open={expandedNodes[node.id] === true}
              onToggle={() => onToggleNode(node.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkflowRow({
  workflow,
  nodes,
  agents,
  now,
  open,
  onToggle,
  expandedNodes,
  onToggleNode,
}: {
  workflow: AgentActivityEntry;
  nodes: AgentActivityEntry[];
  agents: Agent[];
  now: number;
  open: boolean;
  onToggle: () => void;
  expandedNodes: Record<string, boolean>;
  onToggleNode: (id: string) => void;
}) {
  const t: (k: string, v?: Record<string, string | number>) => string = window.t ?? ((k: string) => k);
  const duration = durationLabel(workflow, now, t);
  const agentNodes = nodes.filter((node) => node.kind === 'workflow_agent');
  const totalTokens = nodes.reduce((sum, node) => sum + (typeof node.tokens === 'number' ? node.tokens : 0), 0);
  const phases = groupByPhase(nodes);

  return (
    <div className={styles.item}>
      <button type="button" className={styles.row} data-status={workflow.status} onClick={onToggle} aria-expanded={open}>
        <span className={`${styles.statusIcon} ${styles[`status-${workflow.status}`] ?? ''}`} aria-hidden="true">{STATUS_ICON[workflow.status]}</span>
        <span className={styles.name} title={workflow.summary || ''}>{workflow.summary || workflow.id}</span>
        {agentNodes.length > 0 && <span className={styles.agentCount}>{t('rightWorkspace.workflow.agents', { n: agentNodes.length })}</span>}
        {totalTokens > 0 && <span className={styles.tokenSum}>{formatTokens(totalTokens)}</span>}
        {duration && <span className={styles.duration}>{duration}</span>}
      </button>
      {open && nodes.length > 0 && (
        <div className={styles.nodeList}>
          {phases.map((phase) => (
            <PhaseSection
              key={phase.phaseLabel || '__default__'}
              phaseLabel={phase.phaseLabel}
              nodes={phase.nodes}
              agents={agents}
              expandedNodes={expandedNodes}
              onToggleNode={onToggleNode}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowCard() {
  const [collapsed, setCollapsed] = useState(false);
  const [expandedWorkflows, setExpandedWorkflows] = useState<Record<string, boolean>>({});
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));
  const agents = useStore((s) => s.agents);
  const [now, setNow] = useState(() => Date.now());

  const workflows = all.filter((activity) => activity.kind === 'workflow');
  const hasRunning = all.some((activity) =>
    (activity.kind === 'workflow' || activity.kind === 'workflow_agent' || activity.kind === 'workflow_step') &&
    activity.status === 'running',
  );

  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning]);

  if (!workflows.length) return null;

  const t = window.t ?? ((k: string) => k);
  const sorted = [...workflows].sort((a, b) => {
    const rankDiff = rank(a.status) - rank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
  const nodesOf = (workflowId: string) =>
    all
      .filter((activity) =>
        (activity.kind === 'workflow_agent' || activity.kind === 'workflow_step') &&
        activity.parentTaskId === workflowId,
      )
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  return (
    <section className={`universal-card jian-card ${styles.card}`} aria-label={t('rightWorkspace.workflow.title')}>
      <button className={styles.header} type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
        <span className={styles.title}>{t('rightWorkspace.workflow.title')}</span>
        <span className={styles.count}>{sorted.length}</span>
        <Chevron open={!collapsed} />
      </button>
      {!collapsed && (
        <div className={styles.list}>
          {sorted.map((workflow) => (
            <WorkflowRow
              key={workflow.id}
              workflow={workflow}
              nodes={nodesOf(workflow.id)}
              agents={agents}
              now={now}
              open={expandedWorkflows[workflow.id] === true}
              onToggle={() => setExpandedWorkflows((prev) => ({ ...prev, [workflow.id]: !prev[workflow.id] }))}
              expandedNodes={expandedNodes}
              onToggleNode={(id) => setExpandedNodes((prev) => ({ ...prev, [id]: !prev[id] }))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
