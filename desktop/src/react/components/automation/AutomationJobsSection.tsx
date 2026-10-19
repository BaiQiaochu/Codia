import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../stores';
import { codiaFetch } from '../../hooks/use-codia-fetch';
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

  const [loadError, setLoadError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const requestVersion = useRef(0);
  const modelRequestVersion = useRef(0);

  const loadData = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const response = await codiaFetch('/api/desk/cron');
      const data = await response.json();
      if (response.ok === false || !Array.isArray(data.jobs)) throw new Error('计划读取失败');
      if (version !== requestVersion.current) return;
      setJobs(data.jobs);
      updateBadge(data.jobs);
      setLoaded(true);
      setLoadError(null);
      setRefreshVersion(value => value + 1);
    } catch (error) {
      if (version === requestVersion.current) setLoadError(error instanceof Error ? error.message : '计划读取失败');
    }
  }, []);

  const loadModels = useCallback(async () => {
    const version = ++modelRequestVersion.current;
    try {
      const response = await codiaFetch('/api/models');
      const data = await response.json();
      if (response.ok === false || !Array.isArray(data.models)) throw new Error('模型列表读取失败');
      if (version !== modelRequestVersion.current) return;
      setAvailableModels(data.models.filter((model: ModelOption) => model.id && model.provider));
      setModelsError(null);
    } catch (error) {
      if (version === modelRequestVersion.current) setModelsError(error instanceof Error ? error.message : '模型列表读取失败');
    }
  }, []);

  useEffect(() => {
    void loadData();
    const timer = setInterval(() => { void loadData(); }, 15_000);
    return () => { clearInterval(timer); requestVersion.current += 1; };
  }, [currentAgentId, loadData]);
  useEffect(() => {
    void loadModels();
    return () => { modelRequestVersion.current += 1; };
  }, [loadModels]);

  const mutateJob = useCallback(async (payload: Record<string, unknown>, fallbackMessage: string) => {
    try {
      const response = await codiaFetch('/api/desk/cron', {
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
    return mutateJob({ action: 'update', id: jobId, ...fields }, '保存任务计划失败');
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
    const response = await codiaFetch('/api/desk/cron', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        scheduleType: 'cron',
        schedule: '0 9 * * *',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        misfirePolicy: 'catch-up-once',
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
        <button className={styles.textButton} type="button" onClick={() => void loadData()}>刷新计划</button>
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
      {loadError && <p role="alert" className={styles.healthWarning}>计划读取失败：{loadError}{loaded ? '；仍显示上次成功读取的数据。' : ''}</p>}
      {modelsError && <p role="alert" className={styles.healthWarning}>模型读取失败：{modelsError} <button type="button" onClick={() => void loadModels()}>重试模型列表</button></p>}
      {!loaded && !loadError && <p role="status">正在读取计划…</p>}
      <div className={fp.automationList} id={listId}>
        {!loaded ? null : tabs.length === 0 ? (
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
                  refreshVersion={refreshVersion}
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
