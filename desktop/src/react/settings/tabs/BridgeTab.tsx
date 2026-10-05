import React from 'react';
import { t } from '../helpers';
import { Toggle } from '../widgets/Toggle';
import { PlatformSection } from './bridge/PlatformSection';
import { PlatformDiagnostics } from './bridge/PlatformDiagnostics';
import { WechatSection } from './bridge/WechatSection';
import { WhatsappSection } from './bridge/WhatsappSection';
import { AgentlyMailSection } from './bridge/AgentlyMailSection';
import { useBridgeState } from './bridge/useBridgeState';
import { BridgeAgentRow } from './bridge/BridgeAgentRow';
import { BridgePermissionModeSelect, type BridgePermissionMode } from './bridge/BridgeWidgets';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { useSettingsStore } from '../store';
import styles from '../Settings.module.css';

export function BridgeTab() {
  const b = useBridgeState();
  const tgInfo = b.status?.telegram;
  const fsInfo = b.status?.feishu;
  const dtInfo = b.status?.dingtalk;
  const waInfo = b.status?.whatsapp;
  const qqInfo = b.status?.qq;
  const agentlyMailInfo = b.status?.agentlyMail;
  const wxInfo = b.status?.wechat;
  const snapshotBridge = useSettingsStore(s => s.settingsSnapshot.data?.preferences?.bridge);
  const permissionMode = (b.status?.permissionMode || snapshotBridge?.permissionMode) as BridgePermissionMode | undefined;
  const receiptEnabled = typeof b.status?.receiptEnabled === 'boolean'
    ? b.status.receiptEnabled
    : snapshotBridge?.receiptEnabled;
  const richStreamingEnabled = typeof b.status?.richStreamingEnabled === 'boolean'
    ? b.status.richStreamingEnabled
    : snapshotBridge
      ? snapshotBridge.richStreamingEnabled !== false
      : undefined;
  const globalSettingsPending = !permissionMode || b.globalSettingsSaving;

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="bridge">
      <SettingsSection title={t('settings.bridge.globalSettings')}>
        <SettingsRow
          label={t('settings.bridge.permissionMode')}
          hint={t('settings.bridge.permissionModeDesc')}
          control={(
            <BridgePermissionModeSelect
              value={permissionMode}
              onChange={(mode) => b.saveGlobalSettings({ permissionMode: mode })}
              disabled={globalSettingsPending}
            />
          )}
        />
        <SettingsRow
          label={t('settings.bridge.receiptEnabled')}
          hint={t('settings.bridge.receiptEnabledDesc')}
          control={(
            <Toggle
              on={receiptEnabled}
              label={t('settings.bridge.receiptEnabled')}
              onChange={(on) => b.saveGlobalSettings({ receiptEnabled: on })}
              disabled={b.globalSettingsSaving}
            />
          )}
        />
        <SettingsRow
          label={t('settings.bridge.richStreamingEnabled')}
          hint={t('settings.bridge.richStreamingEnabledDesc')}
          control={(
            <Toggle
              on={richStreamingEnabled}
              label={t('settings.bridge.richStreamingEnabled')}
              onChange={(on) => b.saveGlobalSettings({ richStreamingEnabled: on })}
              disabled={b.globalSettingsSaving}
            />
          )}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.bridge.agentSettings')} variant="flush">
        <BridgeAgentRow
          value={b.selectedAgentId}
          onChange={b.setSelectedAgentId}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.agent.publicIshiki')}>
        <div style={{ padding: 'var(--space-sm) var(--space-md)' }}>
          <div style={{
            fontSize: '0.7rem',
            color: 'var(--text-muted)',
            lineHeight: 1.5,
            marginBottom: 'var(--space-sm)',
            whiteSpace: 'pre-line',
          }}>
            {t('settings.agent.publicIshikiHint')}
          </div>
          <textarea
            className={styles['settings-textarea']}
            rows={6}
            spellCheck={false}
            value={b.publicIshiki}
            onChange={(e) => b.setPublicIshiki(e.target.value)}
            onBlur={b.savePublicIshiki}
          />
        </div>
      </SettingsSection>

      <div className="bridge-help-link-row">
        <span className="bridge-help-link" onClick={() => window.dispatchEvent(new Event('gsap-show-bridge-tutorial'))}>
          {t('settings.bridge.howTo')}
        </span>
      </div>

      <PlatformSection
        platform="telegram"
        title={t('settings.bridge.telegram')}
        status={tgInfo}
        credentialFields={[
          { key: 'token', label: t('settings.bridge.telegramToken'), type: 'secret', value: b.tgToken, onChange: b.setTgToken },
        ]}
        onToggle={async (on) => {
          if (on && !b.tgToken.trim()) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          await b.saveBridgeConfig('telegram', b.tgToken.trim() ? { token: b.tgToken.trim() } : null, on);
        }}
        onTest={() => {
          if (!b.tgToken.trim()) { b.showToast(t('settings.bridge.noToken'), 'error'); return; }
          b.testPlatform('telegram', { token: b.tgToken.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.tgToken.trim()) await b.saveBridgeConfig('telegram', { token: b.tgToken.trim() }, undefined);
        }}
        testing={b.testingPlatform === 'telegram'}
        hint={t('settings.bridge.telegramHint')}
        ownerUsers={b.status?.knownUsers?.telegram || []}
        currentOwner={b.status?.owner?.telegram}
        onOwnerChange={(userId) => b.setOwner('telegram', userId)}
      >
        <PlatformDiagnostics
          status={tgInfo}
          reconnecting={b.reconnectingPlatform === 'telegram'}
          onReconnect={() => b.reconnectPlatform('telegram')}
        />
      </PlatformSection>

      <PlatformSection
        platform="feishu"
        title={t('settings.bridge.feishu')}
        status={fsInfo}
        credentialFields={[
          { key: 'appId', label: t('settings.bridge.feishuAppId'), type: 'text', value: b.fsAppId, onChange: b.setFsAppId },
          { key: 'appSecret', label: t('settings.bridge.feishuAppSecret'), type: 'secret', value: b.fsAppSecret, onChange: b.setFsAppSecret },
        ]}
        onToggle={async (on) => {
          if (on && (!b.fsAppId.trim() || !b.fsAppSecret.trim())) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('feishu', { appId: b.fsAppId.trim(), appSecret: b.fsAppSecret.trim() }, on);
        }}
        onTest={() => {
          if (!b.fsAppId.trim() || !b.fsAppSecret.trim()) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('feishu', { appId: b.fsAppId.trim(), appSecret: b.fsAppSecret.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.fsAppId.trim() && b.fsAppSecret.trim()) {
            await b.saveBridgeConfig('feishu', { appId: b.fsAppId.trim(), appSecret: b.fsAppSecret.trim() }, undefined);
          }
        }}
        testing={b.testingPlatform === 'feishu'}
        hint={t('settings.bridge.feishuHint')}
        ownerUsers={b.status?.knownUsers?.feishu || []}
        currentOwner={b.status?.owner?.feishu}
        onOwnerChange={(userId) => b.setOwner('feishu', userId)}
      >
        <PlatformDiagnostics
          status={fsInfo}
          reconnecting={b.reconnectingPlatform === 'feishu'}
          onReconnect={() => b.reconnectPlatform('feishu')}
        />
      </PlatformSection>

      <PlatformSection
        platform="dingtalk"
        title={t('settings.bridge.dingtalk')}
        status={dtInfo}
        credentialFields={[
          { key: 'clientId', label: t('settings.bridge.dingtalkClientId'), type: 'text', value: b.dtClientId, onChange: b.setDtClientId },
          { key: 'robotCode', label: t('settings.bridge.dingtalkRobotCode'), type: 'text', value: b.dtRobotCode, onChange: b.setDtRobotCode },
          { key: 'clientSecret', label: t('settings.bridge.dingtalkClientSecret'), type: 'secret', value: b.dtClientSecret, onChange: b.setDtClientSecret },
        ]}
        onToggle={async (on) => {
          if (on && (!b.dtClientId.trim() || !b.dtClientSecret.trim() || !b.dtRobotCode.trim())) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('dingtalk', {
            clientId: b.dtClientId.trim(),
            clientSecret: b.dtClientSecret.trim(),
            robotCode: b.dtRobotCode.trim(),
          }, on);
        }}
        onTest={() => {
          if (!b.dtClientId.trim() || !b.dtClientSecret.trim() || !b.dtRobotCode.trim()) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('dingtalk', {
            clientId: b.dtClientId.trim(),
            clientSecret: b.dtClientSecret.trim(),
            robotCode: b.dtRobotCode.trim(),
          });
        }}
        onCredentialBlur={async () => {
          if (b.dtClientId.trim() && b.dtClientSecret.trim() && b.dtRobotCode.trim()) {
            await b.saveBridgeConfig('dingtalk', {
              clientId: b.dtClientId.trim(),
              clientSecret: b.dtClientSecret.trim(),
              robotCode: b.dtRobotCode.trim(),
            }, undefined);
          }
        }}
        testing={b.testingPlatform === 'dingtalk'}
        hint={t('settings.bridge.dingtalkHint')}
        ownerUsers={b.status?.knownUsers?.dingtalk || []}
        currentOwner={b.status?.owner?.dingtalk}
        onOwnerChange={(userId) => b.setOwner('dingtalk', userId)}
      >
        <PlatformDiagnostics
          status={dtInfo}
          reconnecting={b.reconnectingPlatform === 'dingtalk'}
          onReconnect={() => b.reconnectPlatform('dingtalk')}
        />
      </PlatformSection>

      <PlatformSection
        platform="qq"
        title="QQ"
        status={qqInfo}
        credentialFields={[
          { key: 'appID', label: t('settings.bridge.qqAppId'), type: 'text', value: b.qqAppId, onChange: b.setQqAppId },
          { key: 'appSecret', label: t('settings.bridge.qqAppSecret'), type: 'secret', value: b.qqAppSecret, onChange: b.setQqAppSecret },
        ]}
        onToggle={async (on) => {
          if (on && (!b.qqAppId.trim() || !b.qqAppSecret.trim())) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          await b.saveBridgeConfig('qq', { appID: b.qqAppId.trim(), appSecret: b.qqAppSecret.trim() }, on);
        }}
        onTest={() => {
          if (!b.qqAppId.trim() || !b.qqAppSecret.trim()) { b.showToast(t('settings.bridge.noCredentials'), 'error'); return; }
          b.testPlatform('qq', { appID: b.qqAppId.trim(), appSecret: b.qqAppSecret.trim() });
        }}
        onCredentialBlur={async () => {
          if (b.qqAppId.trim() && b.qqAppSecret.trim()) {
            await b.saveBridgeConfig('qq', { appID: b.qqAppId.trim(), appSecret: b.qqAppSecret.trim() }, undefined);
          }
        }}
        testing={b.testingPlatform === 'qq'}
        hint={t('settings.bridge.qqHint')}
        ownerUsers={b.status?.knownUsers?.qq || []}
        currentOwner={b.status?.owner?.qq}
        onOwnerChange={(userId) => b.setOwner('qq', userId)}
      >
        <PlatformDiagnostics
          status={qqInfo}
          reconnecting={b.reconnectingPlatform === 'qq'}
          onReconnect={() => b.reconnectPlatform('qq')}
        />
      </PlatformSection>

      <AgentlyMailSection
        status={agentlyMailInfo}
        showToast={b.showToast}
        onReload={b.loadStatus}
        agentId={b.selectedAgentId}
      />

      <WechatSection
        status={wxInfo}
        showToast={b.showToast}
        onSaveConfig={(creds, enabled) => b.saveBridgeConfig('wechat', creds, enabled)}
        onReload={b.loadStatus}
        onReconnect={() => b.reconnectPlatform('wechat')}
        reconnecting={b.reconnectingPlatform === 'wechat'}
        agentId={b.selectedAgentId}
      />

      <WhatsappSection
        status={waInfo}
        showToast={b.showToast}
        onReload={b.loadStatus}
        onReconnect={() => b.reconnectPlatform('whatsapp')}
        reconnecting={b.reconnectingPlatform === 'whatsapp'}
        agentId={b.selectedAgentId}
        ownerUsers={b.status?.knownUsers?.whatsapp || []}
        currentOwner={b.status?.owner?.whatsapp}
        onOwnerChange={(userId) => b.setOwner('whatsapp', userId)}
      />
    </div>
  );
}
