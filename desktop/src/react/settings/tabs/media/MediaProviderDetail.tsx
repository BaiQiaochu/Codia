import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from '../../store';
import { gsapFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t } from '../../helpers';
import { getErrorMessage, type ImageGenConfigPayload, type ImageProviderDefaults } from '../../shared-types';
import { addFixedDropdownPositionListeners, computeFixedDropdownStyle } from '../../widgets/dropdown-position';
import type { MediaType } from './media-default-models';
import styles from '../../Settings.module.css';

const platform = window.platform;

interface MediaModelItem {
  id: string;
  name: string;
  type?: string;
  protocolId?: string;
  credentialLaneId?: string;
}

interface Props {
  providerId: string;
  mediaType?: MediaType;
  provider: {
    displayName?: string;
    hasCredentials: boolean;
    baseUrl?: string;
    api?: string;
    isLocalOpenAICompatible?: boolean;
    models: MediaModelItem[];
    availableModels: MediaModelItem[];
    imageModels?: MediaModelItem[];
    audioModels?: MediaModelItem[];
    musicModels?: MediaModelItem[];
    videoModels?: MediaModelItem[];
    availableImageModels?: MediaModelItem[];
    availableAudioModels?: MediaModelItem[];
    availableMusicModels?: MediaModelItem[];
    availableVideoModels?: MediaModelItem[];
  };
  config: ImageGenConfigPayload;
  onSaveConfig: (updates: Partial<ImageGenConfigPayload>) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const MEDIA_TYPE_LABELS: Record<MediaType, {
  defaultModelKey: 'defaultImageModel' | 'defaultAudioModel' | 'defaultMusicModel' | 'defaultVideoModel';
  modelLabelKey: string;
  addLabelKey: string;
}> = {
  image: {
    defaultModelKey: 'defaultImageModel',
    modelLabelKey: 'settings.media.imageModels',
    addLabelKey: 'settings.media.addImageModel',
  },
  audio: {
    defaultModelKey: 'defaultAudioModel',
    modelLabelKey: 'settings.media.audioModels',
    addLabelKey: 'settings.media.addAudioModel',
  },
  music: {
    defaultModelKey: 'defaultMusicModel',
    modelLabelKey: 'settings.media.musicModels',
    addLabelKey: 'settings.media.addMusicModel',
  },
  video: {
    defaultModelKey: 'defaultVideoModel',
    modelLabelKey: 'settings.media.videoModels',
    addLabelKey: 'settings.media.addVideoModel',
  },
};

function mediaModelKey(type: MediaType, model: MediaModelItem) {
  return `${type}:${model.id}`;
}

function modelsForType(provider: Props['provider'], type: MediaType) {
  if (type === 'audio') return provider.audioModels || [];
  if (type === 'music') return provider.musicModels || [];
  if (type === 'video') return provider.videoModels || [];
  return provider.imageModels || [];
}

function availableModelsForType(provider: Props['provider'], type: MediaType) {
  if (type === 'audio') return provider.availableAudioModels || [];
  if (type === 'music') return provider.availableMusicModels || [];
  if (type === 'video') return provider.availableVideoModels || [];
  return provider.availableImageModels || provider.availableModels || [];
}

export function MediaProviderDetail({ providerId, mediaType = 'image', provider, config, onSaveConfig, onRefresh }: Props) {
  const { showToast } = useSettingsStore();
  const defaults = config.providerDefaults?.[providerId] || {};
  const typeLabels = MEDIA_TYPE_LABELS[mediaType];
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const activeModels = modelsForType(provider, mediaType);
  const availableModels = availableModelsForType(provider, mediaType);
  const hasActiveModels = activeModels.length > 0;

  const isDefault = (modelId: string) => {
    const defaultModel = config[typeLabels.defaultModelKey];
    return defaultModel?.id === modelId && defaultModel?.provider === providerId;
  };

  const updateDefault = (key: keyof ImageProviderDefaults, value: ImageProviderDefaults[keyof ImageProviderDefaults]) => {
    const current = config.providerDefaults || {};
    const provDefaults = { ...current[providerId], [key]: value };
    onSaveConfig({ providerDefaults: { ...current, [providerId]: provDefaults } });
  };

  const addModel = async (modelId: string) => {
    try {
      const candidate = [...activeModels, ...availableModels]
        .find(model => model.id === modelId) || { id: modelId, type: mediaType };
      if (mediaType === 'image') {
        await gsapFetch(`/api/plugins/image-gen/providers/${encodeURIComponent(providerId)}/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: candidate }),
        });
      } else {
        await gsapFetch(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: mediaType }),
        });
      }
      invalidateConfigCache();
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      showToast(getErrorMessage(err) || 'Failed', 'error');
    }
  };

  const removeModel = async (modelId: string) => {
    try {
      if (mediaType === 'image') {
        await gsapFetch(`/api/plugins/image-gen/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
          method: 'DELETE',
        });
      } else {
        await gsapFetch(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}?type=${mediaType}`, {
          method: 'DELETE',
        });
      }
      invalidateConfigCache();
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      showToast(getErrorMessage(err) || 'Failed', 'error');
    }
  };

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!dropdownOpen || !trigger) return;
    setPanelStyle(computeFixedDropdownStyle(trigger, panelRef.current, {
      widthOffset: 120,
      minWidth: 240,
      preferredMaxHeight: 300,
      minHeight: 140,
      flipThreshold: 220,
    }));
  }, [dropdownOpen]);

  useEffect(() => {
    if (!dropdownOpen) return undefined;
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
    if (!dropdownOpen) return undefined;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  const addedKeys = new Set(activeModels.map(model => mediaModelKey(mediaType, model)));
  const seen = new Set<string>();
  const dropdownModels = [...activeModels, ...availableModels].filter((model) => {
    const key = mediaModelKey(mediaType, model);
    if (!model?.id || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const query = search.toLowerCase();
  const filtered = query
    ? dropdownModels.filter(m => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query))
    : dropdownModels;
  const customModelId = search.trim();
  const customModelKey = customModelId.toLowerCase();
  const hasExactModel = customModelId
    ? dropdownModels.some(m => m.id.toLowerCase() === customModelKey)
    : false;
  const canAddCustomModel = !!customModelId && !hasExactModel;
  const addCustomModel = async () => {
    if (!canAddCustomModel) return;
    await addModel(customModelId);
    setSearch('');
    setDropdownOpen(false);
  };

  const renderSelectDefault = (
    labelKey: string,
    key: keyof ImageProviderDefaults,
    options: { value: string; label: string }[],
  ) => (
    <div className={styles['media-provider-default-field']}>
      <span className={styles['media-provider-default-label']}>
        {t(labelKey)}
      </span>
      <select
        className={styles['media-provider-default-control']}
        value={String(defaults[key] || '')}
        onChange={(e) => updateDefault(key, e.target.value || undefined)}
      >
        <option value="">{t('settings.media.default')}</option>
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );

  const renderTextDefault = (labelKey: string, key: keyof ImageProviderDefaults, placeholder = '') => (
    <div className={styles['media-provider-default-field']}>
      <span className={styles['media-provider-default-label']}>
        {t(labelKey)}
      </span>
      <input
        className={styles['media-provider-default-control']}
        defaultValue={String(defaults[key] || '')}
        placeholder={placeholder}
        onBlur={(e) => updateDefault(key, e.target.value.trim() || undefined)}
      />
    </div>
  );

  const renderBooleanDefault = (labelKey: string, key: keyof ImageProviderDefaults) => (
    <label className={`${styles['media-provider-default-field']} ${styles['media-provider-default-toggle']}`}>
      <input
        type="checkbox"
        checked={Boolean(defaults[key])}
        onChange={(e) => updateDefault(key, e.target.checked)}
      />
      <span className={styles['media-provider-default-label']}>
        {t(labelKey)}
      </span>
    </label>
  );

  const renderProviderDefaults = () => {
    if (mediaType === 'audio') {
      return (
        <>
          {renderTextDefault('settings.media.voiceId', 'voice_id')}
          {renderSelectDefault('settings.media.audioFormat', 'audioFormat', [
            { value: 'mp3', label: 'MP3' },
            { value: 'wav', label: 'WAV' },
            { value: 'flac', label: 'FLAC' },
            { value: 'aac', label: 'AAC' },
          ])}
          {renderSelectDefault('settings.media.audioResponseFormat', 'audioResponseFormat', [
            { value: 'hex', label: 'hex' },
            { value: 'url', label: 'URL' },
          ])}
          {providerId === 'minimax' && renderTextDefault('settings.media.mediaBaseUrl', 'mediaBaseUrl', 'https://api.minimax.io')}
        </>
      );
    }
    if (mediaType === 'music') {
      return (
        <>
          {renderSelectDefault('settings.media.musicFormat', 'musicFormat', [
            { value: 'mp3', label: 'MP3' },
            { value: 'wav', label: 'WAV' },
            { value: 'flac', label: 'FLAC' },
            { value: 'aac', label: 'AAC' },
          ])}
          {renderSelectDefault('settings.media.musicResponseFormat', 'musicResponseFormat', [
            { value: 'url', label: 'URL' },
            { value: 'hex', label: 'hex' },
          ])}
          {providerId === 'minimax' && renderTextDefault('settings.media.mediaBaseUrl', 'mediaBaseUrl', 'https://api.minimax.io')}
        </>
      );
    }
    if (mediaType === 'video') {
      return (
        <>
          {renderSelectDefault('settings.media.videoDuration', 'videoDuration', [
            { value: '5', label: '5s' },
            { value: '10', label: '10s' },
            { value: '15', label: '15s' },
          ])}
          {renderSelectDefault('settings.media.aspectRatio', 'aspect_ratio', [
            { value: '1:1', label: '1:1' },
            { value: '4:3', label: '4:3' },
            { value: '3:4', label: '3:4' },
            { value: '16:9', label: '16:9' },
            { value: '9:16', label: '9:16' },
            { value: '21:9', label: '21:9' },
          ])}
          {renderBooleanDefault('settings.media.generateAudio', 'generateAudio')}
          {renderBooleanDefault('settings.media.watermark', 'watermark')}
        </>
      );
    }
    return (
      <>
        {renderSelectDefault('settings.media.size', 'size', [
          { value: 'square', label: 'square' },
          { value: 'landscape', label: 'landscape' },
          { value: 'portrait', label: 'portrait' },
          { value: '1024x1024', label: '1024x1024' },
          { value: '1536x1024', label: '1536x1024' },
          { value: '1024x1536', label: '1024x1536' },
          { value: '2K', label: '2K' },
          { value: '4K', label: '4K' },
        ])}
        {renderSelectDefault('settings.media.aspectRatio', 'aspect_ratio', [
          { value: '1:1', label: '1:1' },
          { value: '4:3', label: '4:3' },
          { value: '3:4', label: '3:4' },
          { value: '16:9', label: '16:9' },
          { value: '9:16', label: '9:16' },
          { value: '3:2', label: '3:2' },
          { value: '2:3', label: '2:3' },
          { value: '21:9', label: '21:9' },
        ])}
        {renderSelectDefault('settings.media.format', 'format', [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
        ])}
        {renderSelectDefault('settings.media.quality', 'quality', [
          { value: 'low', label: t('settings.media.qualityLow') },
          { value: 'medium', label: t('settings.media.qualityMedium') },
          { value: 'high', label: t('settings.media.qualityHigh') },
        ])}
        {providerId === 'comfyui' && renderTextDefault('settings.media.baseUrl', 'baseUrl', 'http://127.0.0.1:8188')}
        {providerId === 'comfyui' && renderTextDefault('settings.media.workflowPath', 'workflowPath', 'E:\\ComfyUI\\workflow.json')}
      </>
    );
  };

  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{provider.displayName || providerId}</h2>
      </div>

      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 'var(--space-md)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: provider.hasCredentials ? 'var(--success)' : 'var(--text-muted)',
          display: 'inline-block',
        }} />
        {provider.hasCredentials ? t('settings.media.credentialOk') : t('settings.media.credentialMissing')}
      </div>

      <div className={styles['pv-models']}>
        <div className={styles['pv-fav-section']}>
          <div className={styles['pv-fav-title']}>
            {t(typeLabels.modelLabelKey)}
            <span className={styles['pv-models-count']}>{activeModels.length}</span>
          </div>

          {activeModels.length > 0 && (
            <div className={styles['pv-fav-list']}>
              {activeModels.map(m => (
                <div key={m.id} className={styles['pv-fav-item']}>
                  <span className={styles['pv-fav-item-name']} title={m.id}>{m.name || m.id}</span>
                  <span className={styles['pv-fav-item-id']}>{m.id}</span>
                  {isDefault(m.id) && (
                    <span style={{
                      fontSize: '0.6rem', color: 'var(--accent)',
                      background: 'var(--accent-light)', padding: '1px 6px',
                      borderRadius: '4px', fontWeight: 500, flexShrink: 0,
                    }}>
                      {t('settings.media.default')}
                    </span>
                  )}
                  <div className={styles['pv-fav-item-actions']}>
                    <button type="button" className={styles['pv-fav-item-remove']} onClick={() => removeModel(m.id)} title={t('settings.api.removeModel')}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className={styles['pv-models-action-row']}>
            <button
              type="button"
              ref={triggerRef}
              className={styles['pv-model-dropdown-trigger']}
              onClick={() => {
                setSearch('');
                setDropdownOpen(open => !open);
              }}
            >
              <span>{t(typeLabels.addLabelKey)}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
          </div>

          {dropdownOpen && createPortal(
            <div className={styles['pv-model-dropdown-panel']} ref={panelRef} style={panelStyle}>
              <input
                className={styles['pv-model-dropdown-search']}
                type="text"
                placeholder={t('settings.api.searchModel')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || !canAddCustomModel) return;
                  e.preventDefault();
                  void addCustomModel();
                }}
                autoFocus
              />
              <div className={styles['pv-model-dropdown-list']}>
                {filtered.map(m => {
                  const isAdded = addedKeys.has(mediaModelKey(mediaType, m));
                  return (
                    <button
                      type="button"
                      key={`${mediaType}:${m.id}`}
                      className={`${styles['pv-model-dropdown-option']}${isAdded ? ' ' + styles['added'] : ''}`}
                      onClick={() => { if (!isAdded) addModel(m.id); }}
                    >
                      <span className={styles['pv-model-dropdown-option-name']}>{m.name || m.id}</span>
                      {isAdded && <span className={styles['pv-model-dropdown-option-check']}>{'\u2713'}</span>}
                    </button>
                  );
                })}
                {canAddCustomModel && (
                  <button
                    type="button"
                    className={styles['pv-model-dropdown-option']}
                    onClick={() => { void addCustomModel(); }}
                  >
                    <span className={styles['pv-model-dropdown-option-name']}>
                      {t('settings.api.addModel')}: {customModelId}
                    </span>
                  </button>
                )}
                {filtered.length === 0 && !canAddCustomModel && (
                  <div className={styles['pv-model-dropdown-empty']}>{t('settings.providers.noModels')}</div>
                )}
              </div>
            </div>,
            document.body,
          )}
        </div>

        {!hasActiveModels && mediaType === 'image' && provider.isLocalOpenAICompatible && (
          <div style={{ marginTop: '10px', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {t('settings.media.noModelsHint')}
          </div>
        )}
      </div>

      {hasActiveModels && (
        <div className={styles['media-provider-defaults']}>
          <div className={styles['media-provider-defaults-title']}>
            {t('settings.media.providerDefaults')}
          </div>
          <div className={styles['media-provider-defaults-grid']}>
            {renderProviderDefaults()}
          </div>
        </div>
      )}
    </div>
  );
}
