import { useEffect, useState } from 'react';
import { useI18n } from '../../hooks/use-i18n';
import {
  dismissSessionCapabilityDrift,
  refreshSessionCapabilities,
} from '../../stores/session-actions';
import type { SessionCapabilityDrift } from '../../types';
import styles from './InputArea.module.css';

interface CapabilityDriftNoticeProps {
  sessionPath: string;
  drift: SessionCapabilityDrift;
}

const REFRESH_TIMEOUT_MS = 45_000;

function showInlineNotice(text: string, type: 'success' | 'error' | 'info' = 'info'): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('codia-inline-notice', {
    detail: { text, type },
  }));
}

function buildDetailText(
  drift: SessionCapabilityDrift,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (drift.addedToolNames.length > 0) {
    parts.push(t('session.capabilityDrift.addedTools', { count: drift.addedToolNames.length }));
  }
  const unavailableCount = drift.removedToolNames.length + drift.invalidToolNames.length;
  if (unavailableCount > 0) {
    parts.push(t('session.capabilityDrift.removedTools', { count: unavailableCount }));
  }
  if (drift.promptChanged) {
    parts.push(t('session.capabilityDrift.promptUpdated'));
  }
  return parts.join(t('session.capabilityDrift.separator'));
}

export function CapabilityDriftNotice({ sessionPath, drift }: CapabilityDriftNoticeProps) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [refreshStarted, setRefreshStarted] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    setConfirming(false);
    setRefreshStarted(false);
    setRefreshError(null);
  }, [sessionPath, drift.fingerprint]);

  const detail = buildDetailText(drift, t);
  const handleConfirmRefresh = () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
    setRefreshStarted(true);
    setRefreshError(null);
    void refreshSessionCapabilities(sessionPath, {
      signal: controller.signal,
      timeout: REFRESH_TIMEOUT_MS,
    }).then((ok) => {
      if (ok) {
        setConfirming(false);
        return;
      }
      const message = t('session.capabilityDrift.refreshFailed');
      setConfirming(false);
      setRefreshError(message);
      showInlineNotice(message, 'error');
    }).finally(() => {
      window.clearTimeout(timer);
      setRefreshStarted(false);
    });
  };

  return (
    <div className={styles['capability-drift-notice']} data-testid="capability-drift-notice" role="status">
      <div className={styles['capability-drift-text']}>
        {confirming ? (
          <span className={styles['capability-drift-detail']}>
            {t('session.capabilityDrift.confirmText')}
          </span>
        ) : (
          <>
            <span className={styles['capability-drift-title']}>
              {t('session.capabilityDrift.title')}
            </span>
            {refreshError && (
              <span className={styles['capability-drift-detail']} role="alert">
                {refreshError}
              </span>
            )}
            {detail && <span className={styles['capability-drift-detail']}>{detail}</span>}
          </>
        )}
      </div>
      <div className={styles['capability-drift-actions']}>
        {confirming ? (
          <>
            <button
              type="button"
              className={styles['capability-drift-button']}
              onClick={() => setConfirming(false)}
              disabled={refreshStarted}
            >
              {t('session.capabilityDrift.cancelButton')}
            </button>
            <button
              type="button"
              className={`${styles['capability-drift-button']} ${styles['capability-drift-button-primary']}`}
              onClick={handleConfirmRefresh}
              disabled={refreshStarted}
            >
              {refreshStarted ? t('session.capabilityDrift.refreshing') : t('session.capabilityDrift.confirmButton')}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={styles['capability-drift-button']}
              onClick={() => { void dismissSessionCapabilityDrift(sessionPath, drift.fingerprint); }}
            >
              {t('session.capabilityDrift.dismissButton')}
            </button>
            <button
              type="button"
              className={`${styles['capability-drift-button']} ${styles['capability-drift-button-primary']}`}
              onClick={() => setConfirming(true)}
            >
              {t('session.capabilityDrift.refreshButton')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
