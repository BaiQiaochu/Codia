import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanyDelivery, DeliveryArtifact, ReviewVerdict } from '../../../../shared/task-console/delivery';
import { codiaFetch, codiaUrl } from '../hooks/use-codia-fetch';
import { openFileRefPreview } from '../utils/remote-file-preview';
import { inferKindByExt } from '../utils/file-kind';
import { resolveFileRefUrl } from '../services/resource-url';
import { resolveServerConnection } from '../services/server-connection';
import { useStore } from '../stores';
import type { FileRef } from '../types/file-ref';

type Draft = { verdict: ReviewVerdict | ''; note: string };
function fileRef(artifact: DeliveryArtifact): FileRef {
  return { id: artifact.fileId!, fileId: artifact.fileId!, name: artifact.name || artifact.fileId!, path: '', resource: artifact.resource,
    ext: artifact.ext, kind: inferKindByExt(artifact.ext || ''), status: 'available', source: 'session-registry' };
}
function download(artifact: DeliveryArtifact) {
  if (!artifact.resource?.links.content || artifact.state !== 'available') return null;
  try { return resolveFileRefUrl(fileRef(artifact), { preferLocalFile: false, connection: resolveServerConnection(useStore.getState()), resourceContentUrl: codiaUrl }).url; }
  catch { return null; }
}
export function CompanyDeliveryPanel({ taskId, refreshToken, openSession }: { taskId: string; refreshToken: string | number; openSession: (session: string) => void }) {
  const [data, setData] = useState<CompanyDelivery | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [draftVersion, setDraftVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const currentTask = useRef(taskId); currentTask.current = taskId;
  const serial = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setData(null); setError(''); setNotice(''); setDrafts({}); setDraftVersion(null); setBusy(false); }, [taskId]);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    const request = ++serial.current;
    try {
      const response = await codiaFetch(`/api/task-console/company/${encodeURIComponent(taskId)}/delivery`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || '交付记录读取失败');
      if (mounted.current && currentTask.current === taskId && request === serial.current) { setData(body); setError(''); }
    } catch (err) { if (mounted.current && currentTask.current === taskId && request === serial.current) setError(String(err)); }
  }, [taskId]);
  useEffect(() => { void refresh(); }, [refresh, refreshToken]);
  const change = (criterion: string, patch: Partial<Draft>) => {
    setDraftVersion(version => version || data!.version);
    setDrafts(previous => ({ ...previous, [criterion]: { ...(previous[criterion] || { verdict: '', note: '' }), ...patch } }));
    setNotice('');
  };
  const staleDraft = !!draftVersion && draftVersion !== data?.version;
  const allFilled = !!data?.criteria.length && data.criteria.every(({ criterion }) => drafts[criterion]?.verdict && drafts[criterion].note.trim());
  const unavailableApproval = data?.artifacts.some(a => a.state !== 'available') && Object.values(drafts).some(d => d.verdict === 'pass');
  const save = async () => {
    if (!data || !allFilled || staleDraft || unavailableApproval || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const request = ++serial.current; const target = taskId;
    try {
      const response = await codiaFetch(`/api/task-console/company/${encodeURIComponent(taskId)}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: draftVersion,
          items: data.criteria.map(({ criterion }) => ({ criterion, ...drafts[criterion] })) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || '复核未保存');
      if (mounted.current && currentTask.current === target && request === serial.current) {
        setData(body); setDrafts({}); setDraftVersion(null); setNotice('已记录本版本的逐项人工复核。未更改执行状态或派发后续任务。');
      }
    } catch (err) { if (mounted.current && currentTask.current === target) setError(String(err)); }
    finally { inFlight.current = false; if (mounted.current && currentTask.current === target) setBusy(false); }
  };
  const preview = async (artifact: DeliveryArtifact) => {
    try { await openFileRefPreview(fileRef(artifact), { origin: 'session', ...(artifact.sessionPath ? { sessionPath: artifact.sessionPath } : {}) }); }
    catch (err) { setError(`预览失败：${String(err)}`); }
  };
  return <section aria-label="团队交付验收">
    <h4>团队交付验收</h4><button type="button" disabled={busy} onClick={() => void refresh()}>刷新交付验收</button>
    {error && <p role="alert">{error}。保留现有内容和未保存复核，请刷新重试。</p>}
    {notice && <p role="status">{notice}</p>}
    {!data && !error && <p>正在读取交付与版本…</p>}
    {data && <>
      <p>{data.note}</p>
      <p>人工复核：{data.review.state === 'current' ? '当前版本已复核' : data.review.state === 'stale' ? '旧复核已失效，请重新核对' : '尚未复核'}</p>
      {data.review.reviewedAt && <p>上次复核：{new Date(data.review.reviewedAt).toLocaleString()}</p>}
      {data.dueAt && <p>截止时间：{data.dueAt}</p>}
      <p style={{ overflowWrap: 'anywhere' }}>交付版本：{data.version}</p>
      {staleDraft && <aside><p>草稿基于旧版本，报告或产物已变化。复核草稿仍保留，请先查看新内容。</p><button type="button" onClick={() => setDraftVersion(data.version)}>已核对新版本，保留草稿继续</button></aside>}
      {!data.criteria.length && <p>尚无逐项验收标准，不能记录逐项通过。</p>}
      {data.criteria.map(({ criterion, selfReport }) => {
        const old = data.review.items?.find(item => item.criterion === criterion);
        const linked = data.artifacts.find(a => a.reference === selfReport?.evidence || a.fileId === selfReport?.evidence);
        return <fieldset key={criterion} disabled={busy}>
          <legend>{criterion}</legend>
          <p>执行方自报：{selfReport?.passed === true ? '通过' : selfReport?.passed === false ? '未通过' : '尚未提交'}</p>
          <p>自报依据：{selfReport?.evidence || '未提供'}</p>
          {linked && <a href={`#delivery-${taskId}-${linked.key}`}>定位依据产物</a>}
          {old && <p>{data.review.state === 'stale' ? '旧版本复核' : '已存人工复核'}：{old.verdict === 'pass' ? '通过' : '未通过'} · {old.note}</p>}
          <label>人工结论<select aria-label={`${criterion} 人工结论`} value={drafts[criterion]?.verdict || ''} onChange={e => change(criterion, { verdict: e.target.value as Draft['verdict'] })}><option value="">请选择</option><option value="pass">通过</option><option value="fail">未通过</option></select></label>
          <label>复核依据<textarea aria-label={`${criterion} 复核依据`} maxLength={4000} value={drafts[criterion]?.note || ''} onChange={e => change(criterion, { note: e.target.value })} /></label>
        </fieldset>;
      })}
      {unavailableApproval && <p>部分产物不可读取或版本未知，当前不能记录通过。可先记录未通过与原因。</p>}
      <button type="button" disabled={busy || !allFilled || staleDraft || !!unavailableApproval} onClick={() => void save()}>保存逐项人工复核</button>
      <h5>结构化成果</h5>
      {!data.artifacts.length && <p>未登记产物引用，可在报告中核对文本成果。</p>}
      <ul>{data.artifacts.map(artifact => <li key={artifact.key} id={`delivery-${taskId}-${artifact.key}`}>
        {artifact.state === 'available' && artifact.resource ? <>
          <p>{artifact.name}</p><p style={{ overflowWrap: 'anywhere' }}>内容 SHA-256：{artifact.sha256} · {artifact.size ?? '未知'} bytes</p>
          <button type="button" onClick={() => void preview(artifact)}>预览成果</button>
          {download(artifact) && <a href={download(artifact)!} download={artifact.name}>导出成果</a>}
          {artifact.sessionPath && <button type="button" onClick={() => openSession(artifact.sessionPath!)}>成果原会话</button>}
        </> : <p>{artifact.reason || '产物不可用'}</p>}
      </li>)}</ul>
    </>}
  </section>;
}
