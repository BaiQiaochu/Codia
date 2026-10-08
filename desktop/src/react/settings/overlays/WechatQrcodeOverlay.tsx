import React, { useState, useEffect, useRef, useCallback } from 'react';
import { gsapFetch } from '../api';
import { t } from '../helpers';
import styles from './WechatQrcodeOverlay.module.css';

type QrStatus = 'loading' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';

const MAX_REFRESH = 3;

export function WechatQrcodeOverlay() {
  const [visible, setVisible] = useState(false);
  const [qrcodeUrl, setQrcodeUrl] = useState('');
  const [qrcodeId, setQrcodeId] = useState('');
  const [status, setStatus] = useState<QrStatus>('loading');
  const [error, setError] = useState('');
  const [, setRefreshCount] = useState(0);
  const agentIdRef = useRef<string | null>(null);
  const stoppedRef = useRef(true);

  const stopPolling = useCallback(() => { stoppedRef.current = true; }, []);

  const close = useCallback(() => {
    stopPolling();
    setVisible(false);
    setQrcodeUrl('');
    setQrcodeId('');
    setStatus('loading');
    setError('');
    setRefreshCount(0);
    agentIdRef.current = null;
  }, [stopPolling]);

  const fetchQrcode = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const res = await gsapFetch('/api/bridge/wechat/qrcode', { method: 'POST' });
      const data = await res.json();
      if (data.ok && data.qrcodeUrl) {
        setQrcodeUrl(data.qrcodeUrl);
        setQrcodeId(data.qrcodeId);
        setStatus('waiting');
      } else {
        setStatus('error');
        setError(data.error || t('settings.bridge.wechatLoginFailed'));
      }
    } catch (err: unknown) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /**
   * Poll recursively with await so each request finishes before the next
   * one starts. This avoids overlapping long-poll requests.
   */
  const startPolling = useCallback((id: string) => {
    stoppedRef.current = false;

    (async () => {
      while (!stoppedRef.current) {
        try {
          const res = await gsapFetch('/api/bridge/wechat/qrcode-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qrcodeId: id }),
          });
          if (stoppedRef.current) return;
          const data = await res.json();

          if (data.status === 'scanned') {
            setStatus('scanned');
          } else if (data.status === 'confirmed' && data.botToken) {
            stoppedRef.current = true;
            setStatus('confirmed');
            // Read agentId from ref so this uses the current value, not a stale closure.
            const agentQuery = agentIdRef.current ? `?agentId=${encodeURIComponent(agentIdRef.current)}` : '';
            await gsapFetch(`/api/bridge/config${agentQuery}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                platform: 'wechat',
                credentials: { botToken: data.botToken },
                enabled: true,
              }),
            });
            // WeChat binds one account; the scanning user becomes the owner.
            if (data.userId) {
              await gsapFetch(`/api/bridge/owner${agentQuery}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ platform: 'wechat', userId: data.userId }),
              }).catch((err: unknown) => console.warn('[WechatQrcodeOverlay] set owner failed', err));
            }
            window.dispatchEvent(new Event('gsap-bridge-reload'));
            setTimeout(close, 1200);
            return;
          } else if (data.status === 'expired') {
            stoppedRef.current = true;
            setRefreshCount((prev) => {
              const next = prev + 1;
              if (next >= MAX_REFRESH) {
                setStatus('error');
                setError(t('settings.bridge.wechatExpired'));
              } else {
                fetchQrcode();
              }
              return next;
            });
            return;
          }
        } catch { /* Network errors are retried by the next poll. */ }

        // Wait briefly between polling requests.
        if (!stoppedRef.current) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }, [close, fetchQrcode]);

 // 监听显示事件
  useEffect(() => {
    const show = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId?: string | null }>).detail;
      agentIdRef.current = detail?.agentId ?? null;
      setVisible(true);
      setRefreshCount(0);
      fetchQrcode();
    };
    window.addEventListener('gsap-show-wechat-qrcode', show);
    return () => {
      window.removeEventListener('gsap-show-wechat-qrcode', show);
      stopPolling();
    };
  }, [fetchQrcode, stopPolling]);

  // Start polling when the QR code id changes.
  useEffect(() => {
    if (qrcodeId) {
      startPolling(qrcodeId);
    }
    return stopPolling;
  }, [qrcodeId, startPolling, stopPolling]);

  if (!visible) return null;

  const statusLabel = (() => {
    switch (status) {
      case 'loading': return t('settings.bridge.wechatScanning');
      case 'waiting': return t('settings.bridge.wechatScanning');
      case 'scanned': return t('settings.bridge.wechatScanned');
      case 'confirmed': return t('settings.bridge.wechatLoginSuccess');
      case 'expired': return t('settings.bridge.wechatExpired');
      case 'error': return error || t('settings.bridge.wechatLoginFailed');
      default: return '';
    }
  })();

  const statusClass = status === 'confirmed' ? styles.success
    : (status === 'error' || status === 'expired') ? styles.error
    : '';

  return (
    <div className={`${styles.overlay} ${styles.visible}`} onClick={close}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <button type="button" className={styles.closeBtn} onClick={close} aria-label="close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>

        <div className={styles.title}>{t('settings.bridge.wechat')}</div>

        <div className={styles.qrcodeContainer}>
          {status === 'loading' && <span className={styles.loading}>...</span>}
          {qrcodeUrl && status !== 'loading' && (
            <img className={styles.qrcodeImg} src={qrcodeUrl} alt="WeChat QR Code" />
          )}
        </div>

        <div className={`${styles.statusText} ${statusClass}`}>{statusLabel}</div>
      </div>
    </div>
  );
}
