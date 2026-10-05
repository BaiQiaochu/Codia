import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { AgentAvatar, resolveAgentDisplayInfo } from '../../utils/agent-display';
import fp from '../FloatingPanels.module.css';
import styles from './AutomationPanel.module.css';
import { AgentTabScroller, type AgentTabScrollerItem } from './AgentTabScroller';
import { AutomationCard } from './AutomationCard';
import type { CronJob, ModelOption } from './automation-types';
import { filterJobsForAgentIds, jobAgentId } from './automation-utils';
import type { Agent } from '../../types';

function updateBadge(jobs: CronJob[]) {
  useStore.setState({ automationCount: jobs.length });
}

function primaryAgentId(agents: Agent[], currentAgentId: string | null) {
  return currentAgentId || agents.find(agent => agent.isPrimary)?.id || agents[0]?.id || null;
}

function groupJobs(jobs: CronJob[], currentAgentId: string | null) {
  const groups = new Map<string, CronJob[]>();
  for (const job of jobs) {
    const agentId = jobAgentId(job, currentAgentId) || '__unknown__';
    const list = groups.get(agentId) || [];
    list.push(job);
    groups.set(agentId, list);
  }
  return groups;
}

function agentTabIds(agents: Agent[], groups: Map<string, CronJob[]>) {
  const ids = agents.map(agent => agent.id);
  for (const id of groups.keys()) {
    if (id !== '__unknown__' && !ids.includes(id)) ids.push(id);
  }
  if (groups.has('__unknown__')) ids.push('__unknown__');
  return ids;
}

function uniqueAgentIds(agentIds: readonly string[]) {
  return [...new Set(agentIds.map(id => String(id || '').trim()).filter(Boolean))];
}

export function AutomationJobsSection({
  allowedAgentIds,
  emptyMessage,
  listId = 'automationList',
}: {
  allowedAgentIds?: readonly string[];
  emptyMessage?: string;
  listId?: string;
}) {
  const agentAvatarUrl = useStore(state => state.agentAvatarUrl);
  const agentName = useStore(state => state.agentName);
  const agentYuan = useStore(state => state.agentYuan);
  const currentAgentId = useStore(state => state.currentAgentId);
  const currentSessionPath = useStore(state => state.currentSessionPath);
  const currentSessionProjection = useStore(state => state.currentSessionPath
    ? state.sessions.find(session => session.path === state.currentSessionPath)
    : null);
  const deskBasePath = useStore(state => state.deskBasePath);
  const deskWorkspaceMountId = useStore(state => state.deskWorkspaceMountId);
  const homeFolder = useStore(state => state.homeFolder);
  const agents = useStore(state => state.agents);
  const addToast = useStore(state => state.addToast);
  const t = window.t ?? ((path: string) => path);

  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(currentAgentId);
  const [openJobs, setOpenJobs] = useState<Record<string, boolean>>({});

  const loadData = useCallback(async () => {
    try {
      const [cronRes, modelsRes] = await Promise.all([
        gsapFetch('/api/desk/cron'),
        gsapFetch('/api/models'),
      ]);
      const cronData = await cronRes.json();
      const modelsData = await modelsRes.json().catch(() => ({ models: [] }));
      const modelOptions = (modelsData.models || [])
        .filter((model: { id?: string; provider?: string }) => model.id && model.provider)
        .map((model: { id: string; provider: string; name?: string }) => ({
          id: model.id,
          provider: model.provider,
          name: model.name,
        }));
      const nextJobs = Array.isArray(cronData.jobs) ? cronData.jobs : [];
      setJobs(nextJobs);
      setAvailableModels(modelOptions);
      updateBadge(nextJobs);
    } catch (error) {
      console.error('[automation] load failed:', error);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [currentAgentId, loadData]);

  const mutateJob = useCallback(async (payload: Record<string, unknown>, fallbackMessage: string) => {
    try {
      const response = await gsapFetch('/api/desk/cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || (data && typeof data.error === 'string' && data.error)) {
        throw new Error(data?.error || fallbackMessage);
      }
      await loadData();
      return true;
    } catch (error) {
      addToast(error instanceof Error ? error.message : fallbackMessage, 'error');
      return false;
    }
  }, [addToast, loadData]);

  const toggleJob = useCallback(async (jobId: string) => {
    await mutateJob({ action: 'toggle', id: jobId }, '切换任务计划失败');
  }, [mutateJob]);

  const removeJob = useCallback(async (jobId: string) => {
    await mutateJob({ action: 'remove', id: jobId }, '删除任务计划失败');
  }, [mutateJob]);

  const updateJob = useCallback(async (jobId: string, fields: Record<string, unknown>) => {
    await mutateJob({ action: 'update', id: jobId, ...fields }, '保存任务计划失败');
  }, [mutateJob]);

  const scopedAgentIds = useMemo(
    () => allowedAgentIds === undefined ? null : uniqueAgentIds(allowedAgentIds),
    [allowedAgentIds],
  );
  const scopedJobs = useMemo(
    () => scopedAgentIds === null ? jobs : filterJobsForAgentIds(jobs, scopedAgentIds, currentAgentId),
    [currentAgentId, jobs, scopedAgentIds],
  );
  const groups = useMemo(() => groupJobs(scopedJobs, currentAgentId), [currentAgentId, scopedJobs]);
  const tabs = useMemo(
    () => scopedAgentIds === null ? agentTabIds(agents, groups) : scopedAgentIds,
    [agents, groups, scopedAgentIds],
  );
  const activeAgentId = selectedAgentId && tabs.includes(selectedAgentId)
    ? selectedAgentId
    : tabs[0] || null;
  const activeJobs = activeAgentId ? groups.get(activeAgentId) || [] : [];
  const canAddJob = !!activeAgentId
    || (scopedAgentIds === null && !!primaryAgentId(agents, currentAgentId));

  const addManualJob = useCallback(async () => {
    const tr = window.t ?? ((path: string) => path);
    const tabAgentId = activeAgentId && activeAgentId !== '__unknown__' ? activeAgentId : null;
    const actorAgentId = tabAgentId || primaryAgentId(agents, currentAgentId);
    if (!actorAgentId) {
      addToast(tr('automation.agentRequired'), 'error');
      return;
    }
    const cwd = deskWorkspaceMountId
      ? (currentSessionProjection?.cwd || null)
      : (deskBasePath || homeFolder || null);
    const response = await gsapFetch('/api/desk/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        scheduleType: 'cron',
        schedule: '0 9 * * *',
        label: tr('automation.newAutomation'),
        prompt: '',
        enabled: false,
        actorAgentId,
        executionContext: {
          kind: 'ui_manual',
          cwd,
          workspaceFolders: cwd ? [cwd] : [],
          sourceSessionPath: currentSessionPath,
          createdByAgentId: actorAgentId,
        },
        createdBy: { kind: 'user' },
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      addToast(data.error || tr('automation.createFailed'), 'error');
      return;
    }
    const data = await response.json();
    await loadData();
    if (data.job?.id) setOpenJobs(previous => ({ ...previous, [data.job.id]: true }));
  }, [activeAgentId, addToast, agents, currentAgentId, currentSessionPath, currentSessionProjection?.cwd, deskBasePath, deskWorkspaceMountId, homeFolder, loadData]);

  const agentTabItems = useMemo<AgentTabScrollerItem[]>(() => tabs.map(agentId => {
    const info = resolveAgentDisplayInfo({
      id: agentId === '__unknown__' ? null : agentId,
      agents,
      fallbackAgentName: agentName,
      fallbackAgentYuan: agentYuan,
      fallbackAgentAvatarUrl: agentAvatarUrl,
    });
    return {
      id: agentId,
      label: info.displayName,
      avatar: <AgentAvatar info={info} className={styles.agentTabAvatar} />,
    };
  }), [agentAvatarUrl, agentName, agentYuan, agents, tabs]);

  useEffect(() => {
    if (activeAgentId && activeAgentId !== selectedAgentId) setSelectedAgentId(activeAgentId);
  }, [activeAgentId, selectedAgentId]);

  return (
    <>
      <div className={styles.toolbar}>
        <button
          className={styles.iconButton}
          type="button"
          onClick={() => void addManualJob()}
          title={t('automation.add')}
          aria-label={t('automation.add')}
          disabled={!canAddJob}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      <div className={fp.automationList} id={listId}>
        {tabs.length === 0 ? (
          <div className={fp.automationEmpty}>{emptyMessage || t('automation.empty')}</div>
        ) : (
          <>
            <AgentTabScroller
              items={agentTabItems}
              activeId={activeAgentId}
              ariaLabel={t('automation.agentTabs')}
              previousLabel={t('automation.previousAgent')}
              nextLabel={t('automation.nextAgent')}
              onSelect={setSelectedAgentId}
            />
            <div className={styles.groupList}>
              {activeJobs.length === 0 ? (
                <div className={fp.automationEmpty}>{t('automation.emptyForAgent')}</div>
              ) : activeJobs.map(job => (
                <AutomationCard
                  key={job.id}
                  job={job}
                  availableModels={availableModels}
                  open={openJobs[job.id] === true}
                  onToggleOpen={() => setOpenJobs(previous => ({ ...previous, [job.id]: previous[job.id] !== true }))}
                  onToggleEnabled={toggleJob}
                  onRemove={removeJob}
                  onUpdate={updateJob}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}
