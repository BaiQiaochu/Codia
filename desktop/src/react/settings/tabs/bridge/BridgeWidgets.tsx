/**
 * Bridge small widgets: status indicators and owner selector
 */
import React, { useState } from 'react';
import { t } from '../../helpers';
import { SelectWidget } from '../../../ui';
import { PermissionModeIcon } from '../../../components/input/PlanModeButton';
import styles from '../../Settings.module.css';
import bridgeStyles from '../BridgeTab.module.css';

// Types

export interface KnownUser {
  userId: string;
  name?: string;
  displayName?: string | null;
  fallbackName?: string;
  aliases?: string[];
  principalId?: string;
}

export type BridgePermissionMode = 'auto' | 'operate' | 'read_only';

const BRIDGE_PERMISSION_MODES: BridgePermissionMode[] = ['auto', 'operate', 'read_only'];

function bridgePermissionModeLabelKey(mode: BridgePermissionMode) {
  if (mode === 'auto') return 'settings.bridge.permissionModeAuto';
  if (mode === 'operate') return 'settings.bridge.permissionModeOperate';
  return 'settings.bridge.permissionModeReadOnly';
}

function bridgePermissionModeOption(mode: BridgePermissionMode) {
  return { value: mode, label: t(bridgePermissionModeLabelKey(mode)) };
}

export function BridgePermissionModeSelect({
  value,
  disabled,
  onChange,
}: {
  value: BridgePermissionMode | undefined;
  disabled?: boolean;
  onChange: (mode: BridgePermissionMode) => void;
}) {
  const loading = value === undefined;
  const mode = !loading && BRIDGE_PERMISSION_MODES.includes(value) ? value : 'auto';

  return (
    <SelectWidget
      value={mode}
      disabled={disabled || loading}
      onChange={(next) => {
        if (BRIDGE_PERMISSION_MODES.includes(next as BridgePermissionMode)) {
          onChange(next as BridgePermissionMode);
        }
      }}
      className={bridgeStyles['bridge-permission-select']}
      triggerClassName={`${bridgeStyles['bridge-permission-trigger']} ${bridgeStyles[`bridge-permission-${mode}`]}`}
      options={BRIDGE_PERMISSION_MODES.map(bridgePermissionModeOption)}
      renderTrigger={(option) => {
        const current = (option?.value || mode) as BridgePermissionMode;
        if (loading) {
          return (
            <>
              <span className={bridgeStyles['bridge-permission-value']}>
                <span>{t('common.loading')}</span>
              </span>
              <svg className={bridgeStyles['bridge-permission-arrow']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </>
          );
        }
        return (
          <>
            <span className={bridgeStyles['bridge-permission-value']}>
              <PermissionModeIcon mode={current} />
              <span>{option?.label || t(bridgePermissionModeLabelKey(current))}</span>
            </span>
            <svg className={bridgeStyles['bridge-permission-arrow']} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </>
        );
      }}
      renderOption={(option) => {
        const optionMode = option.value as BridgePermissionMode;
        return (
          <span className={`${bridgeStyles['bridge-permission-option']} ${bridgeStyles[`bridge-permission-option-${optionMode}`]}`}>
            <PermissionModeIcon mode={optionMode} />
            <span>{option.label}</span>
          </span>
        );
      }}
    />
  );
}

export function formatBridgeError(errorType?: string | null, error?: string | null) {
  if (errorType === 'browser_missing') return t('settings.bridge.whatsappErrorBrowserMissing');
  if (errorType === 'network_timeout') return t('settings.bridge.whatsappErrorNetworkTimeout');
  if (errorType === 'session_conflict') return t('settings.bridge.whatsappErrorSessionConflict');
  if (errorType === 'session_expired' || error === 'session_expired') return t('settings.bridge.wechatErrorSessionExpired');
  if (errorType === 'need_scan') return t('settings.bridge.wechatNeedScan');
  if (errorType === 'not_enabled') return t('settings.bridge.diagReconnectNeedsEnabled');
  return error || t('settings.bridge.whatsappErrorUnknown');
}

// BridgeStatusDot

export function BridgeStatusDot({ status }: { status?: string }) {
  let cls = 'bridge-status-dot';
  if (status === 'connected' || status === 'connecting' || status === 'qr') cls += ' bridge-dot-ok';
  else if (status === 'error') cls += ' bridge-dot-err';
  else cls += ' bridge-dot-off';
  return <span className={cls} />;
}

// BridgeStatusText

export function BridgeStatusText({ status, error, errorType }: { status?: string; error?: string; errorType?: string | null }) {
  let text = t('settings.bridge.disconnected');
  if (status === 'connected') text = t('settings.bridge.connected');
  else if (status === 'connecting' || status === 'qr') text = t('status.connecting');
  else if (status === 'error') text = t('settings.bridge.error') + ': ' + formatBridgeError(errorType, error);
  return <span className="bridge-status-text">{text}</span>;
}

// OwnerSelect

interface OwnerSelectProps {
  platform: string;
  users: KnownUser[];
  currentOwner?: string;
  onChange: (userId: string) => void;
}

export function OwnerSelect({ platform: _platform, users, currentOwner, onChange }: OwnerSelectProps) {
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const handleChange = (value: string) => {
    if (!value) {
      onChange(value);
      return;
    }
    setPendingUserId(value);
  };

  const confirm = () => {
    if (pendingUserId !== null) {
      onChange(pendingUserId);
      setPendingUserId(null);
    }
  };

  const cancel = () => setPendingUserId(null);

  return (
    <div className={`${styles['settings-field']} ${'bridge-owner-field'}`}>
      <label className={`${styles['settings-field-label']} ${'bridge-owner-label'}`}>{t('settings.bridge.ownerSelect')}</label>
      <p className="bridge-owner-warning">{t('settings.bridge.ownerWarning')}</p>
      <select
        className={`${styles['settings-input']} ${'bridge-owner-select'}`}
        value={currentOwner || ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={users.length === 0}
      >
        <option value="">{users.length > 0 ? '-' : t('settings.bridge.ownerNone')}</option>
        {users.map((u) => (
          <option key={u.userId} value={u.userId}>{u.name || u.userId}</option>
        ))}
      </select>

      {pendingUserId !== null && (
        <div className={`${styles['memory-confirm-overlay']} ${styles['visible']}`} onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}>
          <div className={styles['memory-confirm-card']}>
            <p className={styles['memory-confirm-text']}>
              {t('settings.bridge.ownerConfirmText')}
            </p>
            <div className={styles['memory-confirm-actions']}>
              <button type="button" className={styles['memory-confirm-cancel']} onClick={cancel}>
                {t('settings.bridge.ownerConfirmCancel')}
              </button>
              <button type="button" className={styles['memory-confirm-primary']} onClick={confirm}>
                {t('settings.bridge.ownerConfirmSave')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
