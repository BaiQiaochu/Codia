import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { selectAgentActivities, type AgentActivityEntry } from '../../stores/agent-activity-slice';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import { SubagentSessionPreview } from '../chat/SubagentSessionPreview';
import type { Agent } from '../../types';
import styles from './AgentActivityCard.module.css';

function rank(status: AgentActivityEntry['status']): number {
  return status === 'running' ? 0 : 1;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={styles.chevron} data-open={open} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SubagentActivityRow({
  entry,
  agents,
  open,
  onToggle,
}: {
  entry: AgentActivityEntry;
  agents: Agent[];
  open: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const info = resolveAgentDisplayInfo({
    id: entry.agentId,
    agents,
    fallbackAgentName: entry.agentName || entry.agentId || 'Agent',
  });
  const displayLabel = entry.label || entry.reuseInstance || null;

  useEffect(() => {
    if (open && entry.childSessionPath) {
      useStore.getState().setSubagentPreviewSessionPath(entry.id, entry.childSessionPath);
    }
  }, [open, entry.childSessionPath, entry.id]);

  return (
    <div className={styles.item}>
      <button
        type="button"
        className={styles.activityRow}
        data-status={entry.status}
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className={styles.avatar}>
          <AgentAvatar info={info} className={styles.avatarImg} alt={info.displayName} />
        </span>
        <span className={styles.nameGroup}>
          <span className={styles.name} title={info.displayName}>{info.displayName}</span>
          {displayLabel ? <span className={styles.instance} title={displayLabel}>/{displayLabel}</span> : null}
        </span>
        <span className={styles.summary} title={entry.summary || ''}>{entry.summary || ''}</span>
      </button>
      {open && (
        <div className={styles.details}>
          <div ref={scrollRef} className={styles.scroll}>
            <SubagentSessionPreview
              taskId={entry.id}
              sessionPath={entry.childSessionPath}
              agentId={entry.agentId}
              streamStatus={entry.status}
              summary={entry.summary}
              scrollContainerRef={scrollRef}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentActivityCard() {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const sessionPath = useStore((s) => s.currentSessionPath);
  const all = useStore(selectAgentActivities(sessionPath));
  const agents = useStore((s) => s.agents);
  const t = window.t ?? ((k: string) => k);

  const activities = all.filter((activity) => activity.kind === 'subagent');
  if (!activities.length) return null;

  const sorted = [...activities].sort((a, b) => {
    const rankDiff = rank(a.status) - rank(b.status);
    if (rankDiff !== 0) return rankDiff;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  return (
    <section className={`universal-card jian-card ${styles.card}`} aria-label={t('rightWorkspace.subagent.title')}>
      <button className={styles.header} type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
        <span className={styles.title}>{t('rightWorkspace.subagent.title')}</span>
        <span className={styles.count}>{sorted.length}</span>
        <Chevron open={!collapsed} />
      </button>
      {!collapsed && (
        <div className={styles.list}>
          {sorted.map((activity) => (
            <SubagentActivityRow
              key={activity.id}
              entry={activity}
              agents={agents}
              open={expanded[activity.id] === true}
              onToggle={() => setExpanded((prev) => ({ ...prev, [activity.id]: !prev[activity.id] }))}
            />
          ))}
        </div>
      )}
    </section>
  );
}
