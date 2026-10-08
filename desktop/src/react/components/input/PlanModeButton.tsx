import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { gsapFetch } from '../../hooks/use-gsap-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

export type PermissionMode = 'auto' | 'operate' | 'ask' | 'read_only';

const PERMISSION_MODES: PermissionMode[] = ['auto', 'operate', 'ask', 'read_only'];
const DROPDOWN_VIEWPORT_PADDING = 8;
const DROPDOWN_GAP = 6;
const DROPDOWN_MIN_WIDTH = 128;
const DROPDOWN_ESTIMATED_ROW_HEIGHT = 34;
const PERMISSION_MODE_LABEL_FALLBACKS: Record<PermissionMode, string> = {
  auto: '自动模式',
  operate: '自动操作',
  ask: '操作前询问',
  read_only: '只读模式',
};

interface PlanModeDropdownPosition {
  placement: 'above' | 'below';
  style: CSSProperties;
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function calculatePlanModeDropdownPosition(
  anchorRect: DOMRect,
  dropdownRect?: DOMRect | null,
): PlanModeDropdownPosition {
  const viewportWidth = window.innerWidth || 0;
  const viewportHeight = window.innerHeight || 0;
  const availableWidth = Math.max(DROPDOWN_MIN_WIDTH, viewportWidth - (DROPDOWN_VIEWPORT_PADDING * 2));
  const minWidth = Math.min(Math.max(anchorRect.width, DROPDOWN_MIN_WIDTH), availableWidth);
  const dropdownWidth = Math.min(
    Math.max(dropdownRect?.width || 0, minWidth),
    availableWidth,
  );
  const dropdownHeight = Math.max(
    dropdownRect?.height || 0,
    PERMISSION_MODES.length * DROPDOWN_ESTIMATED_ROW_HEIGHT,
  );

  const left = clamp(
    anchorRect.right - dropdownWidth,
    DROPDOWN_VIEWPORT_PADDING,
    Math.max(DROPDOWN_VIEWPORT_PADDING, viewportWidth - dropdownWidth - DROPDOWN_VIEWPORT_PADDING),
  );
  const preferredTop = anchorRect.top - dropdownHeight - DROPDOWN_GAP;
  let placement: 'above' | 'below' = 'above';
  let top = preferredTop;
  if (preferredTop < DROPDOWN_VIEWPORT_PADDING) {
    placement = 'below';
    top = Math.min(
      anchorRect.bottom + DROPDOWN_GAP,
      viewportHeight - dropdownHeight - DROPDOWN_VIEWPORT_PADDING,
    );
  }

  return {
    placement,
    style: {
      position: 'fixed',
      top: Math.max(DROPDOWN_VIEWPORT_PADDING, top),
      left,
      minWidth,
      maxWidth: availableWidth,
    },
  };
}

function permissionModeLabelKey(mode: PermissionMode) {
  if (mode === 'auto') return 'input.autoMode';
  if (mode === 'read_only') return 'input.readOnlyMode';
  if (mode === 'ask') return 'input.askMode';
  return 'input.operateMode';
}

function permissionModeLabel(t: (key: string) => string, mode: PermissionMode) {
  const key = permissionModeLabelKey(mode);
  const label = t(key);
  return label && label !== key ? label : PERMISSION_MODE_LABEL_FALLBACKS[mode];
}

export function PermissionModeIcon({ mode }: { mode: PermissionMode }) {
  if (mode === 'auto') {
    return (
      <svg data-permission-mode={mode} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.5 19 6v5.4c0 4.1-2.7 7.5-7 9.1-4.3-1.6-7-5-7-9.1V6l7-2.5Z" />
      </svg>
    );
  }
  if (mode === 'read_only') {
    return (
      <svg data-permission-mode={mode} width="14" height="14" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
        <path d="M30 25c0 1.104-.927 1.656-2 2 0 0-5.443 1.515-11 2.977V5l11-3c1.104 0 2 .896 2 2v21ZM15 29.998C9.538 28.53 4 27 4 27c-1.136-.312-2-.896-2-2V4c0-1.104.896-2 2-2l11 3v24.998ZM28 0s-5.789 1.594-11.05 3c-.659.025-1.323 0-1.983 0C9.955 1.656 4 0 4 0 1.791 0 0 1.791 0 4v21c0 2.209 1.885 3.313 4 4 0 0 5.393 1.5 10.967 3h2.025C22.612 30.5 28 29 28 29c2.053-.531 4-1.791 4-4V4c0-2.209-1.791-4-4-4Z" />
      </svg>
    );
  }
  if (mode === 'ask') {
    return (
      <svg data-permission-mode={mode} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg data-permission-mode={mode} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function PlanModeButton({ mode, onChange, locked = false }: {
  mode: PermissionMode;
  onChange: (v: PermissionMode) => void;
  locked?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPlacement, setDropdownPlacement] = useState<'above' | 'below'>('above');
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const updateDropdownPosition = useCallback(() => {
    const anchor = ref.current;
    const dropdown = dropdownRef.current;
    if (!anchor || !dropdown) return;

    const anchorRect = anchor.getBoundingClientRect();
    const dropdownRect = dropdown.getBoundingClientRect();
    const position = calculatePlanModeDropdownPosition(anchorRect, dropdownRect);
    setDropdownPlacement(position.placement);
    setDropdownStyle(position.style);
  }, []);

  const toggleDropdown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }

    const anchor = ref.current;
    if (anchor) {
      const position = calculatePlanModeDropdownPosition(anchor.getBoundingClientRect());
      setDropdownPlacement(position.placement);
      setDropdownStyle(position.style);
    }
    setOpen(true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    const raf = requestAnimationFrame(updateDropdownPosition);
    const handleReposition = () => updateDropdownPosition();

    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open, updateDropdownPosition, mode]);

  const selectMode = useCallback(async (nextMode: PermissionMode) => {
    setOpen(false);
    if (nextMode === mode) return;
    try {
      const state = useStore.getState();
      const pendingNewSession = state.pendingNewSession === true;
      const sessionPath = pendingNewSession ? null : state.currentSessionPath;
      if (pendingNewSession) {
        const res = await gsapFetch('/api/preferences/session-permission-default', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissionMode: nextMode }),
        });
        const data = await res.json();
        onChange((data.permissionMode || nextMode) as PermissionMode);
        return;
      }
      const res = await gsapFetch('/api/session-permission-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: nextMode,
          pendingNewSession,
          ...(sessionPath ? { sessionPath } : {}),
        }),
      });
      const data = await res.json();
      if (data.locked) {
        window.dispatchEvent(new CustomEvent('gsap-inline-notice', {
          detail: { text: t('input.accessModeLocked'), type: 'error' },
        }));
      }
      onChange((data.mode || nextMode) as PermissionMode);
    } catch (err) {
      console.error('[plan-mode] select failed:', err);
    }
  }, [mode, onChange, t]);

  const label = permissionModeLabel(t, mode);
  const dropdown = open && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={dropdownRef}
          className={`${styles['thinking-dropdown']} ${styles['dropdown-open']} ${styles['plan-mode-dropdown']}${dropdownPlacement === 'below' ? ` ${styles['below']}` : ''}`}
          style={dropdownStyle ?? undefined}
        >
          {PERMISSION_MODES.map((permissionMode) => (
            <button type="button"
              key={permissionMode}
              className={`${styles['thinking-option']} ${styles['plan-mode-option']} ${styles[`plan-mode-option-${permissionMode}`] || ''}${permissionMode === mode ? ` ${styles.active}` : ''}`}
              onClick={() => selectMode(permissionMode)}
            >
              <PermissionModeIcon mode={permissionMode} />
              <span>{permissionModeLabel(t, permissionMode)}</span>
            </button>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={`${styles['thinking-selector']} ${styles['plan-mode-selector']}${open ? ` ${styles.open}` : ''}`} ref={ref}>
      <button type="button"
        className={`${styles['plan-mode-btn']} ${styles[`plan-mode-${mode}`] || ''}`}
        title={locked ? t('input.accessModeLocked') : t('input.accessMode')}
        onClick={toggleDropdown}
        disabled={locked}
      >
        <PermissionModeIcon mode={mode} />
        <span className={styles['plan-mode-label']}>{label}</span>
      </button>
      {dropdown}
    </div>
  );
}
