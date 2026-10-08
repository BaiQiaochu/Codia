import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { gsapFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t, formatContext, lookupModelMeta } from '../../helpers';
import { getErrorMessage, isModelDescriptor, type ModelDescriptor } from '../../shared-types';
import { inferModelKind, modelKindLabel, type ModelKind } from '../../model-kind';
import { ModelEditPanel } from './ModelEditPanel';
import { addFixedDropdownPositionListeners, computeFixedDropdownStyle } from '../../widgets/dropdown-position';
import styles from '../../Settings.module.css';

const platform = window.platform;

interface DiscoveredModel {
  id: string;
  name?: string;
  type?: string;
  context?: number | null;
  maxOutput?: number | null;
}

type CapabilityKind = 'image' | 'video' | 'reasoning';
type ModelKindFilter = ModelKind | 'all';

const MODEL_KIND_FILTERS: ModelKindFilter[] = ['all', 'chat', 'image', 'audio', 'music', 'video'];

function defaultModelKindFilter(providerId: string, summary: ProviderSummary): ModelKindFilter {
  const text = `${providerId} ${summary.display_name || ''}`.toLowerCase();
  if (/\u89c6\u9891|video|movie|t2v|i2v/.test(text)) return 'video';
  if (/\u56fe\u7247|\u56fe\u50cf|\u751f\u56fe|image|picture/.test(text)) return 'image';
  if (/\u8bed\u97f3|speech|voice|audio|tts|stt/.test(text)) return 'audio';
  if (/\u97f3\u4e50|music|song/.test(text)) return 'music';
  return 'all';
}

function modelKindFilterLabel(kind: ModelKindFilter) {
  return kind === 'all' ? '\u5168\u90e8' : modelKindLabel(kind);
}

function CapabilityIcon({ kind }: { kind: CapabilityKind }) {
  const label = t(`settings.api.capability.${kind}`);
  return (
    <span className={styles['pv-capability-icon']} title={label} aria-label={label}>
      {kind === 'image' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      ) : kind === 'video' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="13" height="14" rx="2" />
          <path d="m16 9 5-3v12l-5-3" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12.74V16a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1.26A7 7 0 0 0 12 2Z" />
        </svg>
      )}
    </span>
  );
}

export function ProviderModelList({ providerId, summary, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const [search, setSearch] = useState('');
  const [customInput, setCustomInput] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [kindFilter, setKindFilter] = useState<ModelKindFilter>(() => defaultModelKindFilter(providerId, summary));
  const providerFilterSignature = `${providerId}\n${summary.display_name || ''}\n${summary.base_url || ''}`;
  const previousProviderFilterSignature = useRef(providerFilterSignature);

  useEffect(() => {
    if (previousProviderFilterSignature.current === providerFilterSignature) return;
    previousProviderFilterSignature.current = providerFilterSignature;
    setKindFilter(defaultModelKindFilter(providerId, summary));
    setSearch('');
    setCustomInput('');
  }, [providerFilterSignature, providerId, summary]);

  const loadDiscoveredModels = useCallback(async () => {
    try {
      const res = await gsapFetch(`/api/providers/${encodeURIComponent(providerId)}/discovered-models`);
      const data = await res.json();
      setDiscoveredModels(data.models || []);
    } catch {
      // cache miss is fine
    }
  }, [providerId]);

  useEffect(() => { loadDiscoveredModels(); }, [loadDiscoveredModels]);

  const rawModels = (summary.models || []) as Array<string | ModelDescriptor>;
  // Extract model IDs from mixed string/object entries.
  const modelId = (m: string | ModelDescriptor): string => isModelDescriptor(m) ? m.id : m;
  const rawModelEntry = (mid: string) => rawModels.find((m) => modelId(m) === mid);
  const discoveredModelEntry = (mid: string) => discoveredModels.find((m) => m.id === mid);
  const resolveModelKind = (mid: string, fallbackKind?: ModelKind): ModelKind => {
    const raw = rawModelEntry(mid);
    const discovered = discoveredModelEntry(mid);
    const meta = lookupModelMeta(mid, providerId);
    const explicit = isModelDescriptor(raw) ? raw.type : (discovered?.type || meta?.type);
    const inferred = inferModelKind(mid, providerId, explicit);
    return inferred === 'chat' && !explicit && fallbackKind ? fallbackKind : inferred;
  };
  const entryForModel = (mid: string): string | ModelDescriptor => {
    const kind = resolveModelKind(mid, kindFilter === 'all' ? undefined : kindFilter);
    return kind === 'chat' ? mid : { id: mid, type: kind };
  };
  const currentModelIds = rawModels.map(modelId);
  // Merge: discovered model IDs + custom_models, deduplicated, with currentModelIds included for display
  const discoveredIds = discoveredModels.map(m => m.id);
  const allModels = [...new Set([...currentModelIds, ...discoveredIds, ...(summary.custom_models || [])])];
  const query = search.toLowerCase();
  const filteredByKind = kindFilter === 'all'
    ? allModels
    : allModels.filter(mid => resolveModelKind(mid) === kindFilter);
  const filtered = query ? filteredByKind.filter(m => m.toLowerCase().includes(query)) : filteredByKind;

  const addModelToProvider = async (mid: string) => {
    if (currentModelIds.includes(mid)) return;
    try {
      await gsapFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models: [...rawModels, entryForModel(mid)] } } }),
      });
      invalidateConfigCache();
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      showToast(getErrorMessage(err), 'error');
    }
  };

  const removeModelFromProvider = async (mid: string) => {
    try {
      const next = rawModels.filter((m) => modelId(m) !== mid);
      await gsapFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: { models: next } } }),
      });
      invalidateConfigCache();
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      showToast(getErrorMessage(err), 'error');
    }
  };

  const addCustomModel = async () => {
    const id = customInput.trim();
    if (!id) return;
    try {
      const kind = resolveModelKind(id);
      if (summary.supports_oauth) {
        const res = await gsapFetch(`/api/auth/oauth/${providerId}/custom-models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: id }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (kind !== 'chat') {
          await gsapFetch(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: kind }),
          });
        }
      } else {
        await gsapFetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ providers: { [providerId]: { models: [...rawModels, entryForModel(id)] } } }),
        });
        invalidateConfigCache();
      }
      setCustomInput('');
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
    }
  };

  const [fetchHint, setFetchHint] = useState<{ msg: string; ok: boolean } | null>(null);
  const fetchHintTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const showFetchHint = (msg: string, ok: boolean) => {
    if (fetchHintTimer.current) clearTimeout(fetchHintTimer.current);
    setFetchHint({ msg, ok });
    fetchHintTimer.current = setTimeout(() => setFetchHint(null), 2500);
  };

  const fetchFailureMessage = (reason?: unknown) => {
    const base = t('settings.providers.fetchFailed');
    const detail = typeof reason === 'string' ? reason.trim() : '';
    return detail ? `${base}: ${detail}` : base;
  };

  const fetchModels = async (btn: HTMLButtonElement | null) => {
    if (btn) btn.classList.add(styles['spinning']);
    try {
      const hasHeaders = Object.keys(summary.headers || {}).length > 0;
      const res = await gsapFetch('/api/providers/fetch-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: providerId,
          ...(summary.base_url ? { base_url: summary.base_url } : {}),
          ...(summary.api ? { api: summary.api } : {}),
          ...(summary.has_credentials && summary.api_key ? { api_key: summary.api_key } : {}),
          ...(hasHeaders ? { headers: summary.headers } : {}),
          ...(kindFilter !== 'all' ? { model_type: kindFilter } : {}),
        }),
      });
      const data = await res.json();
      if (data.error) { showFetchHint(fetchFailureMessage(data.error), false); return; }
      const models = (data.models || []) as DiscoveredModel[];
      if (models.length === 0) { showFetchHint(fetchFailureMessage(), false); return; }
      // Backend already cached the results; just refresh the dropdown
      setDiscoveredModels(models);
      setSearch('');
      setDropdownOpen(true);
      showFetchHint(t('settings.providers.fetchSuccess', { name: providerId, n: models.length }), true);
    } catch (err: unknown) {
      showFetchHint(fetchFailureMessage(getErrorMessage(err)), false);
    } finally {
      if (btn) btn.classList.remove(styles['spinning']);
    }
  };

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const updateDropdownPosition = useCallback(() => {
    if (!dropdownOpen || !triggerRef.current) return;
    setPanelStyle(computeFixedDropdownStyle(triggerRef.current, panelRef.current, {
      widthOffset: 80,
      minWidth: 240,
      preferredMaxHeight: 320,
      minHeight: 160,
      flipThreshold: 220,
    }));
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return;
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
  }, [dropdownOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const [editing, setEditing] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  return (
    <div className={styles['pv-models']}>
      {/* Added models list */}
      {currentModelIds.length > 0 && (
        <div className={styles['pv-fav-section']}>
          <div className={styles['pv-fav-title']}>
            {t('settings.api.addedModels')}
            <span className={styles['pv-models-count']}>{currentModelIds.length}</span>
          </div>
          <div className={styles['pv-fav-list']}>
            {currentModelIds.map(mid => {
              const meta = lookupModelMeta(mid, providerId);
              const kind = resolveModelKind(mid);
              return (
                <div key={mid} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={mid}>{meta?.displayName || meta?.name || mid}</span>
                  {kind !== 'chat' && (
                    <span className={`${styles['pv-model-kind-badge']} ${styles[`pv-model-kind-badge-${kind}`]}`}>
                      {modelKindLabel(kind)}
                    </span>
                  )}
                  {(meta?.displayName || meta?.name) && meta?.displayName !== mid && meta?.name !== mid && <span className={styles['pv-fav-item-id']}>{mid}</span>}
                  {meta?.image === true && <CapabilityIcon kind="image" />}
                  {meta?.video === true && <CapabilityIcon kind="video" />}
                  {meta?.reasoning === true && <CapabilityIcon kind="reasoning" />}
                  {meta?.context && <span className={styles['pv-model-ctx']}>{formatContext(meta.context)}</span>}
                  <div className={styles['pv-fav-item-actions']}>
                    <button type="button"
                      className={styles['pv-fav-item-edit']}
                      title={t('settings.api.editModel')}
                      onClick={(e) => setEditing({ id: mid, anchor: e.currentTarget })}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                    </button>
                    <button type="button" className={styles['pv-fav-item-remove']} onClick={() => removeModelFromProvider(mid)} title={t('settings.api.removeModel')}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {editing && (
            <ModelEditPanel modelId={editing.id} providerId={providerId} anchorEl={editing.anchor} onClose={() => setEditing(null)} onRefresh={onRefresh} />
          )}
        </div>
      )}

      {/* Add model dropdown + fetch button */}
      <div className={styles['pv-model-filter-row']} aria-label="model type filter">
        {MODEL_KIND_FILTERS.map(kind => (
          <button
            key={kind}
            type="button"
            className={`${styles['pv-model-filter-btn']}${kindFilter === kind ? ' ' + styles['active'] : ''}`}
            onClick={() => {
              setKindFilter(kind);
              setSearch('');
            }}
          >
            {modelKindFilterLabel(kind)}
          </button>
        ))}
      </div>
      <div className={styles['pv-models-action-row']}>
        <button type="button" ref={triggerRef} className={styles['pv-model-dropdown-trigger']} onClick={() => setDropdownOpen(true)}>
          <span>{t('settings.api.addModel')}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        <button type="button"
          className={styles['pv-fetch-btn-inline']}
          title={t('settings.providers.fetchModels')}
          onClick={(e) => fetchModels(e.currentTarget)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {t('settings.providers.fetchModels')}
        </button>
      </div>
      {fetchHint && <div className={`${styles['pv-fetch-hint']} ${fetchHint.ok ? styles['ok'] : styles['fail']}`}>{fetchHint.msg}</div>}
      {dropdownOpen && createPortal(
        <div
          className={styles['pv-model-dropdown-panel']}
          ref={panelRef}
          style={panelStyle}
          data-provider-model-dropdown="true"
        >
          <input
            className={styles['pv-model-dropdown-search']}
            type="text"
            placeholder={t('settings.api.searchModel')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className={styles['pv-model-dropdown-list']}>
            {filtered.map(mid => {
              const isAdded = currentModelIds.includes(mid);
              const meta = lookupModelMeta(mid, providerId);
              const discovered = discoveredModels.find(d => d.id === mid);
              const ctx = meta?.context || discovered?.context;
              const kind = resolveModelKind(mid);
              return (
                <button type="button"
                  key={mid}
                  className={`${styles['pv-model-dropdown-option']}${isAdded  ? ' ' + styles['added'] : ''}`}
                  onClick={() => { if (!isAdded) { addModelToProvider(mid); } }}
                >
                  <span className={styles['pv-model-dropdown-option-name']}>{mid}</span>
                  {kind !== 'chat' && (
                    <span className={`${styles['pv-model-kind-badge']} ${styles[`pv-model-kind-badge-${kind}`]}`}>
                      {modelKindLabel(kind)}
                    </span>
                  )}
                  {isAdded && <span className={styles['pv-model-dropdown-option-check']}>{'\u2713'}</span>}
                  {ctx && <span className={styles['pv-model-ctx']}>{formatContext(ctx)}</span>}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <div className={styles['pv-model-dropdown-empty']}>{t('settings.providers.noModels')}</div>
            )}
          </div>
          <div className={styles['pv-model-dropdown-custom']}>
            <input
              className={styles['pv-model-dropdown-custom-input']}
              type="text"
              placeholder={t('settings.oauth.customModelPlaceholder')}
              value={customInput}
              onChange={(e) => setCustomInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { addCustomModel(); } }}
            />
            <button type="button" className={styles['pv-model-add-btn']} onClick={addCustomModel}>{'\u21B5'}</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
