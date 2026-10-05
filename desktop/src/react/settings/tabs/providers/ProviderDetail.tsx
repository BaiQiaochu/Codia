import React, { useState } from 'react';
import { useSettingsStore, type ProviderSummary } from '../../store';
import { gsapFetch } from '../../api';
import { invalidateConfigCache } from '../../../hooks/use-config';
import { t } from '../../helpers';
import { OAuthCredentials } from './OAuthCredentials';
import { ApiKeyCredentials } from './ApiKeyCredentials';
import { ProviderModelList } from './ProviderModelList';
import styles from '../../Settings.module.css';

const platform = window.platform;

function missingFieldLabel(field: string): string {
  if (field === 'api_key') return t('settings.providers.field.apiKey');
  if (field === 'base_url') return t('settings.providers.field.baseUrl');
  if (field === 'models') return t('settings.providers.field.models');
  return field;
}

function formatConfigIncomplete(summary: ProviderSummary): string {
  const fields = (summary.missing_fields || []).map(missingFieldLabel).filter(Boolean);
  if (fields.length === 0) return t('settings.providers.configIncomplete');
  return t('settings.providers.configIncompleteDetailed', { fields: fields.join('\u3001') });
}

function providerPlanNotice(providerId: string): string | null {
  if (providerId === 'minimax-token-plan') {
    return 'MiniMax Token Plan \u4f7f\u7528\u8ba2\u9605\u8ba1\u5212 Key\uff0c\u4e0d\u80fd\u548c\u666e\u901a MiniMax \u6309\u91cf\u4ed8\u8d39 API Key \u6df7\u7528\u3002';
  }
  if (providerId === 'minimax') {
    return '\u666e\u901a MiniMax \u4f7f\u7528\u6309\u91cf\u4ed8\u8d39 API Key\uff1b\u5982\u679c\u8d2d\u4e70\u7684\u662f Token Plan\uff0c\u8bf7\u6539\u7528 MiniMax Token Plan provider\u3002';
  }
  return null;
}

export function ProviderDetail({ providerId, summary, providerConfig, isPresetSetup, presetInfo, onRefresh }: {
  providerId: string;
  summary: ProviderSummary;
  providerConfig?: Record<string, unknown>;
  isPresetSetup?: boolean;
  presetInfo?: { label: string; value: string; url?: string; api?: string; local?: boolean };
  onRefresh: () => Promise<void>;
}) {
  const planNotice = providerPlanNotice(providerId);
  return (
    <div className={styles['pv-detail-inner']}>
      <div className={styles['pv-detail-header']}>
        <h2 className={styles['pv-detail-title']}>{summary.display_name || providerId}</h2>
        {summary.can_delete && !isPresetSetup && (
          <ProviderDeleteButton providerId={providerId} onRefresh={onRefresh} />
        )}
      </div>
      {summary.config_status === 'invalid' && (
        <div className={styles['pv-config-alert']}>
          {summary.config_error || t('settings.providers.configInvalid')}
        </div>
      )}
      {summary.config_status === 'needs_setup' && summary.can_delete && !summary.config_error && (
        <div className={styles['pv-config-alert']}>
          {formatConfigIncomplete(summary)}
        </div>
      )}
      {planNotice && (
        <div className={styles['pv-config-note']}>
          {planNotice}
        </div>
      )}
      {summary.supports_oauth ? (
        <OAuthCredentials providerId={providerId} summary={summary} onRefresh={onRefresh} />
      ) : (
        <ApiKeyCredentials
          providerId={providerId}
          summary={summary}
          providerConfig={providerConfig}
          isPresetSetup={isPresetSetup}
          presetInfo={presetInfo}
          onRefresh={onRefresh}
        />
      )}
      <ProviderModelList providerId={providerId} summary={summary} onRefresh={onRefresh} />
    </div>
  );
}

function ProviderDeleteButton({ providerId, onRefresh }: { providerId: string; onRefresh: () => Promise<void> }) {
  const { showToast } = useSettingsStore();
  const [confirming, setConfirming] = useState(false);

  const handleDelete = async () => {
    try {
      const res = await gsapFetch('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: { [providerId]: null } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      invalidateConfigCache();
      showToast(t('settings.providers.deleted', { name: providerId }), 'success');
      useSettingsStore.setState({ selectedProviderId: null });
      setConfirming(false);
      await onRefresh();
      platform?.settingsChanged?.('models-changed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(t('settings.saveFailed') + ': ' + msg, 'error');
    }
  };

  return (
    <>
      <button type="button" className={styles['pv-delete-btn']} onClick={() => setConfirming(true)}>
        {t('settings.providers.delete')}
      </button>
      {confirming && (
        <>
          <div className={styles['pv-model-edit-overlay']} onClick={() => setConfirming(false)} />
          <div className={styles['pv-confirm-dialog']}>
            <p className={styles['pv-confirm-text']}>
              {t('settings.providers.deleteConfirm', { name: providerId })}
            </p>
            <div className={styles['pv-confirm-actions']}>
              <button type="button" className={styles['pv-add-form-btn']} onClick={() => setConfirming(false)}>{t('settings.api.cancel')}</button>
              <button type="button" className={`${styles['pv-add-form-btn']} ${styles['danger']}`} onClick={handleDelete}>{t('settings.providers.delete')}</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
