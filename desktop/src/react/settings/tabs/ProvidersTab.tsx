import React, { useState, useCallback, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore, type ProviderSummary } from '../store';
import { gsapFetch } from '../api';
import { t, PROVIDER_PRESETS } from '../helpers';
import { getProviderPresetLabel } from '../../utils/provider-presets';
import { loadSettingsConfig } from '../actions';
import { ProviderDetail } from './providers/ProviderDetail';
import { AddCustomButton, AddProviderOverlay } from './providers/ProviderList';
import { OtherModelsSection } from './providers/OtherModelsSection';
import { UsageLedgerSection } from './providers/UsageLedgerSection';
import { SettingsSection } from '../components/SettingsSection';
import { ProviderIcon } from '../../ui';
import styles from '../Settings.module.css';

function css(...names: Array<string | false | null | undefined>) {
  return names
    .flatMap(name => (name ? [styles[name], name] : []))
    .filter(Boolean)
    .join(' ');
}

export function ProvidersTab() {
  const { providersSummary, selectedProviderId, settingsConfig } = useSettingsStore(
    useShallow(state => ({
      providersSummary: state.providersSummary,
      selectedProviderId: state.selectedProviderId,
      settingsConfig: state.settingsConfig,
    })),
  );
  const providers = settingsConfig?.providers || {};
  const [addingProvider, setAddingProvider] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const res = await gsapFetch('/api/providers/summary');
      const data = await res.json();
      useSettingsStore.setState({ providersSummary: data.providers || {} });
    } catch { /* swallow */ }
  }, []);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const providerIds = Object.keys(providersSummary);
  const configuredProviderIds = providerIds.filter(id => providersSummary[id].is_configured !== false);
  const setupProviderIds = providerIds.filter(id => providersSummary[id].is_configured === false);

  const oauthProviders = configuredProviderIds.filter(id => providersSummary[id].supports_oauth);
  const codingPlanProviders = configuredProviderIds.filter(id => !providersSummary[id].supports_oauth && providersSummary[id].is_coding_plan);
  const registeredApiKey = configuredProviderIds.filter(id => !providersSummary[id].supports_oauth && !providersSummary[id].is_coding_plan);
  const registeredSet = new Set(configuredProviderIds);

  const unregisteredPresets = PROVIDER_PRESETS.filter(p =>
    !registeredSet.has(p.value) && !oauthProviders.includes(p.value)
  );
  const presetValues = new Set(PROVIDER_PRESETS.map(p => p.value));
  const unregisteredCodingPresets = unregisteredPresets.filter(p => p.value.endsWith('-coding'));
  const unregisteredApiPresets = unregisteredPresets.filter(p => !p.value.endsWith('-coding'));
  const registryOnlyCodingProviders = setupProviderIds.filter(id => !presetValues.has(id) && providersSummary[id].is_coding_plan);
  const registryOnlyApiProviders = setupProviderIds.filter(id => !presetValues.has(id) && !providersSummary[id].supports_oauth && !providersSummary[id].is_coding_plan);
  const customProviders = registeredApiKey.filter(id => !presetValues.has(id));
  const presetProviders = registeredApiKey.filter(id => presetValues.has(id));
  const visibleProviderIds = [
    ...oauthProviders,
    ...codingPlanProviders,
    ...unregisteredCodingPresets.map(p => p.value),
    ...registryOnlyCodingProviders,
    ...presetProviders,
    ...unregisteredApiPresets.map(p => p.value),
    ...registryOnlyApiProviders,
    ...customProviders,
  ];
  const selected = selectedProviderId && visibleProviderIds.includes(selectedProviderId)
    ? selectedProviderId
    : visibleProviderIds[0] || null;

  useEffect(() => {
    if (selectedProviderId === selected) return;
    useSettingsStore.setState({ selectedProviderId: selected });
  }, [selected, selectedProviderId]);

  const selectProvider = (id: string) => {
    useSettingsStore.setState({ selectedProviderId: id });
  };

  const renderRegistered = (id: string) => {
    const p = providersSummary[id];
    const preset = PROVIDER_PRESETS.find(pr => pr.value === id);
    const modelCount = (p.models || []).length;
    return (
      <button type="button"
        key={id}
        className={css('pv-list-item', selected === id && 'pv-list-item-selected')}
        onClick={() => selectProvider(id)}
      >
        <span className={css('pv-status-dot', p.has_credentials && 'on')} />
        <ProviderIcon provider={id} className={css('pv-list-item-icon')} />
        <span className={css('pv-list-item-name')}>{preset ? getProviderPresetLabel(preset) : p.display_name || id}</span>
        <span className={css('pv-list-item-count')}>{modelCount}</span>
      </button>
    );
  };

  const renderUnregistered = (preset: typeof PROVIDER_PRESETS[0]) => (
    <button type="button"
      key={preset.value}
      className={css('pv-list-item', 'pv-list-item-dim', selected === preset.value && 'pv-list-item-selected')}
      onClick={() => selectProvider(preset.value)}
    >
      <span className={css('pv-status-dot')} />
      <ProviderIcon provider={preset.value} className={css('pv-list-item-icon')} />
      <span className={css('pv-list-item-name')}>{getProviderPresetLabel(preset)}</span>
    </button>
  );

  const renderRegistrySetup = (id: string) => {
    const p = providersSummary[id];
    return (
      <button type="button"
        key={id}
        className={css('pv-list-item', 'pv-list-item-dim', selected === id && 'pv-list-item-selected')}
        onClick={() => selectProvider(id)}
      >
        <span className={css('pv-status-dot')} />
        <ProviderIcon provider={id} className={css('pv-list-item-icon')} />
        <span className={css('pv-list-item-name')}>{p.display_name || id}</span>
      </button>
    );
  };

  return (
    <div className={css('settings-tab-content', 'active')} data-tab="providers">
      <SettingsSection variant="double-column">
      <div className={css('pv-layout')}>
        {/* Provider list. */}
        <div className={css('pv-list')}>
          {oauthProviders.length > 0 && (
            <>
              <div className={css('pv-list-group-label')}>{t('settings.providers.groups.oauth')}</div>
              {oauthProviders.map(renderRegistered)}
            </>
          )}

          {(codingPlanProviders.length > 0 || unregisteredCodingPresets.length > 0 || registryOnlyCodingProviders.length > 0) && (
            <>
              <div className={css('pv-list-group-label')}>{t('settings.providers.groups.codingPlan')}</div>
              {codingPlanProviders.map(renderRegistered)}
              {unregisteredCodingPresets.map(renderUnregistered)}
              {registryOnlyCodingProviders.map(renderRegistrySetup)}
            </>
          )}

          <div className={css('pv-list-group-label')}>{t('settings.providers.groups.api')}</div>
          {presetProviders.map(renderRegistered)}
          {unregisteredApiPresets.map(renderUnregistered)}
          {registryOnlyApiProviders.map(renderRegistrySetup)}
          {customProviders.map(renderRegistered)}

          <AddCustomButton onClick={() => setAddingProvider(true)} />
        </div>

        {/* Provider detail. */}
        <div className={css('pv-detail')}>
          {selected ? (() => {
            const existing = providersSummary[selected];
            const preset = PROVIDER_PRESETS.find(p => p.value === selected);
            const isRegistryOnlySetup = existing?.is_configured === false;
            const summary: ProviderSummary = existing || {
              type: 'api-key' as const,
              display_name: preset ? getProviderPresetLabel(preset) : selected,
              base_url: preset?.url || '',
              api: preset?.api || '',
              api_key: '',
              auth_type: preset?.local ? 'none' : 'api-key',
              headers: {},
              models: [],
              custom_models: [],
              has_credentials: false,
              supports_oauth: false,
              can_delete: false,
            };
            return (
              <ProviderDetail
                key={selected}
                providerId={selected}
                summary={summary}
                providerConfig={providers[selected]}
                isPresetSetup={(!existing || isRegistryOnlySetup) && !!preset}
                presetInfo={preset}
                onRefresh={async () => { await loadSettingsConfig(); await loadSummary(); }}
              />
            );
          })() : (
            <div className={css('pv-empty')}>
              {t('settings.providers.selectHint')}
            </div>
          )}
        </div>
        {addingProvider && (
          <AddProviderOverlay
            onDone={() => { setAddingProvider(false); loadSummary(); }}
            onCancel={() => setAddingProvider(false)}
          />
        )}
      </div>
      </SettingsSection>

      {/* Global model assignment. */}
      <SettingsSection title={t('settings.api.otherModelSection')}>
        <OtherModelsSection providers={providers} />
      </SettingsSection>

      <UsageLedgerSection />
    </div>
  );
}
