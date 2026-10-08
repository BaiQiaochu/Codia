import React from 'react';
import { t } from '../../helpers';
import { formatBridgeError } from './BridgeWidgets';

interface PlatformDiagnosticsStatus {
  error?: string | null;
  errorType?: string | null;
  errorDetail?: string | null;
  lastConnectedAt?: number | null;
  lastErrorAt?: number | null;
  lastSyncAt?: number | null;
  retryCount?: number;
  diagnose?: string[];
  syncState?: string;
  adapter?: { platform?: string | null; agentId?: string | null; version?: string | null; statusAt?: number | null };
  capabilities?: {
    media?: {
      inputModes?: string[];
      supportedKinds?: string[];
      requiresReplyContext?: boolean;
    } | null;
    streaming?: { mode?: string; scopes?: string[] } | null;
  } | null;
}

interface PlatformDiagnosticsProps {
  status?: PlatformDiagnosticsStatus;
  reconnecting?: boolean;
  onReconnect?: () => void;
}

function formatTimestamp(value?: number | null) {
  if (!value) return t('settings.bridge.diagNever');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('settings.bridge.diagNever');
  return date.toLocaleString();
}

function formatSyncState(syncState?: string) {
  if (syncState === 'recent') return t('settings.bridge.diagSyncRecent');
  if (syncState === 'idle') return t('settings.bridge.diagSyncIdle');
  return t('settings.bridge.diagSyncNever');
}

function formatRecentError(status?: PlatformDiagnosticsStatus) {
  const message = status?.error || status?.errorType
    ? formatBridgeError(status?.errorType, status?.error)
    : '';
  if (!message) return t('settings.bridge.diagNever');

  const at = formatTimestamp(status?.lastErrorAt);
  if (at === t('settings.bridge.diagNever')) return message;
  return `${message} · ${at}`;
}

function formatList(values?: string[]) {
  return Array.isArray(values) && values.length ? values.join(', ') : 'none';
}

function formatCapabilities(status?: PlatformDiagnosticsStatus) {
  const media = status?.capabilities?.media;
  if (!media) return 'No shared media capability data';

  const context = media.requiresReplyContext ? 'reply-context required' : 'proactive media ok';
  const streaming = status?.capabilities?.streaming?.mode
    ? `; streaming ${status.capabilities.streaming.mode}`
    : '';
  return `${formatList(media.supportedKinds)} via ${formatList(media.inputModes)}; ${context}${streaming}`;
}

export function PlatformDiagnostics({
  status,
  reconnecting = false,
  onReconnect,
}: PlatformDiagnosticsProps) {
  const diagnose = status?.diagnose || [];
  const retryCount = status?.retryCount ?? 0;

  return (
    <div className="bridge-diagnostics-panel">
      <div className="bridge-diagnostics-header">
        <div className="bridge-diagnostics-title">{t('settings.bridge.diagTitle')}</div>
        {onReconnect && (
          <button type="button"
            className="bridge-test-btn bridge-diagnostics-reconnect"
            onClick={onReconnect}
            disabled={reconnecting}
          >
            {reconnecting ? '...' : t('status.reconnect')}
          </button>
        )}
      </div>

      {diagnose.length > 0 ? (
        <ul className="bridge-diagnostics-list">
          {diagnose.map((item) => (
            <li key={item} className="bridge-diagnostics-item">{item}</li>
          ))}
        </ul>
      ) : (
        <div className="bridge-diagnostics-empty">{t('settings.bridge.diagEmpty')}</div>
      )}

      <div className="bridge-diagnostics-grid">
        <div className="bridge-diagnostics-row">
          <span className="bridge-diagnostics-label">{t('settings.bridge.diagLastConnected')}</span>
          <span className="bridge-diagnostics-value">{formatTimestamp(status?.lastConnectedAt)}</span>
        </div>
        <div className="bridge-diagnostics-row">
          <span className="bridge-diagnostics-label">{t('settings.bridge.diagLastSync')}</span>
          <span className="bridge-diagnostics-value">
            {formatTimestamp(status?.lastSyncAt)} ({formatSyncState(status?.syncState)})
          </span>
        </div>
        <div className="bridge-diagnostics-row">
          <span className="bridge-diagnostics-label">{t('settings.bridge.diagLastError')}</span>
          <span className="bridge-diagnostics-value">{formatRecentError(status)}</span>
        </div>
        <div className="bridge-diagnostics-row">
          <span className="bridge-diagnostics-label">{t('settings.bridge.diagRetryCount')}</span>
          <span className="bridge-diagnostics-value">{retryCount}</span>
        </div>
        <div className="bridge-diagnostics-row">
          <span className="bridge-diagnostics-label">Capabilities</span>
          <span className="bridge-diagnostics-value">{formatCapabilities(status)}</span>
        </div>
        <div className="bridge-diagnostics-row">
          <span className="bridge-diagnostics-label">Adapter</span>
          <span className="bridge-diagnostics-value">
            {status?.adapter?.platform || '-'}{status?.adapter?.version ? ` v${status.adapter.version}` : ''}
          </span>
        </div>
        {!!status?.errorDetail && status.errorDetail !== status.error && (
          <div className="bridge-diagnostics-row">
            <span className="bridge-diagnostics-label">{t('settings.bridge.diagErrorDetail')}</span>
            <span className="bridge-diagnostics-value">{status.errorDetail}</span>
          </div>
        )}
      </div>
    </div>
  );
}
