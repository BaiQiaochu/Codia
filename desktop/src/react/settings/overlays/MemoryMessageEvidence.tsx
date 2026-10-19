import React, { useEffect, useRef, useState } from 'react';
import { memoryPath, memoryRequest } from '../memory-api';
import { getErrorMessage } from '../shared-types';
import styles from '../Settings.module.css';
import v2 from './MemoryGovernanceV2.module.css';
interface MessageEvidence {
  messages: { sessionId: string; messageId: string; role: string; text: string; timestamp: string | null; hashMatches: boolean | null }[];
  missingMessageIds: string[];
  limitations: string[];
}
export function MemoryMessageEvidence({ agentId, memoryId, version, disabled }: { agentId: string; memoryId: number; version: number | string; disabled: boolean }) {
  const [data, setData] = useState<MessageEvidence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    ++generation.current; controller.current?.abort(); setData(null); setError(''); setLoading(false);
    const currentController = controller, currentGeneration = generation;
    return () => { ++currentGeneration.current; currentController.current?.abort(); };
  }, [agentId, memoryId, version]);
  const read = async () => {
    const request = ++generation.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setLoading(true); setData(null); setError('');
    try {
      const body = await memoryRequest<MessageEvidence>(memoryPath(agentId, `/${memoryId}/evidence`), { signal: abort.signal });
      if (request === generation.current) setData(body);
    } catch (error) { if (request === generation.current && !abort.signal.aborted) setError(getErrorMessage(error)); }
    finally { if (request === generation.current) setLoading(false); }
  };
  return <div className={v2.messageEvidence}>
    <button type="button" className={styles['memory-action-btn']} disabled={disabled || loading} onClick={() => void read()}>{data ? '重新读取消息证据' : '读取消息证据'}</button>
    {loading && <p role="status">正在读取精确消息证据…</p>}
    {error && <p role="alert">消息证据读取失败：{error}。可重新读取。</p>}
    {data && <div aria-label={`事实 ${memoryId} 精确消息证据`}>
      <p>以下预览按已记录的消息 ID 读取；打开来源会话仍是会话级跳转。</p>
      {(data.limitations || []).map((limitation, i) => <p key={i} className={styles['memory-governance-meta']}>{limitation}</p>)}
      {(data.missingMessageIds || []).length > 0 && <p role="alert">找不到这些消息，不能将缺失内容视为已验证：{data.missingMessageIds.join('、')}</p>}
      {!(data.messages || []).length && <p>没有可读取的精确消息。来源可能只记录了会话，或消息已不可用。</p>}
      {(data.messages || []).map((message, i) => <section key={`${message.sessionId}:${message.messageId}:${i}`} className={v2.runDetails}>
        <p>会话 {message.sessionId} · 消息 {message.messageId} · {message.role} · {message.timestamp || '时间未记录'}</p>
        {message.hashMatches === false ? <p role="alert">证据校验不匹配：当前消息与保存的来源校验值不同，请重新核对，不能沿用旧结论。</p> : <p>{message.hashMatches === true ? '来源校验值匹配；仍需人工核实含义。' : '未提供可比较的来源校验值。'}</p>}
        <p className={v2.evidenceText}>{message.text || '消息内容为空。'}</p>
      </section>)}
    </div>}
  </div>;
}
