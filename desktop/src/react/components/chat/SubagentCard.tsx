/**
  *
 * 订阅 streamKey 上的实时事件，互斥显示当前状态：
  * */

import { memo, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { subscribeStreamKey } from '../../services/stream-key-dispatcher';
import { gsapFetch, gsapUrl } from '../../hooks/use-gsap-fetch';
import { useStore } from '../../stores';
import { yuanFallbackAvatar } from '../../utils/agent-helpers';
import { SubagentSessionPreview } from './SubagentSessionPreview';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */
const SUBAGENT_PREVIEW_CLOSE_MS = 200;

interface SubagentCardProps {
  block: {
    taskId: string;
    task: string;
    taskTitle: string;
    agentId?: string;
    agentName?: string;
    requestedAgentId?: string;
    requestedAgentName?: string;
    executorAgentId?: string;
    executorAgentNameSnapshot?: string;
    streamKey: string;
    streamStatus: 'running' | 'done' | 'failed' | 'aborted';
    summary?: string;
    label?: string | null;
    reuseInstance?: string | null;
  };
}

export const SubagentCard = memo(function SubagentCard({ block }: SubagentCardProps) {
  const [status, setStatus] = useState(block.streamStatus);
  const [, setDisplay] = useState<string>(() => {
    if (block.streamStatus === 'done') return block.summary || '已完成';
    if (block.streamStatus === 'failed') return block.summary || '失败';
    if (block.streamStatus === 'aborted') return block.summary || '已终止';
    return '\u51c6\u5907\u4e2d...';
  });
  const textRef = useRef('');

 // 头像：优先用 agent 头像 API，fallback -yuan 剪影头像
  const currentAgentId = useStore(s => s.currentAgentId);
  const agents = useStore(s => s.agents);
  const previewEntry = useStore(s => s.subagentPreviewByTaskId[block.taskId]);
  const agentId = block.agentId || block.executorAgentId || currentAgentId || '';
  const previewAgentId = block.agentId || block.executorAgentId || currentAgentId || null;
  const agentName = block.agentName || block.executorAgentNameSnapshot || block.agentId || 'Subagent';
  const isOpen = previewEntry?.open ?? false;
  const previewSessionPath = previewEntry?.sessionPath ?? (block.streamKey || null);
  const [shouldRenderPreview, setShouldRenderPreview] = useState(isOpen);
  const [isClosingPreview, setIsClosingPreview] = useState(false);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);

  const agent = agents?.find((a: any) => a.id === agentId);
  const fallbackAvatar = useMemo(() => yuanFallbackAvatar(agent?.yuan), [agent?.yuan]);
  const avatarSrc = (agent?.hasAvatar && agentId)
    ? gsapUrl(`/api/agents/${agentId}/avatar?t=${agentId}`, { includeTokenQuery: true })
    : fallbackAvatar;

  // Sync block prop changes (from block_update patch)
  useEffect(() => {
    setStatus(block.streamStatus);
    if (block.streamStatus === 'done') setDisplay(block.summary || '已完成');
    if (block.streamStatus === 'failed') setDisplay(block.summary || '失败');
    if (block.streamStatus === 'aborted') setDisplay(block.summary || '已终止');
  }, [block.streamStatus, block.summary]);

  useEffect(() => {
    useStore.getState().setSubagentPreviewSessionPath(block.taskId, block.streamKey || null);
  }, [block.taskId, block.streamKey]);

  useEffect(() => {
    if (isOpen) {
      setShouldRenderPreview(true);
      setIsClosingPreview(false);
      return;
    }
    if (!shouldRenderPreview) return;

    setIsClosingPreview(true);
    const timer = window.setTimeout(() => {
      setShouldRenderPreview(false);
      setIsClosingPreview(false);
    }, SUBAGENT_PREVIEW_CLOSE_MS);

    return () => window.clearTimeout(timer);
  }, [isOpen, shouldRenderPreview]);

  // Subscribe to live events
  useEffect(() => {
    if (status !== 'running' || !block.streamKey) return;

    const unsub = subscribeStreamKey(block.streamKey, (event: any) => {
      if (event.type === 'text_delta') {
        textRef.current += event.delta || '';
        if (textRef.current.length > 100) textRef.current = textRef.current.slice(-100);
        setDisplay(textRef.current);
      } else if (event.type === 'thinking_start') {
        setDisplay('正在思考...');
      } else if (event.type === 'thinking_end') {
        if (textRef.current) setDisplay(textRef.current);
      } else if (event.type === 'tool_start') {
        setDisplay(`正在调用 ${event.name}...`);
      } else if (event.type === 'tool_end') {
        if (textRef.current) setDisplay(textRef.current);
        else setDisplay('执行中...');
      } else if (event.type === 'turn_end') {
        setStatus('done');
        setDisplay(textRef.current || '已完成');
      }
    });

    return unsub;
  }, [block.streamKey, status]);

  // Delay marking a restored running subagent as interrupted until updates settle.
  const [waitedForKey, setWaitedForKey] = useState(false);
  useEffect(() => {
    if (block.streamKey || status !== 'running') return;
    const timer = setTimeout(() => setWaitedForKey(true), 3000);
    return () => clearTimeout(timer);
  }, [block.streamKey, status]);

  const isInterrupted = status === 'running' && !block.streamKey && waitedForKey;

  const handleAbort = useCallback(async () => {
    try {
      const res = await gsapFetch(`/api/task/${block.taskId}/abort`, { method: 'POST' });
      if (res.ok) {
        setStatus('aborted');
        setDisplay(window.t?.('subagentAborted') || '已终止');
      }
    } catch { /* user-initiated abort; silent on network failure */ }
  }, [block.taskId]);

  const handleToggle = useCallback(() => {
    if (isOpen) {
      useStore.getState().closeSubagentPreview(block.taskId);
      return;
    }
    useStore.getState().openSubagentPreview(block.taskId, block.streamKey || null);
  }, [block.taskId, block.streamKey, isOpen]);

  const headerDisplay = block.taskTitle;
  const displayLabel = block.label || block.reuseInstance || null;

  return (
    <div className={`${styles.subagentCard} ${styles[`subagent-${status}`]}`}>
      <div className={styles.subagentCardHeader}>
        <button
          type="button"
          className={styles.subagentCardButton}
          aria-expanded={isOpen}
          onClick={handleToggle}
        >
          <img
            className={styles.subagentAvatar}
            src={avatarSrc}
            alt={agentName}
            draggable={false}
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              if (img.src.endsWith(fallbackAvatar)) {
                img.onerror = null;
                return;
              }
              img.onerror = null;
              img.src = fallbackAvatar;
            }}
          />
          <div className={styles.subagentBody}>
            <div className={styles.subagentName}>
              {agentName}
              {displayLabel ? <span className={styles.subagentInstance}>· {displayLabel}</span> : null}
              <span className={styles.subagentStatus}>
                {isInterrupted ? '已中断' : status === 'aborted' ? '已终止' : status === 'done' ? '已完成' : status === 'failed' ? '失败' : '已派出'}
              </span>
            </div>
            <div className={styles.subagentDisplay}>
              {headerDisplay}
            </div>
          </div>
        </button>
        {status === 'running' && !isInterrupted && (
          <button type="button" className={styles.subagentAbortBtn} onClick={handleAbort} title={window.t?.('subagentAbort') || '终止'}>
            ×
          </button>
        )}
      </div>
      <div
        className={`${styles.subagentPreviewWrap}${isOpen ? ` ${styles.subagentPreviewWrapOpen}` : ''}${isClosingPreview ? ` ${styles.subagentPreviewWrapClosing}` : ''}`}
        aria-hidden={!isOpen}
      >
        <div ref={previewScrollRef} className={styles.subagentPreviewScroll}>
          {shouldRenderPreview ? (
            <SubagentSessionPreview
              taskId={block.taskId}
              sessionPath={previewSessionPath}
              agentId={previewAgentId}
              streamStatus={status}
              summary={block.summary}
              scrollContainerRef={previewScrollRef}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});
