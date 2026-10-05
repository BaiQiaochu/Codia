import { memo } from 'react';
import type { SettingsUpdatePayload } from '../../stores/chat-types';
import styles from './Chat.module.css';

interface Props {
  update: SettingsUpdatePayload;
}

function statusLabel(status: string): string {
  if (status === 'applied') return '已应用';
  if (status === 'failed') return '失败';
  if (status === 'pending') return '待处理';
  return status || '已更新';
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '空';
  if (typeof value === 'string') return value;
  return String(value);
}

export const SettingsUpdateCard = memo(function SettingsUpdateCard({ update }: Props) {
  const changes = Array.isArray(update.changes) ? update.changes : [];
  const statusClass = update.status === 'failed'
    ? styles.settingsUpdateCardFailed
    : styles.settingsUpdateCardApplied;

  return (
    <div className={`${styles.settingsUpdateCard} ${statusClass}`}>
      <div className={styles.settingsUpdateHeader}>
        <div className={styles.settingsUpdateTitle}>{update.title || update.key}</div>
        <div className={styles.settingsUpdateStatus}>{statusLabel(update.status)}</div>
      </div>
      {update.summary && (
        <div className={styles.settingsUpdateSummary}>{update.summary}</div>
      )}
      {changes.length > 0 && (
        <div className={styles.settingsUpdateChanges}>
          {changes.map((change) => (
            <div className={styles.settingsUpdateChange} key={`${change.key}:${change.label || ''}`}>
              <span className={styles.settingsUpdateChangeLabel}>{change.label || change.key}</span>
              <span className={styles.settingsUpdateChangeValue}>
                {displayValue(change.before)} -&gt; {displayValue(change.after)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
