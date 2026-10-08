import React, { useCallback, useEffect, useRef, useState } from 'react';
import { gsapFetch } from '../api';
import { t } from '../helpers';
import { formatBridgeError } from '../tabs/bridge/BridgeWidgets';
import styles from './WechatQrcodeOverlay.module.css';

type QrStatus = 'loading' | 'waiting' | 'confirmed' | 'error';

export function WhatsappQrcodeOverlay() {
  const [visible, setVisible] = useState(false);
  const [qrcodeUrl, setQrcodeUrl] = useState('');
  const [status, setStatus] = useState<QrStatus>('loading');
  const [error, setError] = useState('');
  const [errorType, setErrorType] = useState<string | null>(null);
  const agentIdRef = useRef<string | null>(null);
  const stoppedRef = useRef(true);

  const stopPolling = useCallback(() => {
    stoppedRef.current = true;
  }, []);

  const close = useCallback(() => {
    stopPolling();
    setVisible(false);
    setQrcodeUrl('');
    setStatus('loading');
    setError('');
    setErrorType(null);
    agentIdRef.current = null;
  }, [stopPolling]);

  const fetchQrcode = useCallback(async (force = false) => {
    const parts: string[] = [];
    if (agentIdRef.current) {
      parts.push(`agentId=${encodeURIComponent(agentIdRef.current)}`);
    }
    if (force) {
      parts.push('force=1');
    }
    const query = parts.length ? `?${parts.join('&')}` : '';

    setStatus('loading');
    setError('');
    setErrorType(null);

    try {
      const res = await gsapFetch(`/api/bridge/whatsapp/qrcode${query}`, { method: 'POST' });
      const data = await res.json();

      if (data.qrcodeUrl) {
        setQrcodeUrl(data.qrcodeUrl);
        setStatus('waiting');
        return;
      }

      if (data.authenticated) {
        setStatus('confirmed');
        window.dispatchEvent(new Event('gsap-bridge-reload'));
        setTimeout(close, 1200);
        return;
      }

      if (data.error) {
        setStatus('error');
        setError(data.error);
        setErrorType(data.errorType || null);
        return;
      }

      setStatus('waiting');
    } catch (err: unknown) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [close]);

  const startPolling = useCallback(() => {
    stoppedRef.current = false;

    (async () => {
      while (!stoppedRef.current) {
        try {
          const query = agentIdRef.current ? `?agentId=${encodeURIComponent(agentIdRef.current)}` : '';
          const res = await gsapFetch(`/api/bridge/status${query}`);
          const data = await res.json();
          const wa = data?.whatsapp || {};

          if (wa.qrcodeUrl) {
            setQrcodeUrl(wa.qrcodeUrl);
            setStatus('waiting');
          }

          if (wa.authenticated) {
            setStatus('confirmed');
            window.dispatchEvent(new Event('gsap-bridge-reload'));
            setTimeout(close, 1200);
            return;
          }

          if (wa.error) {
            setStatus('error');
            setError(wa.error);
            setErrorType(wa.errorType || null);
            return;
          }
        } catch {
          // transient polling failure; keep waiting
        }

        if (!stoppedRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    })();
  }, [close]);

  useEffect(() => {
    const show = (e: Event) => {
      const detail = (e as CustomEvent<{ agentId?: string | null; force?: boolean }>).detail;
      agentIdRef.current = detail?.agentId ?? null;
      setVisible(true);
      fetchQrcode(!!detail?.force);
    };

    window.addEventListener('gsap-show-whatsapp-qrcode', show);
    return () => {
      window.removeEventListener('gsap-show-whatsapp-qrcode', show);
      stopPolling();
    };
  }, [fetchQrcode, stopPolling]);

  useEffect(() => {
    if (!visible) return undefined;
    startPolling();
    return stopPolling;
  }, [visible, startPolling, stopPolling]);

  if (!visible) return null;

  const statusLabel = (() => {
    switch (status) {
      case 'loading':
        return t('settings.bridge.whatsappScanning');
      case 'waiting':
        return qrcodeUrl ? t('settings.bridge.whatsappScan') : t('settings.bridge.whatsappScanning');
      case 'confirmed':
        return t('settings.bridge.whatsappLoginSuccess');
      case 'error':
        return formatBridgeError(errorType, error) || t('settings.bridge.whatsappLoginFailed');
      default:
        return '';
    }
  })();

  const statusClass = status === 'confirmed'
    ? styles.success
    : status === 'error'
      ? styles.error
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

        <div className={styles.title}>WhatsApp</div>

        <div className={styles.qrcodeContainer}>
          {status === 'loading' && <span className={styles.loading} aria-label={t('settings.bridge.whatsappScanning')} />}
          {qrcodeUrl && status !== 'loading' && (
            <img className={styles.qrcodeImg} src={qrcodeUrl} alt="WhatsApp QR Code" />
          )}
        </div>

        <div className={`${styles.statusText} ${statusClass}`}>{statusLabel}</div>
      </div>
    </div>
  );
}
