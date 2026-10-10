import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import type { SessionConfirmationBlock } from '../../stores/chat-types';
import styles from './InputArea.module.css';
import {
  calculateSessionConfirmationMenuPosition,
  getSessionConfirmationBoundsRect,
} from './session-confirmation-position';

type ConfirmationAction = 'confirmed' | 'rejected';

interface SessionConfirmationPromptProps {
  block: SessionConfirmationBlock;
  exiting?: boolean;
}

function textWithFallback(key: string, fallback: string) {
  const translated = window.t?.(key);
  return translated && translated !== key ? translated : fallback;
}

function displayTitle(block: SessionConfirmationBlock) {
  if (block.kind === 'computer_app_approval') {
    const appName = block.subject?.label || '这个应用';
    return `是否允许应用控制 ${appName}`;
  }
  return block.title;
}

function displaySubject(block: SessionConfirmationBlock) {
  if (block.kind === 'computer_app_approval') {
    return {
      label: textWithFallback('input.computerAppSubject', '电脑应用'),
      detail: block.subject?.detail || block.subject?.label || '',
    };
  }
  if (block.subject?.label || block.subject?.detail) {
    return {
      label: block.subject?.label || '',
      detail: block.subject?.detail || '',
    };
  }
  return {
    label: block.body || '',
    detail: '',
  };
}

export function SessionConfirmationPrompt({ block, exiting = false }: SessionConfirmationPromptProps) {
  const [submission, setSubmission] = useState<{ confirmId: string; action: ConfirmationAction } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [switchingMode, setSwitchingMode] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);

  const pending = block.status === 'pending' && !exiting;
  const submitting = submission?.confirmId === block.confirmId ? submission.action : null;
  const confirmLabel = block.actions?.confirmLabel || window.t?.('common.approve') || '同意';
  const rejectLabel = block.actions?.rejectLabel || window.t?.('common.reject') || '拒绝';
  const title = displayTitle(block);
  const subject = displaySubject(block);
  const hasSubject = !!(subject.label || subject.detail);
  const canDisableAskForConversation = block.kind === 'tool_action_approval';
  const busy = !!submitting || switchingMode;

  const updateMenuPosition = useCallback(() => {
    const anchor = menuAnchorRef.current;
    if (!menuOpen || !anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = menuPanelRef.current?.getBoundingClientRect();
    const position = calculateSessionConfirmationMenuPosition({
      anchorRect,
      panelRect,
      boundsRect: getSessionConfirmationBoundsRect(anchor),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });

    setMenuStyle({
      position: 'fixed',
      top: position.top,
      left: position.left,
      zIndex: 10000,
      width: position.maxWidth,
      minWidth: position.maxWidth,
      maxWidth: position.maxWidth,
    });
  }, [menuOpen]);

  useLayoutEffect(() => {
    updateMenuPosition();
  }, [updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [menuOpen, updateMenuPosition]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuAnchorRef.current?.contains(target)) return;
      if (menuPanelRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
  }, [block.confirmId]);

  const submit = useCallback(async (action: ConfirmationAction) => {
    if (!pending || submitting) return;
    setMenuOpen(false);
    setSubmission({ confirmId: block.confirmId, action });
    try {
      await codiaFetch(`/api/confirm/${block.confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch (err) {
      setSubmission((current) => (
        current?.confirmId === block.confirmId ? null : current
      ));
      console.warn('[session-confirmation] submit failed', err);
    }
  }, [block.confirmId, pending, submitting]);

  const disableAskForConversation = useCallback(async () => {
    if (!pending || submitting || switchingMode || !canDisableAskForConversation) return;
    setMenuOpen(false);
    setSwitchingMode(true);
    try {
      const res = await codiaFetch('/api/session-permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'operate', currentSessionOnly: true }),
      });
      const data = await res.json();
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'failed to switch current session permission mode');
      }
      window.dispatchEvent(new CustomEvent('codia-plan-mode', {
        detail: { enabled: false, mode: data?.mode || 'operate' },
      }));
      await submit('confirmed');
    } catch (err) {
      window.dispatchEvent(new CustomEvent('codia-inline-notice', {
        detail: {
          text: textWithFallback('input.accessModeLocked', '当前无法更改权限模式'),
          type: 'error',
        },
      }));
      console.warn('[session-confirmation] disable ask for conversation failed', err);
    } finally {
      setSwitchingMode(false);
    }
  }, [canDisableAskForConversation, pending, submit, submitting, switchingMode]);

  const menu = menuOpen && typeof document !== 'undefined'
    ? createPortal(
      <div
        className={styles['session-confirmation-menu']}
        ref={menuPanelRef}
        role="menu"
        style={menuStyle}
      >
        <button
          type="button"
          role="menuitem"
          className={styles['session-confirmation-menu-item']}
          onClick={disableAskForConversation}
        >
          {textWithFallback('input.noAskThisConversation', '本对话不再询问')}
        </button>
      </div>,
      document.body,
    )
    : null;

  return (
    <div
      className={`${styles['session-confirmation-prompt']} ${exiting ? styles['session-confirmation-prompt-exiting'] : ''}`}
      data-confirm-id={block.confirmId}
      data-status={block.status}
      data-severity={block.severity || 'normal'}
    >
      <div className={styles['session-confirmation-body']}>
        <div className={styles['session-confirmation-title']}>{title}</div>
        {hasSubject && (
          <div className={styles['session-confirmation-subject']}>
            {subject.label && <span className={styles['session-confirmation-subject-label']}>{subject.label}</span>}
            {subject.detail && <span className={styles['session-confirmation-subject-detail']}>{subject.detail}</span>}
          </div>
        )}
      </div>
      {pending ? (
        <div className={styles['session-confirmation-actions']}>
          <button
            type="button"
            className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-reject']}`}
            onClick={() => submit('rejected')}
            disabled={busy}
          >
            {rejectLabel}
          </button>
          {canDisableAskForConversation ? (
            <div className={styles['session-confirmation-confirm-wrap']} ref={menuAnchorRef}>
              <div className={styles['session-confirmation-split']}>
                <button
                  type="button"
                  className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-confirm']} ${styles['session-confirmation-split-main']}`}
                  onClick={() => submit('confirmed')}
                  disabled={busy}
                >
                  {confirmLabel}
                </button>
                <button
                  type="button"
                  className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-confirm']} ${styles['session-confirmation-menu-trigger']}`}
                  aria-label={textWithFallback('input.confirmMoreOptions', '更多确认选项')}
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                  disabled={busy}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </div>
              {menu}
            </div>
          ) : (
            <button
              type="button"
              className={`${styles['session-confirmation-button']} ${styles['session-confirmation-button-confirm']}`}
              onClick={() => submit('confirmed')}
              disabled={busy}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      ) : (
        <div className={styles['session-confirmation-resolved']}>
          {block.status === 'confirmed'
            ? (window.t?.('common.approved') || '已同意')
            : (window.t?.('common.rejected') || '已拒绝')}
        </div>
      )}
    </div>
  );
}
