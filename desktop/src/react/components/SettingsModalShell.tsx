import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { closeSettingsModal, setSettingsModalActiveTab } from '../stores/settings-modal-actions';
import { SettingsContent } from '../settings/SettingsContent';
import { useSettingsStore } from '../settings/store';
import styles from './SettingsModalShell.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

const CLOSE_ANIMATION_MS = 150;
type RenderState = 'closed' | 'opening' | 'open' | 'closing';
const WIDE_SETTINGS_MODAL_TABS = new Set(['providers', 'media', 'plugin-marketplace']);

export function SettingsModalShell() {
  const settingsModal = useStore(s => s.settingsModal);
  const isWideSettingsPage = WIDE_SETTINGS_MODAL_TABS.has(settingsModal.activeTab);
  const [renderState, setRenderState] = useState<RenderState>(settingsModal.open ? 'opening' : 'closed');
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearAnimationFrame = useCallback(() => {
    if (animationFrameRef.current === null) return;
    window.cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const requestClose = useCallback(() => {
    if (renderState === 'closing' || renderState === 'closed') return;
    clearAnimationFrame();
    clearCloseTimer();
    setRenderState('closing');
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      closeSettingsModal();
      setRenderState('closed');
    }, CLOSE_ANIMATION_MS);
  }, [clearAnimationFrame, clearCloseTimer, renderState]);

  useEffect(() => () => {
    clearAnimationFrame();
    clearCloseTimer();
  }, [clearAnimationFrame, clearCloseTimer]);

  useEffect(() => {
    if (!settingsModal.open) {
      setRenderState('closed');
      return;
    }

    clearCloseTimer();
    setRenderState('opening');
    clearAnimationFrame();
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      setRenderState('open');
    });
  }, [clearAnimationFrame, clearCloseTimer, settingsModal.open]);

  useEffect(() => {
    if (renderState !== 'opening') return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }, [renderState]);

  useEffect(() => {
    if (renderState === 'closed') return;
    useSettingsStore.setState({ activeTab: settingsModal.activeTab });
  }, [renderState, settingsModal.activeTab]);

  useEffect(() => {
    if (renderState !== 'open') return;
    requestAnimationFrame(() => {
      const target = cardRef.current?.querySelector<HTMLElement>('[data-settings-return]')
        ?? firstFocusable(cardRef.current);
      target?.focus();
    });
  }, [renderState]);

  useEffect(() => {
    if (renderState === 'closed' || renderState === 'closing') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key === 'Tab') {
        keepFocusInside(event, cardRef.current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [renderState, requestClose]);

  useEffect(() => {
    if (settingsModal.open || renderState !== 'closed') return;
    returnFocusRef.current?.focus?.();
    returnFocusRef.current = null;
  }, [renderState, settingsModal.open]);

  const visualState: RenderState = renderState === 'closed' && settingsModal.open ? 'opening' : renderState;

  if (!settingsModal.open && renderState === 'closed') return null;

  return (
    <div
      className={`${styles.overlay} ${styles[visualState]}`}
      data-testid="settings-modal-overlay"
      data-state={visualState}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          requestClose();
        }
      }}
    >
      <div
        ref={cardRef}
        className={`${styles.card} ${styles[visualState]}`}
        data-state={visualState}
        data-wide={isWideSettingsPage ? 'true' : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
      >
        <SettingsContent
          variant="modal"
          onClose={requestClose}
          onActiveTabChange={setSettingsModalActiveTab}
          activeTabOverride={settingsModal.activeTab}
        />
      </div>
    </div>
  );
}

function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
    .filter((el) => !el.hasAttribute('hidden') && el.getAttribute('aria-hidden') !== 'true');
}

function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return getFocusable(root)[0] ?? null;
}

function keepFocusInside(event: KeyboardEvent, root: HTMLElement | null): void {
  const focusable = getFocusable(root);
  if (focusable.length === 0) {
    event.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
