import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { codiaFetch } from '../api';
import { t } from '../helpers';
import { getErrorMessage } from '../shared-types';
import styles from '../Settings.module.css';

interface MemoryItem {
  id: number;
  fact: string;
  tags?: string[];
  time?: string;
  created_at?: string;
  updated_at: string;
  source?: string;
  session_id?: string;
  status: 'active' | 'expired' | 'conflict';
}

export function MemoryViewer() {
  const generation = useRef(0);
  const [visible, setVisible] = useState(false);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<number | null>(null);

  const load = async (aid: string) => {
    const request = ++generation.current;
    setBusy(true); setError(''); setMemories([]); setEditing(null); setDeleting(null);
    try {
      const res = await codiaFetch(`/api/memories?agentId=${encodeURIComponent(aid)}`);
      if (!res.ok) throw new Error(`读取记忆失败 (${res.status})`);
      const body = await res.json() as { memories?: MemoryItem[] };
      if (request === generation.current) setMemories(body.memories || []);
    } catch (err) { if (request === generation.current) setError(getErrorMessage(err)); }
    finally { if (request === generation.current) setBusy(false); }
  };

  useEffect(() => {
    const handler = () => {
      const aid = useSettingsStore.getState().getSettingsAgentId() || "";
      setAgentId(aid); setVisible(true); void load(aid);
    };
    window.addEventListener('codia-view-memories', handler);
    return () => window.removeEventListener('codia-view-memories', handler);
  }, []);

  const mutate = async (memory: MemoryItem, patch?: Partial<MemoryItem>) => {
    const request = generation.current;
    setBusy(true); setError('');
    try {
      const res = await codiaFetch(`/api/memories/${memory.id}?agentId=${encodeURIComponent(agentId)}`, {
        method: patch ? 'PATCH' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        ...(patch ? { body: JSON.stringify({ ...patch, expectedUpdatedAt: memory.updated_at }) } : {}),
      });
      const body = await res.json() as { memory?: MemoryItem; error?: string; current?: MemoryItem };
      if (request !== generation.current) return;
      if (res.status === 409 && body.current) {
        setMemories(items => items.map(item => item.id === memory.id ? body.current! : item));
        throw new Error('这条记忆已被更新。已载入最新版本，请核对后再次保存。');
      }
      if (!res.ok) throw new Error(body.error || `修改失败 (${res.status})`);
      setMemories(items => patch ? items.map(item => item.id === memory.id ? body.memory! : item) : items.filter(item => item.id !== memory.id));
      setEditing(null); setDeleting(null);
    } catch (err) { if (request === generation.current) setError(getErrorMessage(err)); }
    finally { if (request === generation.current) setBusy(false); }
  };

  const openEvidence = async (memory: MemoryItem) => {
    setBusy(true); setError('');
    try {
      const sessionId = memory.source?.startsWith('session:') ? memory.source.slice(8) : null;
      const res = await codiaFetch('/api/sessions');
      if (!res.ok) throw new Error(`读取来源会话失败 (${res.status})`);
      const sessions = await res.json() as { sessionId: string; path: string; agentId: string }[];
      const session = sessions.find(item => item.sessionId === sessionId && item.agentId === agentId);
      if (!session) throw new Error('来源会话已删除或当前不可用；原始来源标识仍保留。');
      const desktop = window as unknown as { codia?: { quickChatOpenSession?: (path: string) => Promise<unknown> } };
      if (!desktop.codia?.quickChatOpenSession) throw new Error('请在桌面主窗口中打开来源会话。');
      const opened = await desktop.codia.quickChatOpenSession(session.path);
      if (opened === false) throw new Error("无法打开来源会话，请稍后再试。");
      setVisible(false);
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setBusy(false); }
  };

  if (!visible) return null;
  return <div className={`${styles['memory-viewer-overlay']} ${styles.visible}`} onClick={e => { if (e.target === e.currentTarget) setVisible(false); }}>
    <div className={styles['memory-viewer']} role="dialog" aria-label={t('settings.memory.actions.viewTitle')}>
      <div className={styles['memory-viewer-header']}>
        <h3 className={styles['memory-viewer-title']}>{t('settings.memory.actions.viewTitle')}</h3>
        <button type="button" aria-label="关闭记忆" onClick={() => setVisible(false)}>×</button>
      </div>
      <div className={styles['memory-viewer-body']}>
        <p>作用范围：助手 {agentId}。频道记忆按频道隔离检索；此处不是项目资料空间。</p>
        <p>纠错和删除作用于事实检索；已有会话摘要与编译记忆需另行检查。</p>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">处理中…</p>}
        {!busy && memories.length === 0 && <p>{t('settings.memory.actions.empty')}</p>}
        {memories.map(memory => <section key={memory.id} className={styles['memory-item']} aria-label={`记忆 ${memory.id}`}>
          {editing === memory.id ? <label>当前版本：{memory.fact}<br />纠正事实<textarea aria-label="纠正事实" value={draft} onChange={e => setDraft(e.target.value)} /></label> : <p>{memory.fact}</p>}
          <p>{(memory.tags || []).join(' · ')}</p>
          <p>更新：{memory.updated_at || memory.created_at || '未知'} · {memory.session_id?.startsWith('channel-') ? `频道 ${memory.session_id.slice(8)}` : `助手 ${agentId}`}</p>
          <p>来源：{memory.source || '未记录'}</p>
          {memory.source?.startsWith('session:') && <button type="button" disabled={busy} onClick={() => void openEvidence(memory)}>打开来源会话</button>}
          {memory.status === 'expired' && <p>已过期，不再用于事实检索。</p>}
          {memory.status === 'conflict' && <p>有冲突，检索时会提示需要用户核对。</p>}
          {editing === memory.id ? <>
            <button type="button" disabled={busy || !draft.trim()} onClick={() => void mutate(memory, { fact: draft, status: 'active' })}>保存纠错</button>
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>取消纠错</button>
          </> : <button type="button" disabled={busy} onClick={() => { setEditing(memory.id); setDraft(memory.fact); }}>纠错</button>}
          <button type="button" disabled={busy} onClick={() => void mutate(memory, { status: memory.status === 'expired' ? 'active' : 'expired' })}>{memory.status === 'expired' ? '恢复有效' : '标记过期'}</button>
          <button type="button" disabled={busy} onClick={() => void mutate(memory, { status: memory.status === 'conflict' ? 'active' : 'conflict' })}>{memory.status === 'conflict' ? '确认无冲突' : '标记冲突'}</button>
          {deleting === memory.id ? <>
            <span>删除后无法恢复此事实。</span>
            <button type="button" disabled={busy} onClick={() => void mutate(memory)}>确认删除</button>
            <button type="button" disabled={busy} onClick={() => setDeleting(null)}>取消删除</button>
          </> : <button type="button" disabled={busy} onClick={() => setDeleting(memory.id)}>删除</button>}
        </section>)}
      </div>
    </div>
  </div>;
}
