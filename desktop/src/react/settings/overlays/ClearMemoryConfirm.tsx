import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../store';
import { codiaFetch } from '../api';
import { t } from '../helpers';
import { getErrorMessage } from '../shared-types';
import styles from '../Settings.module.css';

export function ClearMemoryConfirm() {
  const { showToast } = useSettingsStore();
  const [visible, setVisible] = useState(false);
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  useEffect(() => {
    const handler = () => {
      if (locked.current) return;
      setAgentId(useSettingsStore.getState().getSettingsAgentId() || '');
      setError(''); setVisible(true);
    };
    window.addEventListener('codia-show-clear-confirm', handler);
    return () => window.removeEventListener('codia-show-clear-confirm', handler);
  }, []);
  const close = () => { if (!locked.current) setVisible(false); };
  const doClear = async () => {
    if (locked.current || !agentId) return;
    locked.current = true; setBusy(true); setError('');
    try {
      const res = await codiaFetch(`/api/memories?agentId=${encodeURIComponent(agentId)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setVisible(false);
      showToast(t('settings.memory.actions.clearSuccess'), 'success');
    } catch (err: unknown) {
      setError('清除未完成或结果未确认，请刷新记忆列表核对后重试。' + getErrorMessage(err));
    } finally { locked.current = false; setBusy(false); }
  };
  if (!visible) return null;
  return <div className={`${styles['memory-confirm-overlay']} ${styles.visible}`} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className={styles['memory-confirm-card']} role="dialog" aria-modal="true" aria-label="清除记忆确认">
      <p className={styles['memory-confirm-text']}>清除助手 {agentId} 的全部事实与派生记忆？</p>
      <p className={styles['memory-governance-meta']}>遗忘标记会阻止旧内容自动重新提取，关联经验将停止使用。原始聊天和独立置顶内容仍保留，备份不会立即物理删除。此操作无法在此页面撤销。</p>
      {error && <p role="alert" className={styles['memory-governance-error']}>{error}</p>}
      {busy && <p role="status">正在清除，请稍候…</p>}
      <div className={styles['memory-confirm-actions']}>
        <button type="button" disabled={busy} className={styles['memory-confirm-cancel']} onClick={close}>{t('settings.memory.actions.cancel')}</button>
        <button type="button" disabled={busy || !agentId} className={styles['memory-confirm-danger']} onClick={() => void doClear()}>{t('settings.memory.actions.confirmClear')}</button>
      </div>
    </div>
  </div>;
}
