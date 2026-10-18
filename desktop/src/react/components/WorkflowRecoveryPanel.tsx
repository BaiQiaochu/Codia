import { useEffect, useState } from 'react';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { requestInputDraft } from '../utils/input-draft-events';
import { switchSession } from '../stores/session-actions';

type Recovery = { canPrepare: boolean; blockedReason: string | null; sessionPath: string | null; actions: { nodeSeq: number; actionId: string; access: string; status: string }[] };
export function WorkflowRecoveryPanel({ runId, onPrepared }: { runId: string; onPrepared: () => void }) {
  const [data, setData] = useState<Recovery | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  useEffect(() => {
    let stale = false;
    setData(null); setError(''); setCancelConfirm(false);
    void codiaFetch(`/api/workflow-recovery/${encodeURIComponent(runId)}`).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '恢复记录不可用');
      if (!stale && Array.isArray(body.actions)) setData(body);
    }).catch(err => { if (!stale) setError(String(err)); });
    return () => { stale = true; };
  }, [runId]);
  const action = async (kind: 'draft' | 'cancel') => {
    setBusy(true); setError('');
    try {
      const response = await codiaFetch(`/api/workflow-recovery/${encodeURIComponent(runId)}/${kind}`, { method: 'POST' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '操作未完成');
      if (kind === 'draft') {
        if (!body.sessionPath) throw new Error('原会话不可用，未填入恢复草稿');
        await switchSession(body.sessionPath);
        requestInputDraft({ text: body.draft, mode: 'append', source: `workflow-recovery:${runId}` });
        onPrepared();
      } else { setData(old => old && { ...old, canPrepare: false, blockedReason: body.note }); setCancelConfirm(false); }
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  };
  return <section aria-label="脚本运行恢复"><h4>恢复检查点</h4>
    {error && <p role="status">{error}</p>}
    {data && <><p>{data.canPrepare ? '可准备原版本恢复草稿，审核后在原会话发送。' : data.blockedReason}</p>
      <ul>{data.actions.map(a => <li key={a.actionId}>步骤 {a.nodeSeq} · {a.access === 'read' ? '只读' : '可能写入'} · {a.status === 'unknown' || a.status === 'running' ? '结果未确认，先检查外部结果' : a.status} · {a.actionId}</li>)}</ul>
      <p>检查文件内容、目标服务的发送/上传记录与原会话。结果未知的写入不会自动重试，不能保证外部服务 exactly-once。</p>
      {data.sessionPath && <button type="button" onClick={() => void switchSession(data.sessionPath!).then(onPrepared).catch(err => setError(String(err)))}>打开原会话检查结果</button>}
      <button type="button" disabled={busy || !data.canPrepare} onClick={() => void action('draft')}>准备恢复草稿</button>
      {!cancelConfirm ? <button type="button" disabled={busy} onClick={() => setCancelConfirm(true)}>放弃此检查点恢复</button> : <><p>仅禁止此检查点后续恢复，不会撤销外部操作。</p><button type="button" disabled={busy} onClick={() => void action('cancel')}>确认放弃恢复</button><button type="button" onClick={() => setCancelConfirm(false)}>保留恢复</button></>}
    </>}
  </section>;
}
