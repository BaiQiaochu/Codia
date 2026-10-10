import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store';
import { codiaFetch } from '../../api';
import {
  t, lookupModelMeta, formatContext, autoSaveGlobalModels,
} from '../../helpers';
import { loadSettingsConfig } from '../../actions';
import { getErrorMessage, isModelDescriptor } from '../../shared-types';
import { SelectWidget } from '../../widgets/SelectWidget';
import { ModelWidget } from '../../widgets/ModelWidget';
import { KeyInput } from '../../widgets/KeyInput';
import { Toggle } from '../../widgets/Toggle';
import { modelSupportsImageInput } from '../../../utils/model-capabilities';
import styles from '../../Settings.module.css';
import {
  ANYSEARCH_PROVIDER,
  ANYSEARCH_FREE_PROVIDER,
  AUTO_SEARCH_PROVIDER,
  SEARCH_API_PROVIDER_IDS,
  isBrowserSearchProvider,
  isFreeSearchApiProvider,
  isFreeSearchProvider,
  isSearchApiProvider,
  normalizeSearchApiKeys,
} from '../../../../../../shared/search-providers.ts';

const SEARCH_API_PROVIDER_LABELS: Record<string, string> = {
  anysearch: 'AnySearch',
  tavily: 'Tavily',
  brave: 'Brave Search',
  serper: 'Serper (Google)',
};

function searchProviderNeedsApiKey(provider: string): boolean {
  return isSearchApiProvider(provider);
}

function ToolModelTestBtn({ modelRef }: { modelRef: unknown }) {
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

  const parsedRef = (() => {
    if (isModelDescriptor(modelRef)) {
      const id = modelRef.id.trim();
      if (!id) return null;
      return { id, provider: String(modelRef.provider || '') };
    }
    if (typeof modelRef === 'string') {
      const value = modelRef.trim();
      if (!value) return null;
      const slashIdx = value.indexOf('/');
      if (slashIdx > 0 && slashIdx < value.length - 1) {
        return {
          provider: value.slice(0, slashIdx),
          id: value.slice(slashIdx + 1),
        };
      }
      return { id: value, provider: '' };
    }
    return null;
  })();

  const test = async () => {
    if (!parsedRef) return;
    setStatus('testing');
    try {
      const res = await codiaFetch('/api/models/health', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: parsedRef.id, provider: parsedRef.provider }),
      });
      const data = await res.json();
      setStatus(data.ok ? 'ok' : 'fail');
    } catch {
      setStatus('fail');
    }
    setTimeout(() => setStatus('idle'), 3000);
  };

  if (!parsedRef) return null;

  return (
    <button type="button" className={`${styles['pv-tool-test-btn']} ${styles[status] || ''}`} onClick={test} disabled={status === 'testing'}>
      {status === 'testing' ? (
        <svg className={styles.spinning} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
          <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </svg>
      ) : status === 'ok' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : status === 'fail' ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )}
    </button>
  );
}

export function OtherModelsSection({ providers }: { providers: Record<string, unknown> }) {
  const { globalModelsConfig, showToast } = useSettingsStore();
  const savedSearchApiKeys = React.useMemo(
    () => normalizeSearchApiKeys(globalModelsConfig?.search?.api_keys || {}),
    [globalModelsConfig?.search?.api_keys],
  );
  const savedLegacySearchKey = globalModelsConfig?.search?.api_key || '';
  const [searchApiKeys, setSearchApiKeys] = useState<Record<string, string>>({});
  const [searchKeyEdited, setSearchKeyEdited] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setSearchApiKeys((prev) => {
      const next = { ...prev };
      for (const provider of SEARCH_API_PROVIDER_IDS) {
        if (searchKeyEdited[provider]) continue;
        const legacyForSelectedProvider = globalModelsConfig?.search?.provider === provider ? savedLegacySearchKey : '';
        next[provider] = savedSearchApiKeys[provider] || legacyForSelectedProvider || '';
      }
      return next;
    });
  }, [globalModelsConfig?.search?.provider, savedLegacySearchKey, savedSearchApiKeys, searchKeyEdited]);

  const searchProvider = globalModelsConfig?.search?.provider || AUTO_SEARCH_PROVIDER;
  const searchIsAutoProvider = searchProvider === AUTO_SEARCH_PROVIDER;
  const searchIsBrowserProvider = isBrowserSearchProvider(searchProvider);
  const searchIsKeylessProvider = searchIsBrowserProvider || isFreeSearchApiProvider(searchProvider);
  const explicitSearchApiProvider = searchProviderNeedsApiKey(searchProvider) ? searchProvider : '';

  const verifySearch = async (provider: string) => {
    const apiKey = (searchApiKeys[provider] || '').trim();
    if (!provider) { showToast(t('settings.search.noProvider'), 'error'); return; }
    if (searchProviderNeedsApiKey(provider) && !apiKey) { showToast(t('settings.search.noKey'), 'error'); return; }
    try {
      const res = await codiaFetch('/api/search/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey, search_provider: searchProvider }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(t('settings.search.verified'), 'success');
        setSearchKeyEdited((prev) => ({ ...prev, [provider]: false }));
        await loadSettingsConfig();
      } else {
        showToast(t('settings.search.verifyFailed') + (data.error ? ': ' + data.error : ''), 'error');
      }
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + getErrorMessage(err), 'error');
    }
  };

  const toModelRef = (raw: unknown): string => {
    if (!raw) return '';
    if (isModelDescriptor(raw)) {
      return raw.provider ? `${raw.provider}/${raw.id}` : raw.id;
    }
    return String(raw);
  };

  const utilityVal = toModelRef(globalModelsConfig?.models?.utility);
  const utilityLargeVal = toModelRef(globalModelsConfig?.models?.utility_large);
  const visionVal = toModelRef(globalModelsConfig?.models?.vision);
  const visionAuxiliaryEnabled = globalModelsConfig?.models?.vision_enabled === true;
  const imageCapableOnly = (model: { input?: string[]; image?: boolean; vision?: boolean }) => modelSupportsImageInput(model);
  const modelGridClass = `${styles['settings-form-grid']} ${styles['provider-model-grid']}`;
  const modelFieldClass = `${styles['settings-form-field']} ${styles['settings-form-field-half']} ${styles['provider-model-field']}`;
  const updateSearchApiKey = (provider: string, value: string) => {
    setSearchApiKeys((prev) => ({ ...prev, [provider]: value }));
    setSearchKeyEdited((prev) => ({ ...prev, [provider]: true }));
  };
  const renderSearchApiKeyRow = (provider: string) => (
    <div className={styles['search-api-key-row']} key={provider}>
      {searchIsAutoProvider && (
        <span className={styles['search-api-key-label']}>{SEARCH_API_PROVIDER_LABELS[provider] || provider}</span>
      )}
      <div className={styles['search-api-key-controls']}>
        <KeyInput
          value={searchApiKeys[provider] || ''}
          onChange={(v) => updateSearchApiKey(provider, v)}
          placeholder={t('settings.api.apiKeyPlaceholder')}
        />
        <button type="button" className={styles['search-verify-btn']} onClick={() => verifySearch(provider)}>
          {t('settings.search.verify')}
        </button>
      </div>
    </div>
  );

  return (
    <div className={styles['providers-other-models']}>
      <div className={modelGridClass}>
        <div className={modelFieldClass}>
          <label className={styles['settings-form-label']}>{t('settings.api.utilityModel')}</label>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              value={utilityVal}
              onSelect={(ref) => {
                if (ref === undefined) return;
                autoSaveGlobalModels({ models: { utility: ref } });
              }}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelRef={globalModelsConfig?.models?.utility || ''} />
          </div>
          <span className={styles['settings-form-hint']}>{t('settings.api.utilityModelHint')}</span>
        </div>
        <div className={modelFieldClass}>
          <label className={styles['settings-form-label']}>{t('settings.api.utilityLargeModel')}</label>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              value={utilityLargeVal}
              onSelect={(ref) => {
                if (ref === undefined) return;
                autoSaveGlobalModels({ models: { utility_large: ref } });
              }}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
            />
            <ToolModelTestBtn modelRef={globalModelsConfig?.models?.utility_large || ''} />
          </div>
          <span className={styles['settings-form-hint']}>{t('settings.api.utilityLargeModelHint')}</span>
        </div>
      </div>
      <div className={modelGridClass}>
        <div className={modelFieldClass}>
          <label className={styles['settings-form-label']}>{t('settings.api.visionModel')}</label>
          <div className={styles['settings-toggle-row']}>
            <Toggle
              on={visionAuxiliaryEnabled}
              onChange={(on) => {
                autoSaveGlobalModels({ models: { vision_enabled: on } });
              }}
              label={t('settings.api.visionAuxiliaryToggle')}
            />
          </div>
          <div className={styles['pv-tool-model-row']}>
            <ModelWidget
              providers={providers}
              value={visionVal}
              modelsPath="/api/models?include=vision"
              onSelect={(ref) => {
                if (ref === undefined) return;
                autoSaveGlobalModels({ models: { vision: ref } });
              }}
              allowClear
              clearLabel={t('settings.api.clearModel')}
              lookupModelMeta={lookupModelMeta}
              formatContext={formatContext}
              filterModel={imageCapableOnly}
            />
            <ToolModelTestBtn modelRef={globalModelsConfig?.models?.vision || ''} />
          </div>
          <span className={styles['settings-form-hint']}>{t('settings.api.visionModelHint')}</span>
        </div>
      </div>
      <div className={modelGridClass}>
        <div className={modelFieldClass}>
          <label className={styles['settings-form-label']}>{t('settings.api.searchProviderField')}</label>
          <SelectWidget
            options={[
              { value: AUTO_SEARCH_PROVIDER, label: 'Auto (Paid API -> AnySearch free -> Browser)' },
              { value: ANYSEARCH_PROVIDER, label: 'AnySearch' },
              { value: ANYSEARCH_FREE_PROVIDER, label: 'AnySearch (free)' },
              { value: 'bing_browser', label: 'Bing (Browser)' },
              { value: 'google_browser', label: 'Google (Browser)' },
              { value: 'duckduckgo_browser', label: 'DuckDuckGo (Browser)' },
              { value: 'tavily', label: 'Tavily' },
              { value: 'serper', label: 'Serper (Google)' },
              { value: 'brave', label: 'Brave Search' },
            ]}
            value={searchProvider}
            onChange={(val) => {
              setSearchKeyEdited({});
              autoSaveGlobalModels({
                search: (val === AUTO_SEARCH_PROVIDER || isBrowserSearchProvider(val) || isFreeSearchProvider(val))
                  ? { provider: val, api_key: '' }
                  : { provider: val },
              });
            }}
            placeholder={t('settings.api.searchProviderField')}
          />
        </div>
        <div className={modelFieldClass}>
          <label className={styles['settings-form-label']}>{t('settings.api.searchApiKey')}</label>
          {searchIsKeylessProvider ? (
            <span className={styles['settings-form-hint']}>{t('settings.api.searchApiKeyNotRequired')}</span>
          ) : searchIsAutoProvider ? (
            <>
              <div className={styles['search-api-key-list']}>
                {SEARCH_API_PROVIDER_IDS.map((provider) => renderSearchApiKeyRow(provider))}
              </div>
              <span className={styles['settings-form-hint']}>{t('settings.api.searchApiKeysAutoHint')}</span>
            </>
          ) : (
            <>
              {explicitSearchApiProvider && renderSearchApiKeyRow(explicitSearchApiProvider)}
              <span className={styles['settings-form-hint']}>{t('settings.api.searchApiKeyHint')}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
