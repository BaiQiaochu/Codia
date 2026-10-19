import React, { useCallback, useEffect, useRef, useState } from 'react';
import { codiaFetch } from '../api';
import { BudgetLimitsEditor, BudgetPauses, BudgetTotals, saveBudgetConfig, type BudgetReport } from '../tabs/providers/UsageBudgetSettings';
type Policy = { completedExtractionDays: number | null; ordinaryEventDays: number | null };
interface Report { policy: Policy; revision: string; budget: BudgetReport; memoryEnabled?: boolean; experienceEnabled?: boolean; report: { note: string; ordinaryEvents: number; archivedEventReceipts: number; compactedExtractions?: number; archivedEvents?: number } }
export function MemoryBudgetSettings({ agentId, disabled = false, onAcquireMutation, onReleaseMutation }: { agentId: string; disabled?: boolean; onAcquireMutation?: () => boolean; onReleaseMutation?: () => void }) {
  const [data, setData] = useState<Report>(); const [policy, setPolicy] = useState<Policy>({ completedExtractionDays: null, ordinaryEventDays: null });
  const [config, setConfig] = useState<BudgetReport['config']>({}); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [confirmCleanup, setConfirmCleanup] = useState(false); const generation = useRef(0);
  const url = `/api/memories/maintenance?agentId=${encodeURIComponent(agentId)}`;
  const load = useCallback(async () => {
    const id = ++generation.current; setBusy(true); setError('');
    try { const response = await codiaFetch(url); const body = await response.json(); if (!response.ok) throw new Error(body.error || '维护状态读取失败'); if (id !== generation.current) return; setData(body); setPolicy(body.policy); setConfig(body.budget.config); }
    catch (err) { if (id === generation.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (id === generation.current) setBusy(false); }
  }, [url]);
  useEffect(() => { setData(undefined); setNotice(''); setConfirmCleanup(false); void load(); return () => { generation.current++; }; }, [load]);
  async function action(kind: 'budget' | 'policy' | 'cleanup') {
    if (busy || disabled || !data || (onAcquireMutation && !onAcquireMutation())) return; const id = generation.current; setBusy(true); setError(''); setNotice('');
    try {
      if (kind === 'budget') {
        const report = await saveBudgetConfig({ ...data.budget.config, memoryDaily: config.memoryDaily || {} }, data.budget.revision);
        if (id === generation.current) { setData({ ...data, budget: { ...report, memoryDaily: data.budget.memoryDaily } }); setNotice('后台额度已保存。'); }
      } else {
        const response = await codiaFetch(url, { method: kind === 'policy' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(kind === 'policy' ? { policy, expectedRevision: data.revision } : { confirmed: true, expectedRevision: data.revision }) });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || '维护操作失败');
        if (id === generation.current) { setData(body); setConfirmCleanup(false); setNotice(kind === 'policy' ? '保留策略已保存，将在后台维护时应用。' : `已压缩 ${body.report.compactedExtractions || 0} 条成功提取，归档 ${body.report.archivedEvents || 0} 条普通事件。`); }
      }
    } catch (err) { if (id === generation.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { onReleaseMutation?.(); if (id === generation.current) setBusy(false); }
  }
  return <details><summary>后台记忆额度与历史保留</summary>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!data && !error && <p>正在读取…</p>}
    {data && <>
      {(data.memoryEnabled === false || data.experienceEnabled === false) && <p>总记忆或经验学习开关尚未开启。重新排队不会自动开启学习。</p>}
      <BudgetTotals value={data.budget.memoryDaily} /><BudgetPauses report={data.budget} />
      <p>以下额度对每位助手分别按 UTC 日统计，重启保留；留空不限制，0 暂停。价格或用量未知时金额额度会暂停调用。未执行任务留在队列，不记为失败。</p>
      <BudgetLimitsEditor config={config} onChange={setConfig} onlyMemory disabled={busy || disabled} />
      <button type="button" disabled={busy || disabled} onClick={() => void action('budget')}>保存后台额度</button>
      <p>{data.report.note}</p>
      {([['completedExtractionDays', '成功提取明细保留天数'], ['ordinaryEventDays', '普通检索/注入事件保留天数']] as const).map(([key, label]) => <label key={key} style={{ display: 'block', margin: '8px 0' }}>{label}{' '}<input type="number" min="1" max="36500" placeholder="不自动归档" disabled={busy || disabled} value={policy[key] ?? ''} onChange={event => setPolicy({ ...policy, [key]: event.target.value === '' ? null : Number(event.target.value) })} /></label>)}
      <p>当前普通事件 {data.report.ordinaryEvents} 条 · 已归档幂等收据 {data.report.archivedEventReceipts} 条</p>
      <button type="button" disabled={busy || disabled} onClick={() => void action('policy')}>保存保留策略</button>{' '}
      <button type="button" disabled={busy || disabled} onClick={() => setConfirmCleanup(true)}>按已保存策略整理</button>{' '}
      <button type="button" disabled={busy || disabled} onClick={() => void load()}>刷新状态</button>
      {confirmCleanup && <div role="alert"><p>整理将压缩过期的成功提取明细，归档普通事件。成功收据、失败/未知、人工证据及撤回记录保留。确认执行？</p><button type="button" disabled={busy || disabled} onClick={() => void action('cleanup')}>确认整理</button><button type="button" disabled={busy || disabled} onClick={() => setConfirmCleanup(false)}>取消</button></div>}
    </>}
  </details>;
}
