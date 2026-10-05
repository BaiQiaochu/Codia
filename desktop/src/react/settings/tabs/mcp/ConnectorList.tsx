import React from 'react';
import { t } from '../../helpers';
import { Toggle } from '../../widgets/Toggle';
import styles from '../../Settings.module.css';
import type { McpAgentConnectorConfig, McpConnector } from './types';

interface ConnectorListProps {
  connectors: McpConnector[];
  globalEnabled: boolean;
  loading?: boolean;
  busyKey: string | null;
  agentConfig: {
    connectors?: Record<string, McpAgentConnectorConfig>;
    servers?: Record<string, McpAgentConnectorConfig>;
  };
  onAction: (connectorId: string, action: 'start' | 'stop' | 'refresh-tools') => void;
  onConnectorToggle: (connectorId: string, enabled: boolean) => void;
  onEdit: (connectorId: string) => void;
  onRemove: (connectorId: string) => void;
  onOAuthStart: (connectorId: string) => void;
  onOAuthLogout: (connectorId: string) => void;
}

export function ConnectorList({
  connectors,
  globalEnabled,
  loading = false,
  busyKey,
  agentConfig,
  onAction,
  onConnectorToggle,
  onEdit,
  onRemove,
  onOAuthStart,
  onOAuthLogout,
}: ConnectorListProps) {
  if (loading) {
    return <p className={styles['settings-muted-note']}>{t('status.loading')}</p>;
  }

  if (connectors.length === 0) {
    return <p className={styles['settings-muted-note']}>{t('settings.mcp.noConnectors')}</p>;
  }

  return (
    <div className={styles['skills-list-block']}>
      {connectors.map(connector => {
        const enabledForAgent = isConnectorEnabled(agentConfig, connector.id);
        return (
          <div
            key={connector.id}
            className={`${styles['skills-list-item']} ${styles['mcp-list-item']}`}
            data-testid={`mcp-connector-row-${connector.id}`}
          >
            <div className={styles['skills-list-info']}>
              <div className={styles['skills-list-name']}>
                {connector.name}
                <span className={styles['skills-list-name-hint']}>{statusLabel(connector)}</span>
              </div>
              <div className={styles['skills-list-desc']}>{connectorTarget(connector)}</div>
              <div className={styles['settings-muted-note']}>
                {transportLabel(connector.transport)}
                {' / '}
                {authLabel(connector)}
                {connector.autoStart && (
                  <>
                    {' / '}
                    {t('settings.mcp.autoStart')}
                  </>
                )}
                {recordCount(connector.env) > 0 && (
                  <>
                    {' / '}
                    {recordCount(connector.env)} {t('settings.mcp.envCount')}
                  </>
                )}
                {recordCount(connector.headers) > 0 && (
                  <>
                    {' / '}
                    {recordCount(connector.headers)} {t('settings.mcp.headersCount')}
                  </>
                )}
                {' / '}
                {connector.tools.length} {t('settings.mcp.toolsCount')}
              </div>
            </div>
            <div className={`${styles['skills-list-actions']} ${styles['mcp-list-actions']}`}>
              <Toggle
                on={enabledForAgent}
                onChange={(enabled) => onConnectorToggle(connector.id, enabled)}
                disabled={!globalEnabled || busyKey === `agent-connector-${connector.id}`}
                label={enabledForAgent ? t('common.on') : t('common.off')}
              />
              {connector.authType === 'oauth' && connector.authStatus !== 'connected' && (
                <button
                  className={styles['pv-add-form-btn']}
                  type="button"
                  disabled={busyKey === `oauth-${connector.id}`}
                  onClick={() => onOAuthStart(connector.id)}
                >
                  {t('settings.mcp.oauthConnect')}
                </button>
              )}
              {connector.authType === 'oauth' && connector.authStatus === 'connected' && (
                <button
                  className={styles['pv-add-form-btn']}
                  type="button"
                  disabled={busyKey === `oauth-logout-${connector.id}`}
                  onClick={() => onOAuthLogout(connector.id)}
                >
                  {t('settings.oauth.logout')}
                </button>
              )}
              <button
                className={styles['pv-add-form-btn']}
                type="button"
                disabled={!globalEnabled || busyKey === `start-${connector.id}` || !canStart(connector.status)}
                onClick={() => onAction(connector.id, 'start')}
              >
                {t('settings.mcp.start')}
              </button>
              <button
                className={styles['pv-add-form-btn']}
                type="button"
                disabled={busyKey === `stop-${connector.id}` || !canStop(connector.status)}
                onClick={() => onAction(connector.id, 'stop')}
              >
                {t('settings.mcp.stop')}
              </button>
              <button
                className={styles['pv-add-form-btn']}
                type="button"
                disabled={busyKey === `refresh-tools-${connector.id}` || connector.status !== 'running'}
                onClick={() => onAction(connector.id, 'refresh-tools')}
              >
                {t('settings.mcp.refresh')}
              </button>
              <button
                className={styles['pv-add-form-btn']}
                type="button"
                disabled={busyKey === `update-${connector.id}`}
                onClick={() => onEdit(connector.id)}
              >
                {t('common.edit')}
              </button>
              <button
                className={styles['pv-add-form-btn']}
                type="button"
                disabled={busyKey === `remove-${connector.id}`}
                onClick={() => onRemove(connector.id)}
              >
                {t('common.remove')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function isConnectorEnabled(
  agentConfig: ConnectorListProps['agentConfig'],
  connectorId: string,
): boolean {
  const connector = agentConfig.connectors?.[connectorId] || agentConfig.servers?.[connectorId];
  return connector?.enabled === true;
}

function connectorTarget(connector: McpConnector): string {
  if (connector.transport === 'stdio') {
    return [connector.command, ...(connector.args || [])].filter(Boolean).join(' ');
  }
  return connector.url || connector.id;
}

function statusLabel(connector: McpConnector): string {
  switch (connector.status) {
    case 'running':
      return t('settings.mcp.statusRunning');
    case 'connecting':
      return t('settings.mcp.statusConnecting');
    case 'reconnecting':
      return t('settings.mcp.statusReconnecting');
    case 'failed':
      return t('settings.mcp.statusFailed');
    case 'needs-auth':
      return t('settings.mcp.statusNeedsAuth');
    case 'stopped':
    default:
      return t('settings.mcp.statusStopped');
  }
}

function canStart(status: McpConnector['status']): boolean {
  return status === 'stopped' || status === 'failed' || status === 'needs-auth';
}

function canStop(status: McpConnector['status']): boolean {
  return status === 'running'
    || status === 'connecting'
    || status === 'reconnecting'
    || status === 'needs-auth';
}

function transportLabel(transport: string): string {
  if (transport === 'stdio') return t('settings.mcp.modeLocal');
  if (transport === 'streamable-http') return t('settings.mcp.transportStreamable');
  if (transport === 'sse') return t('settings.mcp.transportSse');
  return t('settings.mcp.transportAuto');
}

function authLabel(connector: McpConnector): string {
  if (connector.authType === 'bearer') return t('settings.mcp.authBearer');
  if (connector.authType === 'oauth') {
    return connector.authStatus === 'connected'
      ? t('settings.mcp.oauthConnected')
      : t('settings.mcp.oauthDisconnected');
  }
  return t('settings.mcp.authNone');
}

function recordCount(record?: Record<string, string>): number {
  return record ? Object.keys(record).length : 0;
}
