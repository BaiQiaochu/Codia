import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { t } from '../helpers';
import { getErrorMessage } from '../shared-types';
import { memoryPath, memoryListPath, memoryRequest, memoryVersion, MemoryApiError, type MemoryItem, type ExperienceItem, type ExperienceState, type ExtractionJob, type MemoryFilters, type MemoryPageMeta, type MemoryListResponse, type MemoryBatchResult } from '../memory-api';
import { MemoryFactCard, ExperienceCard, stateLabel } from './MemoryGovernanceCards';
import styles from '../Settings.module.css';
import v2 from './MemoryGovernanceV2.module.css';
import { MemoryProjectFilter } from './MemoryProjectFilter';
import { MemoryBudgetSettings } from './MemoryBudgetSettings';
import { openTaskConsoleRun } from '../../utils/task-console-navigation';
import { closeSettingsModal } from '../../stores/settings-modal-actions';

type Tab = 'memories' | 'experiences' | 'review';
type Section = 'memories' | 'experiences' | 'jobs';
type ViewQuery = { filters: MemoryFilters; offsets: Record<Section, number>; reviewOnly: boolean };
const sectionLabels: Record<Section, string> = { memories: '事实与偏好', experiences: '经验', jobs: '提取队列' };
const suffixes: Record<Section, string> = { memories: '', experiences: '/experiences', jobs: '/extractions' };
const sections: Section[] = ['memories', 'experiences', 'jobs'];
const emptyFilters = (): MemoryFilters => ({ q: '', projectId: '', source: '', status: '', from: '', to: '' });
const emptyQuery = (): ViewQuery => ({ filters: emptyFilters(), offsets: { memories: 0, experiences: 0, jobs: 0 }, reviewOnly: false });
const emptyMeta = (): MemoryPageMeta => ({ total: 0, pendingTotal: 0, limit: 25, offset: 0, projects: [], sources: [] });
const isPendingMemory = (item: MemoryItem) => ['candidate', 'conflict', 'expired'].includes(item.status) || item.reviewStatus === 'unverified' || !!(item.expiresAt && Date.parse(item.expiresAt) <= Date.now());
const memoryReviewPriority = (item: MemoryItem) => item.status === 'conflict' ? 0 : item.status === 'expired' || !!(item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) ? 1 : 2;
const isPendingExperience = (item: ExperienceItem) => ['candidate', 'validated'].includes(item.state);
const isPendingJob = (job: ExtractionJob) => ['failed', 'retryable', 'quarantined', 'retryable_failure'].includes(job.status);
function groupBySource<T>(items: T[], source: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) { const key = source(item); groups.set(key, [...(groups.get(key) || []), item]); }
  return [...groups];
}

export function MemoryViewer() {
  const generation = useRef(0);
  const mutationLock = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const query = useRef<ViewQuery>(emptyQuery());
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [experiences, setExperiences] = useState<ExperienceItem[]>([]);
  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [meta, setMeta] = useState<Record<Section, MemoryPageMeta>>({ memories: emptyMeta(), experiences: emptyMeta(), jobs: emptyMeta() });
  const [experienceEnabled, setExperienceEnabled] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadErrors, setLoadErrors] = useState<Partial<Record<Section, string>>>({});
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('memories');
  const [filters, setFilters] = useState(emptyFilters);
  const [selected, setSelected] = useState<MemoryItem[]>([]);
  const [batchPreview, setBatchPreview] = useState<{ operation: 'confirm' | 'forget'; items: MemoryItem[] } | null>(null);
  const [batchResults, setBatchResults] = useState<MemoryBatchResult[]>([]);

  const close = () => {
    if (mutationLock.current) return;
    ++generation.current; controller.current?.abort(); setVisible(false);
  };
  const load = async (aid: string, nextQuery = query.current, requested: Section[] = sections) => {
    const request = ++generation.current;
    query.current = nextQuery;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setLoading(true); setError(''); setNotice(''); setSelected([]); setBatchPreview(null); setBatchResults([]);
    setLoadErrors(current => Object.fromEntries(Object.entries(current).filter(([key]) => !requested.includes(key as Section))));
    for (const section of requested) {
      if (section === 'memories') setMemories([]);
      if (section === 'experiences') setExperiences([]);
      if (section === 'jobs') setJobs([]);
    }
    await Promise.all(requested.map(async section => {
      try {
        const body = await memoryRequest<MemoryListResponse>(memoryListPath(aid, suffixes[section], { ...nextQuery.filters, limit: 25, offset: nextQuery.offsets[section], reviewOnly: nextQuery.reviewOnly }), { signal: abort.signal });
        if (request !== generation.current) return;
        const records = section === 'memories' ? body.memories || [] : section === 'experiences' ? body.entries || [] : body.jobs || [];
        const pending = section === 'memories' ? (records as MemoryItem[]).filter(isPendingMemory).length : section === 'experiences' ? (records as ExperienceItem[]).filter(isPendingExperience).length : (records as ExtractionJob[]).filter(isPendingJob).length;
        setMeta(current => ({ ...current, [section]: { total: body.total ?? records.length, pendingTotal: body.pendingTotal ?? pending, limit: body.limit ?? 25, offset: body.offset ?? nextQuery.offsets[section], projects: body.projects || [], sources: body.sources || [] } }));
        if (section === 'memories') setMemories(body.memories || []);
        if (section === 'experiences') { setExperiences(body.entries || []); setExperienceEnabled(body.enabled === true); }
        if (section === 'jobs') setJobs(body.jobs || []);
      } catch (err) {
        if (request !== generation.current || abort.signal.aborted) return;
        setLoadErrors(current => ({ ...current, [section]: getErrorMessage(err) }));
      }
    }));
    if (request === generation.current) setLoading(false);
  };
  useEffect(() => {
    const handler = () => {
      if (mutationLock.current) return;
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const aid = useSettingsStore.getState().getSettingsAgentId() || '';
      setAgentId(aid); setVisible(true); setTab('memories'); setFilters(emptyFilters());
      setMeta({ memories: emptyMeta(), experiences: emptyMeta(), jobs: emptyMeta() });
      void load(aid, emptyQuery());
    };
    window.addEventListener('codia-view-memories', handler);
    const requestGeneration = generation;
    const requestController = controller;
    return () => { window.removeEventListener('codia-view-memories', handler); ++requestGeneration.current; requestController.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!visible) return;
    closeRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key !== 'Tab') return;
      const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') || [])].filter(node => !node.closest('details:not([open])') || node.tagName === 'SUMMARY');
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => { window.removeEventListener('keydown', handleKey); previousFocus.current?.focus(); };
  }, [visible]);
  const openRunDetails = (runId: string) => {
    if (mutationLock.current) return false;
    // A standalone settings window has no task panel. Do not report navigation in a hidden store.
    if (document.getElementById('settingsPanel') && !document.querySelector('[data-settings-return]')) {
      setError(`请在桌面主窗口的“任务与成果”查看运行 ${runId}；此独立设置窗口无法显示任务详情。`);
      return false;
    }
    if (!openTaskConsoleRun(runId)) { setError('无法定位这条运行的任务详情，请核对运行来源。'); return false; }
    close(); closeSettingsModal(); return true;
  };
  const runMutation = async (operation: () => Promise<void>, success: string) => {
    if (mutationLock.current) return false;
    mutationLock.current = true;
    const request = generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      await operation();
      if (request !== generation.current) return false;
      setNotice(success); return true;
    } catch (err) {
      if (request !== generation.current) return false;
      if (err instanceof MemoryApiError && err.status === 409 && (!err.payload.code || err.payload.code === 'revision_conflict')) {
        const current = err.payload.current;
        if (current && typeof current === 'object') {
          if ('fact' in current) setMemories(items => items.map(item => item.id === (current as MemoryItem).id ? current as MemoryItem : item));
          else setExperiences(items => items.map(item => item.id === (current as ExperienceItem).id ? current as ExperienceItem : item));
        }
        setError('这条记录已被更新。已载入最新版本，编辑内容已保留；请核对后再次保存。');
      } else {
        const messages: Record<string, string> = {
          run_not_found: '所选运行已不存在或不属于当前助手，请重新选择真实运行。',
          run_outcome_mismatch: '人工核实结果与记录中的运行状态不一致；处理中或未知状态不能作为成功证据。',
          environment_mismatch: '真实运行环境与此经验的适用范围不匹配，请核对项目、频道与版本。',
          user_review_required: '需要已认证的用户进行人工核实。',
          evidence_required: '需要先记录并核实当前版本的真实成功或失败结果，未知结果不能用于验证。',
          invalid_transition: '当前状态不支持此操作，请刷新后核对。',
          source_invalidated: '来源已被纠正或遗忘，此经验不能继续使用。',
          duplicate_run: '此运行的结果已经记录，不能重复计为独立证据。',
          idempotency_conflict: '同一操作标识对应了不同内容，请刷新并核对已经保存的结果。',
        };
        setError(err instanceof MemoryApiError && messages[String(err.payload.code)] ? messages[String(err.payload.code)] : getErrorMessage(err));
      }
      return false;
    } finally {
      mutationLock.current = false;
      if (request === generation.current) setBusy(false);
    }
  };

  const openEvidence = (sessionId: string) => runMutation(async () => {
    const sessions = await memoryRequest<{ sessionId: string; path: string; agentId: string }[]>('/api/sessions');
    const session = sessions.find(item => item.sessionId === sessionId && item.agentId === agentId);
    if (!session) throw new Error('来源会话已删除或当前不可用；原始来源标识仍保留。');
    const desktop = window as unknown as { codia?: { quickChatOpenSession?: (path: string) => Promise<unknown> } };
    if (!desktop.codia?.quickChatOpenSession) throw new Error('请在桌面主窗口中打开来源会话。');
    if (await desktop.codia.quickChatOpenSession(session.path) === false) throw new Error('无法打开来源会话，请稍后再试。');
  }, '来源会话已打开。');

  const reconcileMemory = (previous: MemoryItem, next?: MemoryItem) => {
    const pendingDelta = Number(!!next && isPendingMemory(next)) - Number(isPendingMemory(previous));
    setMemories(items => next ? items.map(item => item.id === previous.id ? next : item) : items.filter(item => item.id !== previous.id));
    setMeta(current => ({ ...current, memories: { ...current.memories, pendingTotal: Math.max(0, current.memories.pendingTotal + pendingDelta), total: Math.max(0, current.memories.total + (next ? query.current.reviewOnly ? pendingDelta : 0 : -1)) } }));
  };
  const reconcileExperience = (previous: ExperienceItem, next: ExperienceItem) => {
    const delta = Number(isPendingExperience(next)) - Number(isPendingExperience(previous));
    setExperiences(items => items.map(item => item.id === previous.id ? next : item));
    setMeta(current => ({ ...current, experiences: { ...current.experiences, pendingTotal: Math.max(0, current.experiences.pendingTotal + delta), total: Math.max(0, current.experiences.total + (query.current.reviewOnly ? delta : 0)) } }));
  };
  const refreshFilteredSection = async (section: 'memories' | 'experiences') => {
    // Mutating a status, scope, text or date can move a record outside the active query.
    // Re-evaluate active filters on the server rather than trying to emulate its search here.
    if (!Object.values(query.current.filters).some(Boolean)) return;
    try {
      const body = await memoryRequest<MemoryListResponse>(memoryListPath(agentId, suffixes[section], { ...query.current.filters, limit: 25, offset: query.current.offsets[section], reviewOnly: query.current.reviewOnly }));
      if (section === 'memories') setMemories(body.memories || []);
      else setExperiences(body.entries || []);
      setMeta(current => ({ ...current, [section]: { ...current[section], total: body.total ?? current[section].total, pendingTotal: body.pendingTotal ?? current[section].pendingTotal } }));
    } catch { setLoadErrors(current => ({ ...current, [section]: '操作已保存，当前筛选结果刷新失败。请刷新核对。' })); }
  };
  const refreshDerived = async () => {
    try {
      const body = await memoryRequest<MemoryListResponse>(memoryListPath(agentId, '/experiences', { ...query.current.filters, limit: 25, offset: query.current.offsets.experiences, reviewOnly: query.current.reviewOnly }));
      setExperiences(body.entries || []);
      setMeta(current => ({ ...current, experiences: { ...current.experiences, total: body.total ?? body.entries?.length ?? 0, pendingTotal: body.pendingTotal ?? (body.entries || []).filter(isPendingExperience).length } }));
    } catch { setLoadErrors(current => ({ ...current, experiences: '事实已更新，关联经验列表刷新失败。请刷新后查看最新状态。' })); }
  };
  const updateMemory = (memory: MemoryItem, patch: Record<string, unknown>) => runMutation(async () => {
    const body = await memoryRequest<{ memory: MemoryItem }>(memoryPath(agentId, `/${memory.id}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, ...memoryVersion(memory) }) });
    reconcileMemory(memory, body.memory); setSelected(items => items.filter(item => item.id !== memory.id)); await refreshFilteredSection('memories'); await refreshDerived();
  }, '记忆已更新，旧的派生内容已失效。');
  const forgetMemory = (memory: MemoryItem) => runMutation(async () => {
    await memoryRequest(memoryPath(agentId, `/${memory.id}`), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(memoryVersion(memory)) });
    reconcileMemory(memory); setSelected(items => items.filter(item => item.id !== memory.id)); await refreshFilteredSection('memories'); await refreshDerived();
  }, '已忘记此事实，并记录持久遗忘标记。');
  const transition = (entry: ExperienceItem, state: ExperienceState) => runMutation(async () => {
    const body = await memoryRequest<{ entry: ExperienceItem }>(memoryPath(agentId, `/experiences/${encodeURIComponent(entry.id)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, expectedRevision: entry.revision }) });
    reconcileExperience(entry, body.entry); await refreshFilteredSection('experiences');
  }, '经验状态已更新。');
  const reviseExperience = (entry: ExperienceItem, patch: Record<string, unknown>) => runMutation(async () => {
    const body = await memoryRequest<{ entry: ExperienceItem }>(memoryPath(agentId, `/experiences/${encodeURIComponent(entry.id)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch, expectedRevision: entry.revision }) });
    reconcileExperience(entry, body.entry); await refreshFilteredSection('experiences');
  }, '经验已纠正并回到候选状态，请用新版本核实结果后再启用。');
  const review = (entry: ExperienceItem, evidence: Record<string, unknown>) => runMutation(async () => {
    const body = await memoryRequest<{ entry: ExperienceItem }>(memoryPath(agentId, `/experiences/${encodeURIComponent(entry.id)}/review`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...evidence, expectedRevision: entry.revision }) });
    reconcileExperience(entry, body.entry); await refreshFilteredSection('experiences');
  }, '核实结果已记录；只有符合条件的经验才能继续验证和启用。');
  const attempt = (entry: ExperienceItem, runId: string) => runMutation(async () => {
    const body = await memoryRequest<{ entry: ExperienceItem }>(memoryPath(agentId, `/experiences/${encodeURIComponent(entry.id)}/attempt`), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: entry.revision, runId, confirmed: true }) });
    reconcileExperience(entry, body.entry); await refreshFilteredSection('experiences');
  }, '已关联实际采用的运行；采用不等于成功，仍需人工核实结果。');
  const retry = (job: ExtractionJob) => runMutation(async () => {
    const body = await memoryRequest<MemoryListResponse>(memoryListPath(agentId, '/extractions/retry', { ...query.current.filters, limit: 25, offset: query.current.offsets.jobs, reviewOnly: query.current.reviewOnly }), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: job.key }) });
    setJobs(body.jobs || []);
    setMeta(current => ({ ...current, jobs: { ...current.jobs, total: body.total ?? body.jobs?.length ?? 0, pendingTotal: body.pendingTotal ?? (body.jobs || []).filter(isPendingJob).length } }));
  }, '已重新排队，将在下次记忆整理时尝试；尚未视为提取成功。');
  const processBatch = () => {
    if (!batchPreview) return;
    const preview = batchPreview;
    void runMutation(async () => {
      const body = await memoryRequest<{ results: MemoryBatchResult[] }>(memoryPath(agentId, '/batch'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: preview.operation, confirmed: true, items: preview.items.map(item => ({ id: item.id, ...memoryVersion(item) })) }) });
      // Treat a missing per-item acknowledgement as a failure, never an implicit success.
      const results = preview.items.map(item => body.results.find(result => result.id === item.id) || { id: item.id, ok: false, error: '服务器未返回此条结果，请刷新核对。' });
      for (const result of results) {
        const previous = preview.items.find(item => item.id === result.id)!;
        if (result.ok) reconcileMemory(previous, preview.operation === 'forget' ? undefined : result.memory || previous);
        else if (result.current) reconcileMemory(previous, result.current);
      }
      setBatchResults(results); setBatchPreview(null); setSelected([]); await refreshFilteredSection('memories'); await refreshDerived();
    }, '批量处理已返回逐条结果，请核对下方成功和失败项。');
  };
  const switchTab = (next: Tab) => {
    setTab(next); setSelected([]); setBatchPreview(null); setBatchResults([]); setError(''); setNotice('');
    if ((next === 'review') !== query.current.reviewOnly) void load(agentId, { ...query.current, reviewOnly: next === 'review', offsets: { memories: 0, experiences: 0, jobs: 0 } });
  };

  if (!visible) return null;
  const shownMemories = tab === 'review' ? memories.filter(isPendingMemory).sort((a, b) => memoryReviewPriority(a) - memoryReviewPriority(b)) : tab === 'memories' ? memories : [];
  const shownExperiences = tab === 'review' ? experiences.filter(isPendingExperience) : tab === 'experiences' ? experiences : [];
  const pendingJobs = jobs.filter(isPendingJob);
  const pendingCount = meta.memories.pendingTotal + meta.experiences.pendingTotal + meta.jobs.pendingTotal;
  const disabled = busy || loading;
  const relevantErrors = Object.entries(loadErrors).filter(([section]) => tab === 'review' || section === tab);
  const projects = [...new Map(sections.flatMap(section => meta[section].projects).map(project => [project.id, project])).values()];
  const sources = [...new Set(sections.flatMap(section => meta[section].sources))];
  const pagination = (section: Section) => {
    const page = meta[section];
    return <div className={v2.pagination} aria-label={`${sectionLabels[section]}分页`}>
      <span>{sectionLabels[section]} · 共 {page.total} 条 · 第 {Math.floor(page.offset / page.limit) + 1} / {Math.max(1, Math.ceil(page.total / page.limit))} 页</span>
      <button type="button" className={styles['memory-action-btn']} aria-label={`${sectionLabels[section]}上一页`} disabled={disabled || page.offset === 0} onClick={() => void load(agentId, { ...query.current, offsets: { ...query.current.offsets, [section]: Math.max(0, page.offset - page.limit) } }, [section])}>上一页</button>
      <button type="button" className={styles['memory-action-btn']} aria-label={`${sectionLabels[section]}下一页`} disabled={disabled || page.offset + page.limit >= page.total} onClick={() => void load(agentId, { ...query.current, offsets: { ...query.current.offsets, [section]: page.offset + page.limit } }, [section])}>下一页</button>
    </div>;
  };
  return <div className={`${styles['memory-viewer-overlay']} ${styles.visible}`} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialogRef} className={`${styles['memory-viewer']} ${styles['memory-governance-viewer']}`} role="dialog" aria-modal="true" aria-label={t('settings.memory.actions.viewTitle')}>
      <div className={styles['memory-viewer-header']}>
        <h3 className={styles['memory-viewer-title']}>记忆与经验</h3>
        <div className={styles['memory-viewer-header-actions']}>
          <button type="button" className={styles['memory-action-btn']} disabled={disabled} onClick={() => void load(agentId)}>刷新</button>
          <button type="button" ref={closeRef} className={styles['memory-viewer-close']} aria-label="关闭记忆" disabled={busy} onClick={close}>×</button>
        </div>
      </div>
      <div className={styles['memory-governance-tabs']} role="tablist" aria-label="记忆分类">
        {([['memories', `记忆 (${meta.memories.total})`], ['experiences', `经验 (${meta.experiences.total})`], ['review', `待核实 (${pendingCount})`]] as const).map(([id, label]) => <button type="button" key={id} role="tab" aria-selected={tab === id} aria-controls={`memory-panel-${id}`} id={`memory-tab-${id}`} disabled={disabled} onClick={() => switchTab(id)}>{label}</button>)}
      </div>
      <div className={styles['memory-viewer-body']} role="tabpanel" id={`memory-panel-${tab}`} aria-labelledby={`memory-tab-${tab}`}>
        <p className={styles['memory-governance-meta']}>当前助手：{agentId}。来源和项目范围决定能否使用；记忆或经验不能授予执行权限。</p>
        <form className={v2.filters} onSubmit={event => { event.preventDefault(); if (!disabled) void load(agentId, { filters, offsets: { memories: 0, experiences: 0, jobs: 0 }, reviewOnly: tab === 'review' }); }}>
          <label className={v2.search}>检索记忆与经验<input aria-label="检索记忆与经验" value={filters.q} disabled={busy} onChange={event => setFilters(current => ({ ...current, q: event.target.value }))} /></label>
          <MemoryProjectFilter agentId={agentId} value={filters.projectId} projects={projects} busy={busy} onChange={projectId => setFilters(current => ({ ...current, projectId }))} />
          <label>筛选来源<input aria-label="筛选来源" list="memory-source-options" placeholder="输入来源 ID 或选择已知来源" value={filters.source} disabled={busy} onChange={event => setFilters(current => ({ ...current, source: event.target.value }))} /><datalist id="memory-source-options">{sources.map(source => <option key={source} value={source} />)}</datalist></label>
          <label>筛选状态<select aria-label="筛选状态" value={filters.status} disabled={busy} onChange={event => setFilters(current => ({ ...current, status: event.target.value }))}><option value="">全部状态</option>{['candidate', 'active', 'conflict', 'superseded', 'expired', 'validated', 'enabled', 'withdrawn', 'failed', 'retryable', 'quarantined', 'running', 'succeeded', 'cancelled'].map(status => <option key={status} value={status}>{stateLabel(status)}</option>)}</select></label>
          <label>开始日期<input aria-label="开始日期" type="date" value={filters.from} disabled={busy} onChange={event => setFilters(current => ({ ...current, from: event.target.value }))} /></label>
          <label>结束日期<input aria-label="结束日期" type="date" min={filters.from || undefined} value={filters.to} disabled={busy} onChange={event => setFilters(current => ({ ...current, to: event.target.value }))} /></label>
          <div className={v2.filterActions}><button type="submit" className={styles['memory-action-btn']} disabled={disabled || !!(filters.from && filters.to && filters.from > filters.to)}>应用筛选</button><button type="button" className={styles['memory-action-btn']} disabled={disabled} onClick={() => { setFilters(emptyFilters()); void load(agentId, { ...emptyQuery(), reviewOnly: tab === 'review' }); }}>清除筛选</button></div>
        </form>
        {tab === 'memories' && <p className={styles['memory-governance-notice']}>纠错或忘记会同步使旧的派生记忆失效。忘记会保留阻止自动重新提取的标记，原始聊天仍保留；备份不会立即物理删除。</p>}
        {tab === 'experiences' && <p className={styles['memory-governance-notice']}>候选 → 已验证 → 已启用 → 已撤回。检索和点击不算成功，只有核实的真实运行结果才计入成功或失败。{!experienceEnabled && '经验调用当前已暂停；仍可查看和治理已有记录。'}</p>}
        {tab === 'review' && <p className={styles['memory-governance-notice']}>优先核对冲突和失效记录。待核实计数覆盖筛选范围的全部页；各类记录独立分页。批量处理仅限明确选中的事实，经验仍需逐条核实和启用。</p>}
        {tab === 'review' && <MemoryBudgetSettings agentId={agentId} disabled={disabled} onAcquireMutation={() => { if (mutationLock.current) return false; mutationLock.current = true; setBusy(true); return true; }} onReleaseMutation={() => { mutationLock.current = false; setBusy(false); }} />}
        {error && <p className={styles['memory-governance-error']} role="alert">{error}</p>}
        {relevantErrors.map(([section, message]) => <p key={section} className={styles['memory-governance-error']} role="alert">{sectionLabels[section as Section]}加载失败：{message}。可点击刷新重试。</p>)}
        {notice && <p className={styles['memory-governance-notice']} role="status">{notice}</p>}
        {(loading || busy) && <p role="status">{loading ? '正在加载来源与记录…' : '正在处理，请稍候…'}</p>}
        {!loading && !relevantErrors.length && shownMemories.length === 0 && shownExperiences.length === 0 && (tab !== 'review' || !pendingJobs.length) && <p className={styles['memory-governance-empty']}>{tab === 'review' ? '没有待核实的记录。' : tab === 'experiences' ? '还没有经验。完成任务后形成的候选会显示在这里。' : t('settings.memory.actions.empty')}</p>}
        {tab !== 'experiences' && <>
          <div className={v2.selection}><span>已选择 {selected.length} 条事实（仅当前页）</span><button type="button" className={styles['memory-action-btn']} disabled={disabled || !selected.length} onClick={() => setBatchPreview({ operation: 'confirm', items: [...selected] })}>预览批量确认</button><button type="button" className={styles['memory-action-btn']} disabled={disabled || !selected.length} onClick={() => setBatchPreview({ operation: 'forget', items: [...selected] })}>预览批量忘记</button><button type="button" className={styles['memory-action-btn']} disabled={disabled || !selected.length} onClick={() => { setSelected([]); setBatchPreview(null); }}>清除选择</button></div>
          {batchPreview && <section className={v2.preview} role="region" aria-label="批量事实预览"><p>即将{batchPreview.operation === 'confirm' ? '确认有效' : '忘记'}以下 {batchPreview.items.length} 条明确选择的事实。逐条核对内容、来源、项目、有效期与版本。</p>{batchPreview.operation === 'forget' && <p>遗忘标记会阻止旧来源重新提取；原始聊天及备份仍保留。</p>}<ul>{batchPreview.items.map(item => <li key={item.id}><strong>#{item.id} · 版本 {item.revision ?? item.updated_at} · {item.projectId || '此助手全局'}</strong><p>{item.fact}</p><span>来源：{item.source || item.sourceRefs?.[0]?.sessionId || '未记录'} · 有效期：{item.expiresAt || '未设置'}</span></li>)}</ul><div className={v2.selection}><button type="button" className={styles['memory-action-btn']} disabled={disabled} onClick={processBatch}>确认处理 {batchPreview.items.length} 条事实</button><button type="button" className={styles['memory-action-btn']} disabled={busy} onClick={() => setBatchPreview(null)}>取消批量处理</button></div></section>}
          {batchResults.length > 0 && <section className={v2.results} aria-label="批量逐条结果" aria-live="polite"><p>成功 {batchResults.filter(result => result.ok).length} 条，失败 {batchResults.filter(result => !result.ok).length} 条。失败项未覆盖，重新选择前请核对最新版本。</p><ul>{batchResults.map(result => <li key={result.id}>#{result.id}：{result.ok ? '成功' : result.code === 'revision_conflict' ? '版本冲突，已载入最新版本；原批量内容未覆盖。' : result.error || '处理失败'}</li>)}</ul></section>}
          {groupBySource(shownMemories, memory => memory.source || memory.sourceRefs?.[0]?.sessionId || memory.session_id || '来源未记录').map(([source, items]) => <section key={source} className={v2.group} aria-label={`事实来源 ${source}`}><h4>来源：{source}</h4>{items.map(memory => <React.Fragment key={memory.id}><label className={v2.selectionLabel}><input type="checkbox" aria-label={`选择事实 ${memory.id}`} disabled={disabled || !!batchPreview} checked={selected.some(item => item.id === memory.id)} onChange={event => setSelected(current => event.target.checked ? [...current, memory] : current.filter(item => item.id !== memory.id))} />选择事实 #{memory.id}</label><MemoryFactCard memory={memory} agentId={agentId} projects={projects} busy={disabled || !!batchPreview} onUpdate={updateMemory} onForget={forgetMemory} onOpenSource={sessionId => { void openEvidence(sessionId); }} /></React.Fragment>)}</section>)}
          {!loadErrors.memories && pagination('memories')}
        </>}
        {groupBySource(shownExperiences, entry => entry.sourceRefs[0] ? `${entry.sourceRefs[0].type}:${entry.sourceRefs[0].id}` : '来源未记录').map(([source, items]) => <section key={source} className={v2.group} aria-label={`经验来源 ${source}`}><h4>来源：{source}</h4>{items.map(entry => <ExperienceCard key={entry.id} entry={entry} agentId={agentId} projects={projects} busy={disabled} onTransition={transition} onReview={review} onRevise={reviseExperience} onAttempt={attempt} onOpenRun={openRunDetails} />)}</section>)}
        {tab !== 'memories' && !loadErrors.experiences && pagination('experiences')}
        {tab === 'review' && <>{pendingJobs.map(job => <section key={job.key} className={styles['memory-governance-card']} aria-label="提取失败记录">
          <p>来源会话：{job.sessionId || '未记录'} · {job.status} · 尝试 {job.attempts || 0} 次</p><p className={styles['memory-governance-meta']}>{job.error || '提取未完成，未标记为成功。'}</p>
          {job.nextRetryAt && <p className={styles['memory-governance-meta']}>下次可重试：{job.nextRetryAt}</p>}
          {job.attempts === 0 && !job.error ? <p className={styles['memory-governance-meta']}>已排队，等待下一轮记忆整理。</p> : <button type="button" className={styles['memory-action-btn']} disabled={disabled} onClick={() => void retry(job)}>重新排队提取</button>}
        </section>)}{!loadErrors.jobs && pagination('jobs')}</>}
      </div>
    </div>
  </div>;
}
