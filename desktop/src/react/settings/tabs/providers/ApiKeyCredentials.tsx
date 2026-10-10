import React, { useState, useEffect } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { codiaFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t, API_FORMAT_OPTIONS } from '../../helpers';
import { SelectWidget } from '../../widgets/SelectWidget';
import { KeyInput } from '../../widgets/KeyInput';
import { getApiKeySavePlan } from './api-key-save-plan';
import { isMaskedSecretValue, MASKED_SECRET } from '../../../../../../shared/secret-custody.ts';
import { isRuntimeApiKeyRef } from '../../../../../../shared/runtime-api-key-ref.ts';
import { parseProviderHeaderLines, ProviderHeadersField, serializeProviderHeaders } from './ProviderHeadersField';
import styles from '../../Settings.module.css';

const platform = window.platform;

interface DiscoveredProviderModel {
  id?: unknown;
  name?: unknown;
  context?: unknown;
  maxOutput?: unknown;
}

function shouldDiscoverModelsBeforeSave(providerId: string, api: string, payload: Record<string, unknown>) {
  return payload.seed_default_models === true
    && (providerId === 'gemini' || api === 'google-generative-ai');
}

function compactDiscoveredModel(model: DiscoveredProviderModel): string | Record<string, unknown> | null {
  if (typeof model.id !== 'string' || !model.id.trim()) return null;
  const entry: Record<string, unknown> = { id: model.id };
  if (typeof model.name === 'string' && model.name.trim()) entry.name = model.name;
  if (typeof model.context === 'number' && Number.isFinite(model.context)) entry.context = model.context;
  if (typeof model.maxOutput === 'number' && Number.isFinite(model.maxOutput)) entry.maxOutput = model.maxOutput;
  return Object.keys(entry).length === 1 ? model.id : entry;
}

async function resolveModelsForInitialSave(
  providerId: string,
  plan: ReturnType<typeof getApiKeySavePlan>,
  headers: Record<string, string>,
  includeHeaders: boolean,
): Promise<Record<string, unknown>> {
  const payload = { ...plan.payload };
  if (includeHeaders) payload.headers = headers;
  if (!shouldDiscoverModelsBeforeSave(providerId, plan.api, payload)) return payload;

  try {
    const res = await codiaFetch('/api/providers/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: providerId,
        base_url: plan.effectiveUrl,
        api: plan.api,
        api_key: plan.key,
        headers,
      }),
    });
    const data = await res.json();
    const models = Array.isArray(data.models)
      ? data.models.map(compactDiscoveredModel).filter(Boolean)
      : [];
    if (!data.error && models.length > 0) {
      payload.models = models;
      delete payload.seed_default_models;
    }
  } catch {
    // 保留 seed_default_models，作为首次配置时的静态兜底。
  }

  return payload;
}

export function ApiKeyCredentials({ providerId, summary, providerConfig: _providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: Record<string, unknown>;
  isPresetSetup?: boolean;
  presetInfo?: { label: string; value: string; url?: string; api?: string; local?: boolean };
  onRefresh: () => Promise<void>;
}) {
  const { showToast } = useSettingsStore();
  const [keyVal, setKeyVal] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const derivedBaseUrl = summary.base_url || presetInfo?.url || '';
  const [urlVal, setUrlVal] = useState(derivedBaseUrl);
  const [urlEdited, setUrlEdited] = useState(false);
  const [headersText, setHeadersText] = useState('');
  const [headersEdited, setHeadersEdited] = useState(false);
  const api = summary.api || presetInfo?.api || '';
  const shouldMaskSavedSecret = summary.auth_type !== 'none' && summary.has_credentials && !summary.api_key;
  const displayApiKey = isRuntimeApiKeyRef(summary.api_key) || isMaskedSecretValue(summary.api_key) || shouldMaskSavedSecret
    ? MASKED_SECRET
    : (summary.api_key || '');

 // 未编辑时，从 summary 同步已保存的 key 到输入框
  useEffect(() => {
    if (!keyEdited) {
      setKeyVal(displayApiKey);
    }
  }, [displayApiKey, keyEdited]);

 // 未编辑时，从 summary 同步 base_url
  useEffect(() => {
    if (!urlEdited) setUrlVal(derivedBaseUrl);
  }, [derivedBaseUrl, urlEdited]);

  useEffect(() => {
    if (!headersEdited) setHeadersText(serializeProviderHeaders(summary.headers || {}));
  }, [summary.headers, headersEdited]);

  const parseHeaders = (): Record<string, string> | null => {
    try {
      return parseProviderHeaderLines(headersText);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, 'error');
      return null;
    }
  };

  const saveApiKeyConfig = async ({
    verify,
    button,
  }: {
    verify: boolean;
    button?: HTMLButtonElement;
  }) => {
    const plan = getApiKeySavePlan({
      keyEdited,
      keyVal,
      urlEdited,
      urlVal,
      derivedBaseUrl,
      isPresetSetup: !!isPresetSetup,
      isLocalPreset: !!presetInfo?.local,
      seedDefaultModels: !!presetInfo && (summary.models?.length ?? 0) === 0,
      api,
    });
    if (!plan.shouldSave) return;
    button?.classList.add(styles['spinning']);
    try {
      const headers = parseHeaders();
      if (!headers) return;
      const includeHeaders = headersEdited || Object.keys(headers).length > 0;
      if (verify && plan.shouldVerify) {
        const testRes = await codiaFetch('/api/providers/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: providerId, base_url: plan.effectiveUrl, api: plan.api, api_key: plan.key, headers }),
        });
        const testData = await testRes.json();
        if (!testData.ok) {
          showToast(t('settings.providers.verifyFailed'), 'error');
          return;
        }
      }
      const payload = await resolveModelsForInitialSave(providerId, plan, headers, includeHeaders);
      await codiaFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: payload } }),
      });
      invalidateConfigCache();
      showToast(verify && plan.shouldVerify ? t('settings.providers.verifySuccess') : t('settings.saved'), 'success');
      if (isPresetSetup) useSettingsStore.setState({ selectedProviderId: providerId });
      setKeyEdited(false);
      if (urlEdited) setUrlEdited(false);
      if (headersEdited) setHeadersEdited(false);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    } finally {
      button?.classList.remove(styles['spinning']);
    }
  };

  const [connStatus, setConnStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const revealSavedApiKey = async () => {
    const res = await codiaFetch(`/api/providers/${encodeURIComponent(providerId)}/api-key`);
    const data = await res.json();
    if (isRuntimeApiKeyRef(data.api_key) || isMaskedSecretValue(data.api_key)) return null;
    return typeof data.api_key === 'string' ? data.api_key : '';
  };

  const verifyOnly = async (btn: HTMLButtonElement) => {
    setConnStatus('testing');
    btn.classList.add(styles['spinning']);
    try {
      const headers = parseHeaders();
      if (!headers) return;
      const verifyApiKey = keyVal.trim();
      const testRes = await codiaFetch('/api/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: providerId,
          base_url: urlVal.trim() || derivedBaseUrl,
          api,
          api_key: verifyApiKey === MASKED_SECRET ? undefined : verifyApiKey || undefined,
          headers,
        }),
      });
      const testData = await testRes.json();
      setConnStatus(testData.ok ? 'ok' : 'fail');
      showToast(testData.ok ? t('settings.providers.verifySuccess') : t('settings.providers.verifyFailed'), testData.ok ? 'success' : 'error');
    } catch {
      setConnStatus('fail');
      showToast(t('settings.providers.verifyFailed'), 'error');
    } finally {
      btn.classList.remove(styles['spinning']);
    }
  };

  return (
    <div className={styles['pv-credentials']}>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.api.apiKey')}</span>
        <div className={styles['pv-cred-key-row']}>
          <KeyInput
            value={keyVal}
            onChange={(v) => { setKeyVal(v); setKeyEdited(true); setConnStatus('idle'); }}
            onBlur={() => {
              if (!keyEdited || isPresetSetup) return;
              void saveApiKeyConfig({ verify: false });
            }}
            onReveal={isMaskedSecretValue(keyVal) ? revealSavedApiKey : undefined}
            onRevealValue={(v) => { setKeyVal(v); setConnStatus('idle'); }}
            onRevealError={(err) => {
              const msg = err instanceof Error ? err.message : String(err);
              showToast(msg, 'error');
            }}
            placeholder={isPresetSetup ? t('settings.providers.setupHint') : ''}
          />
          <button type="button"
            className={`${styles['pv-cred-conn-icon']} ${styles[connStatus] || ''}`}
            title={t('settings.providers.verifyConnection')}
            onClick={(e) => {
              if (keyEdited) {
                void saveApiKeyConfig({ verify: true, button: e.currentTarget });
              } else {
                verifyOnly(e.currentTarget);
              }
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
        </div>
      </div>
      <div className={`${styles['pv-cred-row']} ${styles['pv-cred-row-top']}`}>
        <span className={styles['pv-cred-label']}>{t('settings.providers.headers')}</span>
        <div className={styles['pv-cred-url-row']}>
          <ProviderHeadersField
            value={headersText}
            onChange={(value) => { setHeadersText(value); setHeadersEdited(true); setConnStatus('idle'); }}
            onBlur={async () => {
              if (!headersEdited || isPresetSetup) return;
              const headers = parseHeaders();
              if (!headers) return;
              try {
                await codiaFetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ providers: { [providerId]: { headers } } }),
                });
                invalidateConfigCache();
                showToast(t('settings.saved'), 'success');
                setHeadersEdited(false);
                await onRefresh();
                platform?.settingsChanged?.('models-changed');
              } catch { /* swallow */ }
            }}
            readOnly={!!isPresetSetup}
          />
        </div>
      </div>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.providers.customUrl')}</span>
        <div className={styles['pv-cred-url-row']}>
          <input
            className={styles['settings-input']}
            type="text"
            value={urlVal}
            onChange={(e) => { setUrlVal(e.target.value); setUrlEdited(true); }}
            onBlur={async () => {
              if (!urlEdited || isPresetSetup) return;
              const trimmed = urlVal.trim();
              if (trimmed === derivedBaseUrl) { setUrlEdited(false); return; }
              try {
                await codiaFetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ providers: { [providerId]: { base_url: trimmed } } }),
                });
                invalidateConfigCache();
                showToast(t('settings.saved'), 'success');
                setUrlEdited(false);
                await onRefresh();
              } catch { /* swallow */ }
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            placeholder="https://api.example.com/v1"
            readOnly={!!isPresetSetup}
          />
        </div>
      </div>
      <div className={styles['pv-cred-row']}>
        <span className={styles['pv-cred-label']}>{t('settings.providers.apiType')}</span>
        <div className={styles['pv-cred-select-wrapper']}>
          <SelectWidget
            options={API_FORMAT_OPTIONS}
            value={api || ''}
            onChange={async (val) => {
              if (isPresetSetup) return;
              try {
                await codiaFetch('/api/config', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ providers: { [providerId]: { api: val } } }),
                });
                invalidateConfigCache();
                showToast(t('settings.saved'), 'success');
                await onRefresh();
              } catch { /* swallow */ }
            }}
            placeholder="API Format"
            disabled={!!isPresetSetup}
          />
        </div>
      </div>
    </div>
  );
}
