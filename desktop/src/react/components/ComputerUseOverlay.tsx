import { useEffect } from 'react';
import { useStore } from '../stores';
import { getWebSocket } from '../services/websocket';
import styles from './ComputerUseOverlay.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

export function ComputerUseOverlay() {
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const event = useStore(s => currentSessionPath ? s.computerOverlayBySession[currentSessionPath] : null);

  const foregroundTakeover = !!event && event.inputMode === 'foreground-input' && event.phase !== 'done' && event.phase !== 'error';

  useEffect(() => {
    if (!foregroundTakeover || !currentSessionPath) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      getWebSocket()?.send(JSON.stringify({
        type: 'abort',
        sessionPath: currentSessionPath,
      }));
      useStore.getState().clearComputerOverlayForSession(currentSessionPath);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentSessionPath, foregroundTakeover]);

  if (!event || !foregroundTakeover) return null;

  return (
    <div className={styles.overlay}>
      <div className={styles.takeoverNotice} role="status">
        <strong>{t('computerUse.overlay.foregroundTakeover')}</strong>
        <span>{t('computerUse.overlay.foregroundMessage')}</span>
      </div>
    </div>
  );
}
