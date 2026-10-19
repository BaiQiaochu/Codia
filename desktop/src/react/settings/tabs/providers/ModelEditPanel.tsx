import { confirmModelPricing, modelPricingBinding, type ModelPricing } from '../../../../../../shared/model-pricing';
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
  const { showToast, providersSummary } = useSettingsStore();
  const meta = lookupModelMeta(modelId, providerId) || {};
  const [priceBinding] = useState(() => modelPricingBinding({ provider: providerId, id: modelId, api: meta.api || providersSummary?.[providerId]?.api || '', baseUrl: providersSummary?.[providerId]?.base_url || '' }));
  const [displayName, setDisplayName] = useState(meta.displayName || meta.name || '');
  const [ctxVal, setCtxVal] = useState(meta.context != null ? String(meta.context) : '');
  const [outVal, setOutVal] = useState(meta.maxOutput != null ? String(meta.maxOutput) : '');
  const [vision, setVision] = useState<boolean>(meta.image === true || (meta.image === undefined && meta.vision === true));
  const [video, setVideo] = useState<boolean>(meta?.video === true);
  const [reasoning, setReasoning] = useState<boolean>(meta?.reasoning === true);
  const [dirtyCapabilities, setDirtyCapabilities] = useState<Record<string, boolean>>({});
  const existingPricing = meta.pricing as ModelPricing | null | undefined;
  const [pricingEnabled, setPricingEnabled] = useState(!!existingPricing);
  const [priceInput, setPriceInput] = useState(existingPricing?.cost?.input != null ? String(existingPricing.cost.input) : '');
  const [priceOutput, setPriceOutput] = useState(existingPricing?.cost?.output != null ? String(existingPricing.cost.output) : '');
  const [priceCacheRead, setPriceCacheRead] = useState(existingPricing?.cost?.cacheRead != null ? String(existingPricing.cost.cacheRead) : '');
  const [priceCacheWrite, setPriceCacheWrite] = useState(existingPricing?.cost?.cacheWrite != null ? String(existingPricing.cost.cacheWrite) : '');
  const [priceSource, setPriceSource] = useState(existingPricing?.source || '');
  const [confirmedFree, setConfirmedFree] = useState(existingPricing?.confirmedFree === true);
  const [pricingConfirmed, setPricingConfirmed] = useState(false);
  const [pricingDirty, setPricingDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  const [error, setError] = useState('');
  const changePrice = (setter: (value: string) => void, value: string) => { setter(value); setPricingDirty(true); setPricingConfirmed(false); };
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  useEffect(() => {
    setStyle({
      position: 'fixed',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 9999,
      width: 480, maxWidth: '95vw', maxHeight: '85vh', overflowY: 'auto',
    });
  }, [anchorEl]);

  const save = async () => {
    if (savingRef.current) return;
    setError('');
    const entry: Record<string, unknown> = {};
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
      if ((ctx && (!Number.isSafeInteger(Number(ctx)) || Number(ctx) <= 0)) || (maxOut && (!Number.isSafeInteger(Number(maxOut)) || Number(maxOut) <= 0))) throw new Error('上下文和输出上限必须为正整数');
      if (pricingDirty) {
        if (!pricingEnabled) entry.pricing = null;
        else {
          const payload = { expectedBinding: priceBinding, currency: 'USD', unit: 'per-million-tokens', source: priceSource, confirmed: pricingConfirmed, confirmedFree,
            cost: { input: priceInput.trim() ? Number(priceInput) : null, output: priceOutput.trim() ? Number(priceOutput) : null,
              cacheRead: priceCacheRead.trim() ? Number(priceCacheRead) : null, cacheWrite: priceCacheWrite.trim() ? Number(priceCacheWrite) : null } };
          confirmModelPricing(payload, priceBinding);
          entry.pricing = payload;
        }
      }
      savingRef.current = true; setSaving(true);
      await codiaFetch(`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      showToast(t('settings.saved'), 'success');
      platform?.settingsChanged?.('model-metadata-changed', { providerId, modelId });
      await onRefresh?.();
      if (mountedRef.current) onClose();
    } catch (err: unknown) {
      if (mountedRef.current) setError(getErrorMessage(err));
      showToast(t('settings.saveFailed') + ': ' + getErrorMessage(err), 'error');
    } finally { savingRef.current = false; if (mountedRef.current) setSaving(false); }
  };

  return (
    <>
      <div className={styles['pv-model-edit-overlay']} onClick={() => { if (!saving) onClose(); }} />
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
        <fieldset disabled={saving} style={{ marginTop: 12, border: '1px solid var(--border-color, #777)', borderRadius: 6, padding: 10 }}>
          <legend>本地价格估算（USD / 百万 token）</legend>
          <label><input type="checkbox" checked={pricingEnabled} onChange={e => { setPricingEnabled(e.target.checked); setPricingDirty(true); setPricingConfirmed(false); }} />配置当前模型价格</label>
          <p style={{ fontSize: 12 }}>空白表示未知，不按免费计算。价格只用于本地估算，不保证供应商账单上限。端点、协议或模型变更后需重新确认。</p>
          <p style={{ fontSize: 12, overflowWrap: 'anywhere' }}>当前绑定：{priceBinding.api || '协议未知'} · {priceBinding.baseUrl || '端点未知'}</p>
          {existingPricing?.confirmedAt && <p style={{ fontSize: 12 }}>上次确认：{existingPricing.confirmedAt}{existingPricing.invalidatedAt ? '（已失效，请重新确认）' : ''}</p>}
          {pricingEnabled && <>
            {([
              ['输入价格', priceInput, setPriceInput], ['输出价格', priceOutput, setPriceOutput],
              ['缓存读取价格（可空）', priceCacheRead, setPriceCacheRead], ['缓存写入价格（可空）', priceCacheWrite, setPriceCacheWrite],
            ] as const).map(([label, value, setter]) => <label key={label} className={styles['pv-model-edit-field']}>{label}<input className={styles['settings-input']} type="number" min="0" step="any" value={value} onChange={e => changePrice(setter, e.target.value)} /></label>)}
            <label className={styles['pv-model-edit-field']}>价格来源说明<input className={styles['settings-input']} value={priceSource} maxLength={500} onChange={e => changePrice(setPriceSource, e.target.value)} placeholder="例如供应商价格页及查询日期" /></label>
            <label style={{ display: 'block' }}><input type="checkbox" checked={confirmedFree} onChange={e => { setConfirmedFree(e.target.checked); setPricingDirty(true); setPricingConfirmed(false); }} />明确确认全部 token 与缓存免费（四项必须为 0）</label>
            <label style={{ display: 'block' }}><input type="checkbox" checked={pricingConfirmed} onChange={e => { setPricingConfirmed(e.target.checked); setPricingDirty(true); }} />我已核对以上价格及当前模型/端点</label>
          </>}
        </fieldset>
        {error && <p role="alert" style={{ color: 'var(--danger-color, #dc4b4b)' }}>{error}</p>}
        <div className={styles['pv-model-edit-actions']}>
          <button type="button" className={styles['pv-add-form-btn']} disabled={saving} onClick={onClose}>{t('settings.api.cancel')}</button>
          <button type="button" className={`${styles['pv-add-form-btn']} ${styles['primary']}`} disabled={saving} onClick={save}>{saving ? '保存中…' : t('settings.api.save')}</button>
        </div>
      </div>
    </>
  );
}
