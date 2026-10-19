import React, { useCallback, useEffect, useRef, useState } from 'react';
import { codiaFetch } from '../../api';
type Limit = { maxCalls?: number; maxTokens?: number; maxUsd?: number };
type Config = { daily?: Limit; monthly?: Limit; memoryDaily?: Limit };
export interface BudgetReport {
  config: Config; revision: number; statisticsStartedAt: string; note: string;
  daily: Totals; monthly: Totals; memoryDaily: Totals;
  pauses: { scope: string; reason: string; resumeAt: string; agentId: string }[];
}
interface Totals { calls: number; knownTokens: number; knownUsd: number; pendingCalls: number; unknownCostCalls: number; reservedUsd: number; reservedTokens: number; until: string }
export function BudgetTotals({ value }: { value?: Totals }) {
  if (!value) return null;
  return <p>调用 {value.calls} 次 · 已知 {value.knownTokens} token · 已知部分 ${value.knownUsd.toFixed(4)} USD<br />
    未结算（可能进行中或中断）{value.pendingCalls} 次 · 未知费用 {value.unknownCostCalls} 次 · 待确认预留 ${value.reservedUsd.toFixed(4)} / {value.reservedTokens} token</p>;
}
export function BudgetPauses({ report }: { report?: BudgetReport }) {
  return <>{report?.pauses.map(pause => <p role="status" key={`${pause.scope}:${pause.agentId}`}>已暂停：{pause.reason}<br />恢复条件：{new Date(pause.resumeAt).toLocaleString()} 后进入新 UTC 周期，或修正价格/额度后重试。已发出的未知请求仍保留记录。</p>)}</>;
}
const scopes = [['daily', '所有任务每日'], ['monthly', '所有任务每月'], ['memoryDaily', '每位助手的后台记忆每日']] as const;
const keys = [['maxCalls', '调用次数'], ['maxTokens', 'Token（含并发预留）'], ['maxUsd', 'USD（配置估算）']] as const;
export function BudgetLimitsEditor({ config, onChange, onlyMemory = false, disabled = false }: { config: Config; onChange: (config: Config) => void; onlyMemory?: boolean; disabled?: boolean }) {
  return <>{scopes.filter(([scope]) => !onlyMemory || scope === 'memoryDaily').map(([scope, label]) => <fieldset key={scope} disabled={disabled}>
    <legend>{label}</legend>
    {keys.map(([key, name]) => <label key={key} style={{ display: 'block', margin: '8px 0' }}>{name}{' '}
      <input aria-label={`${label} ${name}`} type="number" min="0" step={key === 'maxUsd' ? 'any' : '1'} placeholder="不限制" value={config[scope]?.[key] ?? ''}
        onChange={event => { const value = event.target.value; const limit = { ...config[scope] }; if (value === '') delete limit[key]; else limit[key] = Number(value); onChange({ ...config, [scope]: limit }); }} />
    </label>)}
  </fieldset>)}</>;
}
export async function fetchBudgetReport(): Promise<BudgetReport> {
  const response = await codiaFetch('/api/usage/budget'); const body = await response.json();
  if (!response.ok) throw new Error(body.error || '预算读取失败'); return body;
}
export async function saveBudgetConfig(config: Config, expectedRevision: number): Promise<BudgetReport> {
  const response = await codiaFetch('/api/usage/budget', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config, expectedRevision }) });
  const body = await response.json(); if (!response.ok) throw new Error(body.error || '预算保存失败'); return body;
}
export function UsageBudgetSettings() {
  const [report, setReport] = useState<BudgetReport>(); const [config, setConfig] = useState<Config>({});
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++generation.current; setBusy(true); setError('');
    try { const value = await fetchBudgetReport(); if (id === generation.current) { setReport(value); setConfig(value.config); } }
    catch (err) { if (id === generation.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (id === generation.current) setBusy(false); }
  }, []);
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, [refresh]);
  const save = async () => {
    if (busy || !report) return; setBusy(true); setError(''); setSaved(false); const id = generation.current;
    try { const value = await saveBudgetConfig(config, report.revision); if (id === generation.current) { setReport(value); setSaved(true); } }
    catch (err) { if (id === generation.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (id === generation.current) setBusy(false); }
  };
  return <details><summary>持久用量预算与后台额度</summary>
    <p>留空保持不限制；0 会暂停对应调用。启用金额额度后，缺失价格或历史用量将暂停新调用。额度按 UTC 统计，重启不会清零。此处为本地准入控制，不是供应商账单硬上限。</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>刷新预算状态</button>
    {error && <p role="alert">{error}</p>}{saved && <p role="status">预算已保存，后续调用使用新额度。</p>}
    {report && <><BudgetTotals value={report.daily} /><BudgetPauses report={report} /><BudgetLimitsEditor config={config} disabled={busy} onChange={value => { setSaved(false); setConfig(value); }} />
      <button type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存预算'}</button></>}
  </details>;
}
