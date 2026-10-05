/**
  *
 * -/api/models 读取唯一信源，按 provider 分组、支持搜索和自定义输- */
import React, { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { gsapFetch } from '../api';
import type { ModelMetaPayload } from '../shared-types';
import styles from '../Settings.module.css';
import { addFixedDropdownPositionListeners, computeFixedDropdownStyle } from './dropdown-position';

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number | null;
  image?: boolean;
  input?: string[];
  vision?: boolean;
}

type ModelRefValue = string | {
  id: string;
  provider: string;
}

type ModelSelection = {
  id: string;
  provider: string;
};

interface ModelWidgetProps {
 /** @deprecated 不再使用，保留兼容签-*/
  providers?: Record<string, unknown>;
  value: ModelRefValue | null | undefined;
  onSelect: (ref: ModelSelection | null) => void;
  placeholder?: string;
  allowClear?: boolean;
  clearLabel?: string;
  lookupModelMeta?: (id: string) => ModelMetaPayload | null;
  formatContext?: (n: number) => string;
  filterModel?: (model: ModelInfo) => boolean;
  modelsPath?: string;
}

export function ModelWidget({
  value, onSelect,
  placeholder, allowClear = false, clearLabel, formatContext, filterModel,
  modelsPath = '/api/models',
}: ModelWidgetProps) {
  const t = window.t || ((k: string) => k);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});
  const close = useCallback(() => setOpen(false), []);

 //
  useEffect(() => {
    let cancelled = false;
    gsapFetch(modelsPath).then(r => r.json()).then(data => {
      if (!cancelled) setModels(data.models || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [modelsPath]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  const updatePanelPosition = useCallback(() => {
    if (!open || !triggerRef.current) return;
    setPanelStyle(computeFixedDropdownStyle(triggerRef.current, panelRef.current, {
      minWidth: 200,
      preferredMaxHeight: 320,
      minHeight: 160,
      flipThreshold: 220,
    }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    updatePanelPosition();
    const removeListeners = addFixedDropdownPositionListeners(updatePanelPosition);
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      updatePanelPosition();
      secondFrame = window.requestAnimationFrame(updatePanelPosition);
    });
    return () => {
      removeListeners();
      window.cancelAnimationFrame?.(firstFrame);
      if (secondFrame) window.cancelAnimationFrame?.(secondFrame);
    };
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (open) {
      setSearch('');
      requestAnimationFrame(() => {
        updatePanelPosition();
        searchRef.current?.focus({ preventScroll: true });
      });
    }
  }, [open, updatePanelPosition]);

  const query = search.toLowerCase();
  const visibleModels = useMemo(
    () => (filterModel ? models.filter(filterModel) : models),
    [models, filterModel],
  );
  const valueKey = typeof value === 'string'
    ? value
    : (value?.id && value?.provider ? `${value.provider}/${value.id}` : '');
  const selectedModel = valueKey
    ? visibleModels.find(m => `${m.provider}/${m.id}` === valueKey)
    : null;
  const displayValue = selectedModel?.name || valueKey;

  //
  const grouped = useMemo(() => {
    const groups: Record<string, ModelInfo[]> = {};
    for (const m of visibleModels) {
      if (query && !m.id.toLowerCase().includes(query) && !m.name.toLowerCase().includes(query)) continue;
      const g = m.provider || '';
      if (!groups[g]) groups[g] = [];
      groups[g].push(m);
    }
    return groups;
  }, [visibleModels, query]);

  const handleCustomSubmit = () => {
    const val = customInput.trim();
    if (!val) return;
    const slashIdx = val.indexOf('/');
    if (slashIdx <= 0 || slashIdx >= val.length - 1) return;
    const provider = val.slice(0, slashIdx).trim();
    const id = val.slice(slashIdx + 1).trim();
    if (!provider || !id) return;
    onSelect({ id, provider });
    setCustomInput('');
    setOpen(false);
  };

  const handleClear = () => {
    onSelect(null);
    setCustomInput('');
    setSearch('');
    setOpen(false);
  };

  return (
    <div className={`${styles['mdw']}${open ? ' ' + styles['open'] : ''}`} ref={ref}>
      <button
        className={styles['mdw-trigger']}
        type="button"
        ref={triggerRef}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <span className={styles['mdw-value']}>{displayValue || `— ${placeholder || t('settings.api.selectModel')} —`}</span>
        <span className={styles['mdw-arrow']}>▾</span>
      </button>
      {open && createPortal(<div
        className={`${styles['mdw-popup']} ${styles['open']} ${styles['mdw-popup-fixed']}`}
        ref={panelRef}
        style={panelStyle}
        data-mdw-popup
      >
        <input
          ref={searchRef}
          className={styles['mdw-search']}
          type="text"
          placeholder={t('settings.api.searchModel')}
          spellCheck={false}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
        <div className={styles['mdw-options']}>
          {allowClear && valueKey && (
            <button
              className={`${styles['mdw-option']} ${styles['mdw-clear-option']}`}
              type="button"
              onClick={handleClear}
            >
              <span className={styles['mdw-option-name']}>{clearLabel || t('settings.api.clearModel')}</span>
            </button>
          )}
          {Object.entries(grouped).length === 0 && (
            <div className={styles['mdw-empty']}>{t('settings.api.noModels')}</div>
          )}
          {Object.entries(grouped).map(([provider, items]) => (
            <div key={provider || '__none'}>
              {provider && <div className={styles['mdw-group-header']}>{provider}</div>}
              {items.map(m => (
                <button
                  key={`${m.provider}/${m.id}`}
                  className={`${styles['mdw-option']}${`${m.provider}/${m.id}` === valueKey ? ' ' + styles['selected'] : ''}`}
                  type="button"
                  onClick={() => { onSelect({ id: m.id, provider: m.provider }); setOpen(false); }}
                >
                  <span className={styles['mdw-option-name']}>{m.name || m.id}</span>
                  {m.contextWindow && formatContext && (
                    <span className={styles['mdw-option-ctx']}>{formatContext(m.contextWindow)}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
          <div className={styles['mdw-custom-row']}>
            <input
              type="text"
              className={styles['mdw-custom-input']}
              placeholder={t('settings.api.customInput') + ' (provider/id)'}
              spellCheck={false}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomSubmit();
                e.stopPropagation();
              }}
            />
            <button
              type="button"
              className={styles['mdw-custom-confirm']}
              onClick={(e) => { e.stopPropagation(); handleCustomSubmit(); }}
            >
              →
            </button>
          </div>
        </div>
      </div>, document.body)}
    </div>
  );
}
