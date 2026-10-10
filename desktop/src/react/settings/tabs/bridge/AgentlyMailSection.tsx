import React, { useCallback, useEffect, useState } from 'react';
import { t } from '../../helpers';
import { codiaFetch } from '../../api';
import { Toggle } from '../../widgets/Toggle';
import { BridgeStatusDot, BridgeStatusText } from './BridgeWidgets';
import { PlatformDiagnostics } from './PlatformDiagnostics';
import { SettingsSection } from '../../components/SettingsSection';
import type { AgentlyMailStatus } from './useBridgeState';
import bridgeStyles from '../BridgeTab.module.css';

interface AgentlyMailCliStatus {
  available?: boolean;
  version?: string;
  error?: string;
  installCommand?: string;
  skillInstallCommand?: string;
}

interface AgentlyMailSectionProps {
  status: AgentlyMailStatus | undefined;
  showToast: (msg: string, type: 'success' | 'error') => void;
  onReload: () => Promise<void>;
  agentId: string | null;
}

function agentQuery(agentId: string | null) {
  return agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
}

export function AgentlyMailSection({
  status,
  showToast,
  onReload,
  agentId,
}: AgentlyMailSectionProps) {
  const [cli, setCli] = useState<AgentlyMailCliStatus | null>(null);
  const [authUrl, setAuthUrl] = useState('');
  const [busy, setBusy] = useState<'check' | 'auth' | 'verify' | 'unbind' | null>(null);

  const checkCli = useCallback(async (silent = false) => {
    if (!silent) setBusy('check');
    try {
      const res = await codiaFetch(`/api/bridge/agently-mail/status${agentQuery(agentId)}`);
      const data = await res.json();
      setCli(data.cli || null);
      if (!silent && data.cli?.available) {
        showToast(t('settings.bridge.agentlyMailCliAvailable'), 'success');
      }
      if (!silent && data.cli && !data.cli.available) {
        showToast(t('settings.bridge.agentlyMailCliMissing'), 'error');
      }
    } catch (err: unknown) {
      if (!silent) showToast(t('settings.bridge.agentlyMailCliMissing') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      if (!silent) setBusy(null);
    }
  }, [agentId, showToast]);

  useEffect(() => {
    checkCli(true);
  }, [checkCli]);

  const startAuth = async () => {
    setBusy('auth');
    try {
      const res = await codiaFetch(`/api/bridge/agently-mail/auth/start${agentQuery(agentId)}`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok || !data.authUrl) throw new Error(data.error || 'auth_url_missing');
      setAuthUrl(data.authUrl);
      showToast(t('settings.bridge.agentlyMailAuthStarted'), 'success');
    } catch (err: unknown) {
      showToast(t('settings.bridge.agentlyMailVerifyFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusy(null);
    }
  };

  const verify = async () => {
    setBusy('verify');
    try {
      const res = await codiaFetch(`/api/bridge/agently-mail/verify${agentQuery(agentId)}`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'verify_failed');
      showToast(t('settings.bridge.agentlyMailVerifySuccess'), 'success');
      setAuthUrl('');
      await onReload();
    } catch (err: unknown) {
      showToast(t('settings.bridge.agentlyMailVerifyFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusy(null);
    }
  };

  const unbind = async () => {
    setBusy('unbind');
    try {
      await codiaFetch(`/api/bridge/agently-mail/unbind${agentQuery(agentId)}`, { method: 'POST' });
      showToast(t('settings.bridge.agentlyMailUnbind'), 'success');
      setAuthUrl('');
      await onReload();
    } catch (err: unknown) {
      showToast(t('settings.saveFailed') + ': ' + (err instanceof Error ? err.message : String(err)), 'error');
    } finally {
      setBusy(null);
    }
  };

  const toggleOn = status === undefined ? undefined : !!status.enabled;
  const connectedStatus = status?.status || (status?.email ? 'connected' : 'disconnected');
  const statusContext = (
    <div className="bridge-platform-header" style={{ margin: 0 }}>
      <BridgeStatusDot status={connectedStatus} />
      <BridgeStatusText status={connectedStatus} error={status?.error} errorType={status?.errorType} />
      <Toggle
        on={toggleOn}
        onChange={(on) => {
          if (on) {
            startAuth();
            return;
          }
          unbind();
        }}
      />
    </div>
  );

  return (
    <SettingsSection title={t('settings.bridge.agentlyMail')} context={statusContext}>
      <div className={bridgeStyles['agently-mail-body']}>
        <div className={bridgeStyles['agently-mail-summary']}>
          <div>
            <div className={bridgeStyles['agently-mail-label']}>{t('settings.bridge.agentlyMailBoundEmail')}</div>
            <div className={bridgeStyles['agently-mail-value']}>{status?.email || t('settings.bridge.agentlyMailNotBound')}</div>
          </div>
          <div className={bridgeStyles['agently-mail-actions']}>
            <button type="button" className="bridge-test-btn" disabled={busy === 'check'} onClick={() => checkCli(false)}>
              {busy === 'check' ? '...' : t('settings.bridge.agentlyMailCheckCli')}
            </button>
            <button type="button" className="bridge-test-btn" disabled={!!busy} onClick={startAuth}>
              {busy === 'auth' ? '...' : t('settings.bridge.agentlyMailStartAuth')}
            </button>
            <button type="button" className="bridge-test-btn" disabled={!!busy} onClick={verify}>
              {busy === 'verify' ? '...' : t('settings.bridge.agentlyMailVerify')}
            </button>
            {status?.email && (
              <button type="button" className="bridge-test-btn" disabled={!!busy} onClick={unbind}>
                {busy === 'unbind' ? '...' : t('settings.bridge.agentlyMailUnbind')}
              </button>
            )}
          </div>
        </div>

        <div className={bridgeStyles['agently-mail-note']}>
          <div>{t('settings.bridge.agentlyMailHint')}</div>
          <div>{cli?.available
            ? `${t('settings.bridge.agentlyMailCliAvailable')}${cli.version ? `: ${cli.version}` : ''}`
            : t('settings.bridge.agentlyMailCliMissing')}</div>
          {!cli?.available && (
            <>
              <code>{cli?.installCommand || 'npm install -g @tencent-qqmail/agently-cli'}</code>
              <code>{cli?.skillInstallCommand || 'npx skills add https://agent.qq.com --skill -g -y'}</code>
            </>
          )}
        </div>

        {authUrl && (
          <div className={bridgeStyles['agently-mail-auth']}>
            <label>{t('settings.bridge.agentlyMailAuthUrl')}</label>
            <a href={authUrl} target="_blank" rel="noreferrer">{authUrl}</a>
          </div>
        )}
      </div>

      <PlatformDiagnostics
        status={status}
        reconnecting={false}
        onReconnect={verify}
      />
    </SettingsSection>
  );
}
