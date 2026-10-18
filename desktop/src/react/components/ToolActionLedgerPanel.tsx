import { useState } from 'react';
import { codiaFetch } from '../hooks/use-codia-fetch';
import type { ToolActionInspection } from '../../../../shared/task-console/tool-actions';

const status = { planned: '已记录，执行结果待核实', running: '执行中或已中断，结果待核实', succeeded: '已确认完成', unknown: '结果未知，禁止自动重发' };
export function ToolActionLedgerPanel({ openSession }: { openSession: (path: string) => Promise<void> }) {
  const [actions, setActions] = useState<ToolActionInspection[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [unreadable, setUnreadable] = useState(0);
  const [total, setTotal] = useState(0);
  const refresh = async () => {
    setBusy(true); setError('');
    try {
      const response = await codiaFetch('/api/tool-actions');
      if (!response.ok) throw new Error(`动作记录读取失败 (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data.actions)) throw new Error('动作记录格式无效');
      setActions(data.actions); setUnreadable(data.unreadableCount || 0); setTotal(data.total || 0); setLoaded(true);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  return <section aria-label="工具动作恢复检查"><h3>工具动作恢复检查</h3>
    <p>只读检查。未知写入不会自动重发；已完成动作不会重复执行。外部结果需自行核实，打开原会话不会重试或撤销外部操作。</p>
    <button type="button" disabled={busy} onClick={() => void refresh()}>{busy ? '读取动作记录中…' : loaded ? '刷新工具动作记录' : '检查工具动作记录'}</button>
    {error && <p role="alert">{error}。已有记录可能不是最新状态。</p>}
    {unreadable > 0 && <p role="alert">{unreadable} 条记录无法读取，不能视为已完成或安全重试。</p>}
    {loaded && <p>显示 {actions.length} / {total} 条记录（按最近更新时间，最多 100 条）。</p>}
    {loaded && !actions.length && !unreadable && <p>尚无可检查的工具动作。</p>}
    <ul>{actions.map(action => <li key={action.actionId}>
      <details><summary>{action.toolName} · {status[action.state]} · {action.readOnly ? '只读动作' : '可能写入'}</summary>
        <dl><dt>动作 ID</dt><dd>{action.actionId}</dd><dt>范围引用</dt><dd>{action.scopeRef || '未记录'}</dd><dt>会话引用</dt><dd>{action.sessionRef || '未记录'}</dd><dt>Trace</dt><dd>{action.traceId || '未记录'} / {action.toolTraceId || '未记录'}</dd><dt>审批引用</dt><dd>{action.confirmationId || '无显式确认记录'}</dd><dt>创建 / 更新</dt><dd>{action.createdAt || '未知'} / {action.updatedAt || '未知'}</dd></dl>
        {action.sessionPath ? <button type="button" onClick={() => void openSession(action.sessionPath!).catch(() => setError('原会话打开失败'))}>打开动作原会话</button> : <p>原会话不可用；不会猜测目标或创建替代会话。</p>}
      </details>
    </li>)}</ul>
  </section>;
}
