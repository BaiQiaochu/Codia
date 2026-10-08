import type { AgentReviewState } from '../../../../../shared/quick-actions';
import { useState } from 'react';
import { loadSessions, switchSession } from '../../stores/session-actions';
import { useStore } from '../../stores';
import styles from './AgentReviewCard.module.css';

export function AgentReviewCard({ review, sourceSessionId }: { review?: AgentReviewState; sourceSessionId?: string }) {
  const [error, setError] = useState('');
  const target = review?.reviewerSessionId || sourceSessionId;
  const open = async () => {
    try {
      await loadSessions();
      const session = useStore.getState().sessions.find(s => s.sessionId === target);
      if (!session) throw new Error('该对话已删除或暂时不可用。');
      await switchSession({ path: session.path, sessionId: target });
      const current = useStore.getState();
      if (current.currentSessionPath !== session.path && !current.sessions.some(s => s.sessionId === target && s.path === current.currentSessionPath)) {
        throw new Error('暂时无法打开该对话，请稍后重试。');
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const statuses = { running: '正在独立审阅', continuing: '审阅完成，当前助手继续处理', completed: '协作完成', failed: '审阅失败', cancelled: '已取消' };
  return <section className={styles.card} aria-label="助手审阅" aria-live="polite">
    <strong>{review ? `${review.reviewerAgentName} · ${statuses[review.status]}` : '受邀审阅任务'}</strong>
    {review?.result && <details><summary>查看审阅意见</summary><div className={styles.result}>{review.result}</div></details>}
    {review?.error && <p role="alert">{review.error}</p>}
    {target && <button type="button" onClick={() => void open()}>{sourceSessionId ? '返回原对话' : '打开审阅对话'}</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
