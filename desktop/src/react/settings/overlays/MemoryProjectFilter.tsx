import React, { useEffect, useState } from 'react';
import { memoryListPath, memoryRequest, type MemoryProject } from '../memory-api';
import { getErrorMessage } from '../shared-types';
import styles from '../Settings.module.css';
import v2 from './MemoryGovernanceV2.module.css';

/** Search the authoritative project index without loading every historical project. */
export function MemoryProjectFilter({ agentId, value, projects, busy, onChange }: {
  agentId: string; value: string; projects: MemoryProject[]; busy: boolean; onChange: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [matches, setMatches] = useState<MemoryProject[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    let active = true;
    setMatches([]); setTotal(0); setError('');
    if (search.trim().length < 2) { setLoading(false); return () => { active = false; abort.abort(); }; }
    setLoading(true);
    const timer = window.setTimeout(() => {
      memoryRequest<{ projects: MemoryProject[]; total: number }>(memoryListPath(agentId, '/projects', { q: search.trim(), offset, limit: 25 }), { signal: abort.signal }).then(body => {
        if (!active) return;
        setMatches(body.projects || []); setTotal(body.total || 0);
      }).catch(error => { if (active && !abort.signal.aborted) setError(getErrorMessage(error)); }).finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; abort.abort(); window.clearTimeout(timer); };
  }, [agentId, search, offset, retry]);
  const options = search.trim().length >= 2 ? matches : projects;
  const selected = [...projects, ...matches].find(project => project.id === value);
  return <div className={v2.runFields}>
    <label>筛选项目<select aria-label="筛选项目" disabled={busy} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">全部项目与全局</option><option value="__global__">仅此助手全局</option>
      {value && value !== '__global__' && !options.some(project => project.id === value) && <option value={value}>{selected?.label || value} · {value}（已选择）</option>}
      {options.map(project => <option key={project.id} value={project.id}>{project.label} · {project.id}</option>)}
    </select></label>
    <label>查找历史项目<input aria-label="查找历史项目" placeholder="输入至少 2 个字，搜索真实项目 ID" disabled={busy} value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} /></label>
    {loading && <span role="status">正在查找项目…</span>}
    {error && <div role="alert">项目查找失败：{error}<button type="button" className={styles['memory-action-btn']} disabled={busy} onClick={() => setRetry(value => value + 1)}>重试项目查找</button></div>}
    {search.trim().length >= 2 && !loading && !error && <div className={v2.pagination}>
      <span>找到 {total} 个项目</span>
      <button type="button" className={styles['memory-action-btn']} aria-label="项目搜索上一页" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>上一页</button>
      <button type="button" className={styles['memory-action-btn']} aria-label="项目搜索下一页" disabled={busy || offset + 25 >= total} onClick={() => setOffset(offset + 25)}>下一页</button>
    </div>}
  </div>;
}
