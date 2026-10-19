import React, { useEffect, useRef, useState } from 'react';
import { memoryListPath, memoryRequest, type MemoryProject, type MemoryRunPage, type RecordedMemoryRun } from '../memory-api';
import { getErrorMessage } from '../shared-types';
import styles from '../Settings.module.css';
import v2 from './MemoryGovernanceV2.module.css';

function safeWebUrl(value?: string) {
  try { const url = new URL(value || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
const diagnosticLabels: Record<string, string> = { missing_recorded_environment: '缺少运行时环境快照', missing_project: '缺少历史项目', missing_channel: '缺少历史频道', missing_dependency_snapshot: '缺少历史依赖版本' };
const timeLabel = (value?: string) => value === 'recorded' ? '记录值' : value === 'inferred' ? '推导值' : '来源未知';

export function MemoryProjectSelect({ label, value, projects, disabled, onChange }: {
  label: string; value: string; projects: MemoryProject[]; disabled: boolean; onChange: (value: string) => void;
}) {
  return <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    <option value="">选择项目</option>
    {value && !projects.some(project => project.id === value) && <option value={value}>{value}（当前记录）</option>}
    {projects.map(project => <option key={project.id} value={project.id}>{project.label} · {project.id}</option>)}
  </select></label>;
}

export function MemoryRunPicker({ agentId, busy, projects, selected, onSelect, onOpenRun }: {
  agentId: string; busy: boolean; projects: MemoryProject[]; selected: RecordedMemoryRun | null; onOpenRun: (runId: string) => boolean; onSelect: (run: RecordedMemoryRun | null) => void;
}) {
  const [runs, setRuns] = useState<RecordedMemoryRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState({ q: '', projectId: '', offset: 0, retry: 0 });
  const [total, setTotal] = useState(0);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [openError, setOpenError] = useState('');
  const [opening, setOpening] = useState(false);
  const [navigationNotice, setNavigationNotice] = useState('');
  const openGeneration = useRef(0);
  useEffect(() => { ++openGeneration.current; setOpening(false); setOpenError(''); setNavigationNotice(''); const current = openGeneration; return () => { ++current.current; }; }, [selected?.runId]);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setLoading(true); setError(''); setRuns([]);
    memoryRequest<MemoryRunPage>(memoryListPath(agentId, '/runs', { q: query.q, projectId: query.projectId, offset: query.offset, limit: 25 }), { signal: abort.signal }).then(body => {
      if (!active) return;
      setRuns(body.runs || []); setLimitations(body.limitations || []); setTotal(body.total ?? body.runs?.length ?? 0);
    }).catch(error => { if (active && !abort.signal.aborted) setError(getErrorMessage(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [agentId, query]);
  const openSession = async () => {
    if (!selected?.sessionId || opening) return;
    const request = ++openGeneration.current; setOpening(true); setOpenError('');
    try {
      const desktop = window as unknown as { codia?: { quickChatOpenSession?: (path: string) => Promise<unknown> } };
      if (!desktop.codia?.quickChatOpenSession) throw new Error('请在桌面主窗口查看运行来源会话。');
      if (await desktop.codia.quickChatOpenSession(selected.sessionId) === false) throw new Error('来源会话无法打开或已不可用。');
    } catch (error) { if (request === openGeneration.current) setOpenError(getErrorMessage(error)); }
    finally { if (request === openGeneration.current) setOpening(false); }
  };
  const changePage = (offset: number) => { onSelect(null); setQuery(current => ({ ...current, offset })); };
  return <div className={v2.runFields}>
    <p>仅列出此助手保存的真实运行。运行状态与退出码不能代替人工判断，也不会自动记为采用或成功。</p>
    <div className={v2.filters}>
      <label>检索运行<input aria-label="检索运行" value={q} disabled={busy} onChange={event => setQ(event.target.value)} /></label>
      <MemoryProjectSelect label="运行项目筛选" value={projectId} projects={projects} disabled={busy} onChange={setProjectId} />
      <button type="button" className={styles['memory-action-btn']} disabled={busy || loading} onClick={() => { onSelect(null); setQuery(current => ({ q, projectId, offset: 0, retry: current.retry + 1 })); }}>查找运行</button>
    </div>
    {limitations.map((limitation, index) => <p key={index} className={styles['memory-governance-meta']}>{limitation}</p>)}
    {loading && <p role="status">正在读取真实运行…</p>}
    {error && <p role="alert">运行加载失败：{error}。请点击查找运行重试。</p>}
    {!loading && !error && runs.length === 0 && <p>没有可用的真实运行。请调整筛选，或明确选择外部人工证据；不会生成占位运行。</p>}
    <label>选择真实运行<select aria-label="选择真实运行" disabled={busy || loading} value={selected?.runId || ''} onChange={event => onSelect(runs.find(run => run.runId === event.target.value) || null)}>
      <option value="">选择已记录的运行</option>
      {runs.map(run => <option key={run.runId} value={run.runId}>{run.title ? `${run.title} · ` : ''}{run.runId} · {run.status} · {run.startedAt || '时间未记录'}</option>)}
    </select></label>
    <div className={v2.pagination}>
      <span>共 {total} 次运行</span>
      <button type="button" className={styles['memory-action-btn']} aria-label="运行上一页" disabled={busy || loading || query.offset === 0} onClick={() => changePage(Math.max(0, query.offset - 25))}>上一页</button>
      <button type="button" className={styles['memory-action-btn']} aria-label="运行下一页" disabled={busy || loading || query.offset + 25 >= total} onClick={() => changePage(query.offset + 25)}>下一页</button>
    </div>
    {selected && <div className={v2.runDetails} aria-label="只读运行证据">
      <p>环境来源：{selected.environmentProvenance === 'recorded' ? '运行时记录（只读）' : selected.environmentProvenance === 'session_current' ? '当前会话环境，不能作为历史运行环境' : '历史环境未知'}</p>
      {selected.environmentProvenance !== 'recorded' && <p role="alert">缺少可信历史环境，不能用此运行核实经验。可以查看记录或独立提供外部人工证据。</p>}
      {selected.environmentDiagnostics?.map((diagnostic, index) => <p key={index}>{diagnosticLabels[diagnostic] || diagnostic}</p>)}
      <p>运行：{selected.runId} · 状态：{selected.status} · 退出码：{selected.exitCode ?? '未记录'}</p>
      <p>开始：{selected.startedAt || '未记录'}（{timeLabel(selected.timeProvenance?.startedAt)}） · 结束：{selected.finishedAt || '未记录'}（{timeLabel(selected.timeProvenance?.finishedAt)}）</p>
      <p>项目：{selected.environment.projectId || '未记录'} · 频道：{selected.environment.channel || '未记录'}</p>
      <p>平台：{selected.environment.platform || '未记录'} · 应用版本：{selected.environment.appVersion || '未记录'}</p>
      <p>依赖：{Object.entries(selected.environment.dependencyVersions || {}).map(([key, value]) => `${key}=${value}`).join(' · ') || '未记录'}</p>
      <p>证据引用：{selected.evidenceRef || '未记录'}</p>
      <details><summary>查看执行结果与成果引用</summary>
        <button type="button" className={styles['memory-action-btn']} disabled={busy} onClick={() => setNavigationNotice(onOpenRun(selected.runId) ? '已打开此运行的任务详情；可关闭记忆窗口查看，未自动核实结果。' : '此运行不能跳转到任务详情，请检查保存的摘要与来源。')}>查看任务详情</button>
        <p>打开任务详情会离开记忆页；未保存的核实内容不会提交。</p>
        {navigationNotice && <p role="status">{navigationNotice}</p>}
        <p className={v2.evidenceText}>{selected.summary || '没有已保存的执行摘要或错误摘录；不能据此推断执行成功。'}</p>
        <p>这是执行记录的摘要，完整日志未在此加载；仍需人工核对实际结果。</p>
        {!selected.artifacts?.length && <p>没有已保存的成果引用。</p>}
        <ul>{(selected.artifacts || []).map((artifact, index) => {
          const reference = artifact.url || artifact.uri || artifact.path || artifact.fileId || '';
          const url = safeWebUrl(artifact.url || artifact.uri);
          return <li key={index}>{artifact.displayName ? `${artifact.displayName}：` : ''}{url ? <a href={url} target="_blank" rel="noopener noreferrer">{reference}</a> : <span>{reference || '成果引用缺失'}</span>}</li>;
        })}</ul>
        {selected.sessionId ? <button type="button" className={styles['memory-action-btn']} disabled={busy || opening} onClick={() => void openSession()}>打开运行来源会话</button> : <p>没有可打开的运行来源会话。</p>}
        {openError && <p role="alert">{openError}</p>}
      </details>
    </div>}
  </div>;
}
