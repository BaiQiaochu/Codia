import { useEffect, useRef, useState } from 'react';
import { CloudApiError, isActiveCloudRun, type CloudHealth, type CloudRun, type CloudWorkspaceClient } from './cloud-workspace-api';

export type CloudRecordKind = 'conversation' | 'workflow' | 'business';
export interface CloudRecord {
  id: string; kind: CloudRecordKind; title: string; currentVersion: string;
  data?: Record<string, unknown>; createdAt: string; updatedAt: string;
  activeRun?: CloudRun | null;
  pendingRuns?: CloudRun[];
}
interface RecordResult { record: CloudRecord; run?: CloudRun | null }
function recordRun(result: RecordResult): CloudRun | null {
  return result.run || result.record.activeRun
    || result.record.pendingRuns?.find(item => isActiveCloudRun(item.status))
    || result.record.pendingRuns?.filter(item => item.status === 'failed').at(-1) || null;
}
interface ConversationMessage { id: string; role: string; text: string; createdAt?: string }
const labels: Record<CloudRecordKind, string> = { conversation: '对话记录', workflow: '工作流记录', business: '业务记录' };
const templates: Record<CloudRecordKind, Record<string, unknown>> = {
  conversation: { messages: [] }, workflow: { instruction: '', steps: [] }, business: { status: 'draft', fields: {} },
};
type Navigation = { kind: CloudRecordKind } | { id: string } | { create: true };
const formatData = (value: unknown) => JSON.stringify(value || {}, null, 2);
function objectData(text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('请输入有效的 JSON 对象，内容不会在校验失败时提交。');
  return data as Record<string, unknown>;
}
function messagesOf(record: CloudRecord | null): ConversationMessage[] {
  const messages = record?.data?.messages;
  return Array.isArray(messages) ? messages.filter((item): item is ConversationMessage => !!item && typeof item === 'object' && typeof item.text === 'string') : [];
}

export function CloudRecords({ workspaceId, client, health, onConfigureAI, onDirtyChange }: {
  workspaceId: string; client: CloudWorkspaceClient; health?: CloudHealth | null;
  onConfigureAI?: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [kind, setKind] = useState<CloudRecordKind>('conversation');
  const [records, setRecords] = useState<CloudRecord[]>([]);
  const [selected, setSelected] = useState<CloudRecord | null>(null);
  const [title, setTitle] = useState('');
  const [data, setData] = useState(() => formatData(templates.conversation));
  const [message, setMessage] = useState('');
  const [run, setRun] = useState<CloudRun | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState<Navigation | null>(null);
  const [reload, setReload] = useState(0);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const detailController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const requestRef = useRef<{ id: string; version: string; text: string; key: string } | null>(null);
  const selectedId = selected?.id;
  const running = !!run && isActiveCloudRun(run.status);
  const aiAvailable = health?.executor === 'codia-agent' && health.executorAvailable === true;

  useEffect(() => { alive.current = true; return () => { alive.current = false; detailController.current?.abort(); }; }, []);
  useEffect(() => { dirtyRef.current = dirty; onDirtyChange?.(dirty || !!message.trim()); return () => onDirtyChange?.(false); }, [dirty, message, onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    const readRevision = revision.current;
    setLoading(true);
    client.json<{ records: CloudRecord[] }>(`/workspaces/${encodeURIComponent(workspaceId)}/records?kind=${kind}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted && revision.current === readRevision) setRecords(result.records); })
      .catch(err => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '无法读取记录'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, kind, client, reload]);

  // Resume an existing durable run on reopening a conversation; the server projects its reply.
  useEffect(() => {
    if (!selectedId || !running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await client.json<RecordResult>(`/records/${encodeURIComponent(selectedId)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSelected(result.record); setRun(recordRun(result));
        if (!dirtyRef.current) { setTitle(result.record.title); setData(formatData(result.record.data)); }
        timer = setTimeout(() => void refresh(), 1000);
      } catch (err) {
        if (!controller.signal.aborted) { setError(err instanceof Error ? err.message : '无法读取对话进度'); timer = setTimeout(() => void refresh(), 5000); }
      }
    };
    timer = setTimeout(() => void refresh(), 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [selectedId, running, client]);

  function resetEditor(nextKind: CloudRecordKind) {
    setSelected(null); setTitle(''); setData(formatData(templates[nextKind])); setDirty(false); setMessage(''); setRun(null); setError(''); setNotice(''); setConflict(false); requestRef.current = null;
  }
  async function navigate(target: Navigation) {
    if (busyRef.current) return;
    detailController.current?.abort(); setPending(null);
    if ('kind' in target) { setKind(target.kind); setRecords([]); resetEditor(target.kind); return; }
    if ('create' in target) { resetEditor(kind); return; }
    const controller = new AbortController(); detailController.current = controller;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.json<RecordResult>(`/records/${encodeURIComponent(target.id)}`, { signal: controller.signal });
      if (controller.signal.aborted || !alive.current) return;
      setSelected(result.record); setTitle(result.record.title); setData(formatData(result.record.data)); setDirty(false); setConflict(false); setMessage(''); setRun(recordRun(result)); requestRef.current = null;
    } catch (err) { if (!controller.signal.aborted && alive.current) setError(err instanceof Error ? err.message : '无法读取记录'); }
    finally { if (alive.current) { busyRef.current = false; setBusy(false); } }
  }
  function requestNavigation(target: Navigation) { if (dirty || message.trim()) setPending(target); else void navigate(target); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current || running || !title.trim()) return;
    let parsed: Record<string, unknown>;
    try { parsed = objectData(data); }
    catch { setError('请输入有效的 JSON 对象，内容不会在校验失败时提交。'); return; }
    const controller = new AbortController(); detailController.current = controller;
    busyRef.current = true; revision.current += 1; setBusy(true); setError(''); setNotice('');
    try {
      const result = await client.json<RecordResult>(selected ? `/records/${encodeURIComponent(selected.id)}` : `/workspaces/${encodeURIComponent(workspaceId)}/records`, {
        method: selected ? 'PUT' : 'POST', signal: controller.signal,
        body: JSON.stringify(selected ? { title: title.trim(), data: parsed, expectedVersion: selected.currentVersion } : { kind, title: title.trim(), data: parsed }),
      });
      if (!alive.current || controller.signal.aborted) return;
      setSelected(result.record); setTitle(result.record.title); setData(formatData(result.record.data || parsed)); setDirty(false); setConflict(false); setRun(recordRun(result));
      setRecords(current => [result.record, ...current.filter(item => item.id !== result.record.id)]);
      setNotice(selected ? '新版本已保存。' : '云端记录已创建。');
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : '保存未完成，请重试。'); setConflict(err instanceof CloudApiError && err.status === 409);
    } finally { if (alive.current) { busyRef.current = false; setBusy(false); } }
  }
  async function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!selected || !text || !aiAvailable || busyRef.current || running || dirty) return;
    const controller = new AbortController(); detailController.current = controller;
    busyRef.current = true; revision.current += 1; setBusy(true); setError(''); setNotice('');
    if (!requestRef.current || requestRef.current.id !== selected.id || requestRef.current.version !== selected.currentVersion || requestRef.current.text !== text) {
      requestRef.current = { id: selected.id, version: selected.currentVersion, text, key: crypto.randomUUID() };
    }
    try {
      const result = await client.json<RecordResult>(`/records/${encodeURIComponent(selected.id)}/messages`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ text, expectedVersion: selected.currentVersion, requestKey: requestRef.current.key }),
      });
      if (!alive.current || controller.signal.aborted) return;
      setSelected(result.record); setData(formatData(result.record.data)); setRun(recordRun(result)); setMessage(''); setConflict(false); requestRef.current = null;
      setNotice('消息已保存，AI 回复会自动显示。');
    } catch (err) {
      if (!alive.current || controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : '消息未发送，请重试。'); setConflict(err instanceof CloudApiError && err.status === 409);
    } finally { if (alive.current) { busyRef.current = false; setBusy(false); } }
  }
  const messages = messagesOf(selected);
  const workflowData = kind === 'workflow' ? objectData(data) : null;

  return <section className="cw-records cw-card" aria-labelledby="cw-records-title">
    <div className="cw-card-heading"><div><h2 id="cw-records-title">云端对话与业务</h2></div><button type="button" className="cw-record-action" onClick={() => setReload(value => value + 1)} disabled={busy || loading}>刷新列表</button></div>
    <p className="cw-record-description">云端对话可直接与已配置的 AI 交流，消息与结果持久保存。工作流和业务记录独立保存；本地历史聊天仍从聊天入口打开。</p>
    <div className="cw-record-layout">
      <aside aria-label="云端记录列表"><label htmlFor="cloud-record-kind">记录类型</label><select id="cloud-record-kind" className="cw-select" value={kind} disabled={busy} onChange={event => requestNavigation({ kind: event.target.value as CloudRecordKind })}>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <button type="button" className="cw-button cw-button-ghost cw-full-width" onClick={() => requestNavigation({ create: true })} disabled={busy}>新建{labels[kind]}</button>
        <div className="cw-record-list">{loading ? <p role="status">正在读取记录…</p> : !records.length ? <p>还没有{labels[kind]}</p> : records.map(record => <button type="button" className={`cw-file-row${selected?.id === record.id ? ' cw-selected' : ''}`} key={record.id} aria-pressed={selected?.id === record.id} onClick={() => requestNavigation({ id: record.id })} disabled={busy}><span><strong>{record.title}</strong><small>{record.currentVersion.slice(0, 12)}</small></span></button>)}</div>
      </aside>
      <div className="cw-record-editor">
        {pending && <div className="cw-alert" role="alertdialog" aria-label="未保存更改"><span>放弃未保存的更改并继续？</span><button type="button" className="cw-record-action" onClick={() => void navigate(pending)}>放弃更改</button><button type="button" className="cw-record-action" onClick={() => setPending(null)}>返回编辑</button></div>}
        {error && <p className="cw-run-error" role="alert">{error}</p>}
        {notice && <p className="cw-record-success" role="status">{notice}</p>}
        <form onSubmit={save}>
          <label htmlFor="cloud-record-title">标题</label><input id="cloud-record-title" maxLength={80} value={title} disabled={busy || running} onChange={event => { setTitle(event.target.value); setDirty(true); }} placeholder={`给${labels[kind]}起个名字`} />
          {kind === 'workflow' && <><label htmlFor="cloud-workflow-instruction">工作流指令</label><textarea id="cloud-workflow-instruction" value={typeof workflowData?.instruction === 'string' ? workflowData.instruction : ''} disabled={busy || running} placeholder="描述这项工作流的目标和处理步骤" onChange={event => { setData(formatData({ ...workflowData, instruction: event.target.value, steps: workflowData?.steps || [] })); setDirty(true); }} /><p className="cw-helper">保存可复用的工作流定义；保存本身不会执行任务。</p></>}
          {kind === 'business' && <><label htmlFor="cloud-record-data">内容（JSON 对象）</label><textarea id="cloud-record-data" spellCheck={false} value={data} disabled={busy || running} onChange={event => { setData(event.target.value); setDirty(true); }} /></>}
          <div className="cw-record-footer"><span>{selected ? `版本 ${selected.currentVersion.slice(0, 12)}` : '尚未保存'}{dirty && ' · 有未保存更改'}</span><button type="submit" className="cw-button cw-button-primary" disabled={busy || running || !title.trim() || (!!selected && !dirty)}>{busy ? '正在处理…' : selected ? '保存新版本' : '创建记录'}</button></div>
        </form>
        {conflict && selected && <button type="button" className="cw-record-action" onClick={() => requestNavigation({ id: selected.id })}>重新读取云端版本</button>}
        {kind === 'conversation' && <section className="cw-conversation" aria-label="云端对话">
          <div className="cw-conversation-messages" role="log" aria-live="polite">{messages.map((item, index) => <div className={`cw-conversation-message cw-message-${item.role === 'user' ? 'user' : 'assistant'}`} key={item.id || index}><strong>{item.role === 'user' ? '你' : 'Codia'}</strong><p>{item.text}</p></div>)}{!messages.length && <p className="cw-empty-small">{selected ? '开始一段云端对话，刷新后仍可继续。' : '先创建对话，再发送第一条消息。'}</p>}{running && <p className="cw-record-success" role="status">AI 正在回复…离开后任务仍会继续。</p>}{run?.status === 'failed' && <p className="cw-run-error" role="alert">有一条 AI 回复未完成：{run.error || '请检查模型配置后重试。'}</p>}</div>
          {!aiAvailable && <div className="cw-ai-unavailable">尚未配置可用的 AI。对话可先保存，配置模型并刷新后即可发消息。{onConfigureAI && <button type="button" className="cw-record-action" onClick={onConfigureAI}>配置 AI</button>}</div>}
          <form onSubmit={sendMessage}><label htmlFor="cloud-conversation-message">消息</label><textarea id="cloud-conversation-message" value={message} maxLength={8000} disabled={busy || running || !selected || !aiAvailable} onChange={event => setMessage(event.target.value)} placeholder="向 Codia 提问…" /><div className="cw-record-footer"><span>{dirty ? '请先保存标题更改' : '消息将发送给已配置的模型服务商'}</span><button type="submit" className="cw-button cw-button-primary" disabled={!selected || !aiAvailable || busy || running || dirty || !message.trim()}>发送消息</button></div></form>
        </section>}
      </div>
    </div>
  </section>;
}
