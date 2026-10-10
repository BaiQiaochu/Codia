import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { Check, HandPalm, ShieldCheck, ShieldWarning } from '@phosphor-icons/react';
import { codiaFetch } from '../../hooks/use-codia-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { useStore } from '../../stores';
import styles from './InputArea.module.css';

export type PermissionMode = 'auto' | 'operate' | 'ask' | 'read_only';

const PERMISSION_MODES: Array<Exclude<PermissionMode, 'read_only'>> = ['ask', 'auto', 'operate'];
const DROPDOWN_VIEWPORT_PADDING = 8;
const DROPDOWN_GAP = 6;
const DROPDOWN_MIN_WIDTH = 360;
const DROPDOWN_ESTIMATED_ROW_HEIGHT = 58;
const PERMISSION_MODE_LABEL_FALLBACKS: Record<PermissionMode, string> = {
  auto: '帮我批准',
  operate: '完全访问权限',
  ask: '请求批准',
  read_only: '请求批准',
};
const PERMISSION_MODE_DESCRIPTION_FALLBACKS: Record<Exclude<PermissionMode, 'read_only'>, string> = {
  ask: '编辑外部文件和使用互联网时始终询问',
  auto: '仅对检测到的风险操作请求批准',
  operate: '可不受限制地访问互联网和你电脑上的任何文件',
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
  const availableWidth = Math.max(0, viewportWidth - (DROPDOWN_VIEWPORT_PADDING * 2)) || DROPDOWN_MIN_WIDTH;
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
  if (mode === 'read_only') return 'input.askMode';
  if (mode === 'ask') return 'input.askMode';
  return 'input.operateMode';
}

function permissionModeLabel(t: (key: string) => string, mode: PermissionMode) {
  const key = permissionModeLabelKey(mode);
  const label = t(key);
  return label && label !== key ? label : PERMISSION_MODE_LABEL_FALLBACKS[mode];
}

function permissionModeDescription(t: (key: string) => string, mode: Exclude<PermissionMode, 'read_only'>) {
  const key = `input.${mode === 'ask' ? 'ask' : mode}ModeDescription`;
  const description = t(key);
  return description && description !== key ? description : PERMISSION_MODE_DESCRIPTION_FALLBACKS[mode];
}

export function PermissionModeIcon({ mode }: { mode: PermissionMode }) {
  if (mode === 'ask' || mode === 'read_only') return <HandPalm data-permission-mode={mode} size={16} weight="regular" aria-hidden="true" />;
  if (mode === 'auto') return <ShieldCheck data-permission-mode={mode} size={16} weight="regular" aria-hidden="true" />;
  return <ShieldWarning data-permission-mode={mode} size={16} weight="regular" aria-hidden="true" />;
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
        const res = await codiaFetch('/api/preferences/session-permission-default', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissionMode: nextMode }),
        });
        const data = await res.json();
        onChange((data.permissionMode || nextMode) as PermissionMode);
        return;
      }
      const res = await codiaFetch('/api/session-permission-mode', {
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
        window.dispatchEvent(new CustomEvent('codia-inline-notice', {
          detail: { text: t('input.accessModeLocked'), type: 'error' },
        }));
      }
      onChange((data.mode || nextMode) as PermissionMode);
    } catch (err) {
      console.error('[plan-mode] select failed:', err);
    }
  }, [mode, onChange, t]);

  const displayMode: Exclude<PermissionMode, 'read_only'> = mode === 'read_only' ? 'ask' : mode;
  const label = permissionModeLabel(t, displayMode);
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
              className={`${styles['thinking-option']} ${styles['plan-mode-option']} ${styles[`plan-mode-option-${permissionMode}`] || ''}${permissionMode === displayMode ? ` ${styles.active}` : ''}`}
              onClick={() => selectMode(permissionMode)}
            >
              <PermissionModeIcon mode={permissionMode} />
              <span className={styles['plan-mode-option-copy']}>
                <strong>{permissionModeLabel(t, permissionMode)}</strong>
                <small>{permissionModeDescription(t, permissionMode)}</small>
              </span>
              {permissionMode === displayMode && <Check className={styles['plan-mode-option-check']} size={18} weight="bold" aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={`${styles['thinking-selector']} ${styles['plan-mode-selector']}${open ? ` ${styles.open}` : ''}`} ref={ref}>
      <button type="button"
        className={`${styles['plan-mode-btn']} ${styles[`plan-mode-${displayMode}`] || ''}`}
        title={locked ? t('input.accessModeLocked') : t('input.accessMode')}
        onClick={toggleDropdown}
        disabled={locked}
      >
        <PermissionModeIcon mode={displayMode} />
        <span className={styles['plan-mode-label']}>{label}</span>
      </button>
      {dropdown}
    </div>
  );
}
