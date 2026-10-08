/**
 * PluginTabOverflow - overflow dropdown for excess tabs in ChannelTabBar.
 *
 * The tab bar clips its children for the segmented control shape, so the
 * dropdown is portaled to document.body and positioned from the trigger.
 */

import { useState, useRef, useEffect, useCallback, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { TabType } from '../../types';
import { addFixedDropdownPositionListeners, computeFixedDropdownStyle } from '../../settings/widgets/dropdown-position';
import s from './PluginTabOverflow.module.css';

declare function t(key: string, vars?: Record<string, string | number>): string;

interface TabItem {
  id: TabType;
  label: string;
  hidden?: boolean;
}

interface Props {
  tabs: TabItem[];
  currentTab: TabType;
  onSelect: (tab: TabType) => void;
  onPin?: (tab: TabType) => void;
  onContextMenu?: (e: React.MouseEvent, tab: TabType) => void;
}

export function PluginTabOverflow({ tabs, currentTab, onSelect, onPin, onContextMenu }: Props) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const updateDropdownPosition = useCallback(() => {
    if (!open || !triggerRef.current) return;
    setPanelStyle({
      ...computeFixedDropdownStyle(triggerRef.current, panelRef.current, {
        gap: 6,
        minWidth: 140,
        width: 180,
        preferredMaxHeight: 320,
        minHeight: 120,
        zIndex: 9999,
      }),
      right: 'auto',
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    updateDropdownPosition();
    const removeListeners = addFixedDropdownPositionListeners(updateDropdownPosition);
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      updateDropdownPosition();
      secondFrame = window.requestAnimationFrame(updateDropdownPosition);
    });
    return () => {
      removeListeners();
      window.cancelAnimationFrame?.(firstFrame);
      if (secondFrame) window.cancelAnimationFrame?.(secondFrame);
    };
  }, [open, updateDropdownPosition]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (tabs.length === 0) return null;

  const hasActive = tabs.some(tab => tab.id === currentTab);
  const normalTabs = tabs.filter(tab => !tab.hidden);
  const hiddenTabs = tabs.filter(tab => tab.hidden);

  const dropdown = open ? (
    <div className={s.dropdown} ref={panelRef} style={panelStyle}>
      {normalTabs.map(tab => (
        <button type="button"
          key={tab.id}
          className={`${s.dropdownItem}${tab.id === currentTab ? ` ${s.dropdownItemActive}` : ''}`}
          onClick={() => { onSelect(tab.id); setOpen(false); }}
          onContextMenu={(e) => { onContextMenu?.(e, tab.id); setOpen(false); }}
        >
          {tab.label}
        </button>
      ))}
      {hiddenTabs.length > 0 && normalTabs.length > 0 && (
        <div className={s.divider} />
      )}
      {hiddenTabs.map(tab => (
        <div key={tab.id} className={s.dropdownRow}>
          <button type="button"
            className={`${s.dropdownItem} ${s.dropdownItemHidden}`}
            onClick={() => { onSelect(tab.id); setOpen(false); }}
          >
            {tab.label}
          </button>
          {onPin && (
            <button type="button"
              className={s.pinBtn}
              title="固定到标签栏"
              aria-label="固定到标签栏"
              onClick={(e) => { e.stopPropagation(); onPin(tab.id); setOpen(false); }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 4v6l-2 4v2h10v-2l-2-4v-6" /><path d="M12 16v5" /><path d="M8 4h8" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  ) : null;

  return (
    <div className={s.overflowWrap} ref={wrapRef}>
      <button type="button"
        ref={triggerRef}
        className={`${s.overflowBtn}${open || hasActive ? ` ${s.overflowBtnActive}` : ''}`}
        title={t('channel.moreTabs')}
        aria-label={t('channel.moreTabs')}
        onClick={() => setOpen(v => !v)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {dropdown && typeof document !== 'undefined' ? createPortal(dropdown, document.body) : null}
    </div>
  );
}
