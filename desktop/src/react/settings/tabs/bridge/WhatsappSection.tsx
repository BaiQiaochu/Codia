import React from 'react';
import { t } from '../../helpers';
import { gsapFetch } from '../../api';
import { Toggle } from '../../widgets/Toggle';
import { BridgeStatusDot, BridgeStatusText, OwnerSelect } from './BridgeWidgets';
import { PlatformDiagnostics } from './PlatformDiagnostics';
import { SettingsSection } from '../../components/SettingsSection';

interface WhatsappSectionProps {
  status: {
    status?: string;
    error?: string;
    errorType?: string | null;
    errorDetail?: string | null;
    enabled?: boolean;
    qrcodeUrl?: string;
    authenticated?: boolean;
    lastConnectedAt?: number | null;
    lastErrorAt?: number | null;
    lastSyncAt?: number | null;
    retryCount?: number;
    diagnose?: string[];
    syncState?: string;
  } | undefined;
  showToast: (msg: string, type: 'success' | 'error') => void;
  onReload: () => Promise<void>;
  onReconnect: () => void;
  reconnecting?: boolean;
  agentId: string | null;
  ownerUsers?: Array<{ userId: string; name?: string | null }>;
  currentOwner?: string;
  onOwnerChange?: (userId: string) => void;
}

export function WhatsappSection({
  status,
  showToast,
  onReload,
  onReconnect,
  reconnecting = false,
  agentId,
  ownerUsers = [],
  currentOwner,
  onOwnerChange,
}: WhatsappSectionProps) {
  const openQrOverlay = (force = false) => {
    if (!agentId) {
      showToast(t('settings.saveFailed'), 'error');
      return;
    }

    window.dispatchEvent(new CustomEvent('gsap-show-whatsapp-qrcode', {
      detail: { agentId, force },
    }));
  };

  const shouldForceQrRestart = !!status?.authenticated
    || (!!status?.enabled && !status?.qrcodeUrl && status?.status === 'connecting');
  const toggleOn = status === undefined ? undefined : !!status.enabled;

  const statusContext = (
    <div className="bridge-platform-header" style={{ margin: 0 }}>
      <BridgeStatusDot status={status?.status} />
      <BridgeStatusText status={status?.status} error={status?.error} errorType={status?.errorType} />
      <Toggle
        on={toggleOn}
        onChange={async (on) => {
          if (on) {
            openQrOverlay(false);
            return;
          }
          try {
            await gsapFetch(`/api/bridge/config?agentId=${encodeURIComponent(agentId || '')}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ platform: 'whatsapp', enabled: false }),
            });
            await onReload();
          } catch {
            showToast(t('settings.saveFailed'), 'error');
          }
        }}
      />
    </div>
  );

  return (
    <SettingsSection title="WhatsApp" context={statusContext}>
      <div style={{ padding: 'var(--space-sm) var(--space-md)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <button type="button" className="bridge-test-btn" onClick={() => openQrOverlay(shouldForceQrRestart)}>
            {status?.authenticated ? t('settings.bridge.whatsappRescan') : t('settings.bridge.whatsappScan')}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-muted)', fontSize: '0.7rem', lineHeight: 1.4 }}>
          <span>{t('settings.bridge.whatsappHint')}</span>
          <span>{t('settings.bridge.whatsappPopupHint')}</span>
        </div>
      </div>

      <PlatformDiagnostics
        status={status}
        reconnecting={reconnecting}
        onReconnect={onReconnect}
      />

      {status?.authenticated && (
        <div style={{ padding: 'var(--space-sm) var(--space-md)', borderTop: '1px solid var(--border)' }}>
          <OwnerSelect
            platform="whatsapp"
            users={ownerUsers.map((u) => ({ userId: u.userId, name: u.name || undefined }))}
            currentOwner={currentOwner}
            onChange={(userId) => onOwnerChange?.(userId)}
          />
        </div>
      )}
    </SettingsSection>
  );
}
