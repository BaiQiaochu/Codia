import React, { useState, useEffect, useRef } from 'react';
import { useSettingsStore } from '../../store';
import { t, lookupModelMeta, CONTEXT_PRESETS, OUTPUT_PRESETS } from '../../helpers';
import { codiaFetch } from '../../api';
import { getErrorMessage } from '../../shared-types';
import { ComboInput } from '../../widgets/ComboInput';
import { Toggle } from '../../widgets/Toggle';
import styles from '../../Settings.module.css';

const platform = window.platform;

export function ModelEditPanel({ modelId, providerId, anchorEl, onClose, onRefresh }: {
  modelId: string;
  providerId: string;
  anchorEl: HTMLElement | null;
  onClose: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const meta = lookupModelMeta(modelId, providerId) || {};
  const [displayName, setDisplayName] = useState(meta.displayName || meta.name || '');
  const [ctxVal, setCtxVal] = useState(meta.context != null ? String(meta.context) : '');
  const [outVal, setOutVal] = useState(meta.maxOutput != null ? String(meta.maxOutput) : '');
  const [vision, setVision] = useState<boolean>(meta.image === true || (meta.image === undefined && meta.vision === true));
  const [video, setVideo] = useState<boolean>(meta?.video === true);
  const [reasoning, setReasoning] = useState<boolean>(meta?.reasoning === true);
  const [dirtyCapabilities, setDirtyCapabilities] = useState<Record<string, boolean>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    setStyle({
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      width: 360,
    });
  }, [anchorEl]);

  const save = async () => {
    const entry: Record<string, string | number | boolean> = {};
    const name = displayName.trim();
    const ctx = ctxVal.trim();
    const maxOut = outVal.trim();
    if (name) entry.name = name;
    if (ctx) entry.context = parseInt(ctx);
    if (maxOut) entry.maxOutput = parseInt(maxOut);
    if (dirtyCapabilities.image) entry.image = vision;
    if (dirtyCapabilities.video) entry.video = video;
    if (dirtyCapabilities.reasoning) entry.reasoning = reasoning;

    try {
      await codiaFetch(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      showToast(t('settings.saved'), 'success');
      platform?.settingsChanged?.('model-metadata-changed', { providerId, modelId });
      await onRefresh?.();
      onClose();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + getErrorMessage(err), 'error');
    }
  };

  return (
    <>
      <div className={styles['pv-model-edit-overlay']} onClick={onClose} />
      <div ref={panelRef} className={styles['pv-model-edit-card']} style={style}>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>ID</label>
          <span className={styles['pv-model-edit-id']}>{modelId}</span>
        </div>
        <div className={styles['pv-model-edit-field']}>
          <label className={styles['pv-model-edit-label']}>{t('settings.api.displayName')}</label>
          <input
            className={styles['settings-input']}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={modelId}
          />
        </div>
        <div className={styles['pv-model-edit-row']}>
          <div className={styles['pv-model-edit-field']}>
            <label className={styles['pv-model-edit-label']}>{t('settings.api.contextLength')}</label>
            <ComboInput presets={CONTEXT_PRESETS} value={ctxVal} onChange={setCtxVal} placeholder="131072" />
          </div>
          <div className={styles['pv-model-edit-field']}>
            <label className={styles['pv-model-edit-label']}>{t('settings.api.maxOutput')}</label>
            <ComboInput presets={OUTPUT_PRESETS} value={outVal} onChange={setOutVal} placeholder="16384" />
          </div>
        </div>
        <div className={styles['pv-model-edit-row']}>
          <div className={styles['pv-model-edit-field']}>
            <label className={styles['pv-model-edit-label']}>{t('settings.api.vision')}</label>
            <Toggle on={vision} onChange={(value) => { setVision(value); setDirtyCapabilities(prev => ({ ...prev, image: true })); }} />
          </div>
          <div className={styles['pv-model-edit-field']}>
            <label className={styles['pv-model-edit-label']}>{t('settings.api.video')}</label>
            <Toggle on={video} onChange={(value) => { setVideo(value); setDirtyCapabilities(prev => ({ ...prev, video: true })); }} />
          </div>
          <div className={styles['pv-model-edit-field']}>
            <label className={styles['pv-model-edit-label']}>{t('settings.api.reasoning')}</label>
            <Toggle on={reasoning} onChange={(value) => { setReasoning(value); setDirtyCapabilities(prev => ({ ...prev, reasoning: true })); }} />
          </div>
        </div>
        <div className={styles['pv-model-edit-actions']}>
          <button type="button" className={styles['pv-add-form-btn']} onClick={onClose}>{t('settings.api.cancel')}</button>
          <button type="button" className={`${styles['pv-add-form-btn']} ${styles['primary']}`} onClick={save}>{t('settings.api.save')}</button>
        </div>
      </div>
    </>
  );
}
