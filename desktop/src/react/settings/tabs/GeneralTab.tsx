import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../store';
import { gsapFetch } from '../api';
import { autoSaveConfig, t } from '../helpers';
import { loadSettingsConfig } from '../actions';
import { getDesktopApi } from '../../utils/desktop-api';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { Toggle } from '../widgets/Toggle';
import { SelectWidget } from '../widgets/SelectWidget';
import type { AutoLaunchStatus } from '../../types';
import {
  normalizeNotificationPreferences as normalizeSharedNotificationPreferences,
  normalizeTurnCompletionNotificationMode,
} from '../../../../../shared/notification-preferences.ts';
import {
  DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES,
  DEFAULT_QUICK_CHAT_SHORTCUT,
  normalizeQuickChatPreferences,
} from '../../../../../shared/quick-chat-preferences.ts';
import styles from '../Settings.module.css';

type TurnCompletionNotificationMode = 'never' | 'when_unfocused' | 'when_session_unfocused';

interface NotificationPreferences {
  turnCompletion: TurnCompletionNotificationMode;
}

interface QuickChatPreferences {
  shortcut: string;
  reuseTimeoutMinutes: number;
}

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  turnCompletion: 'never',
};

function formatShortcut(shortcut: string): string[] {
  return String(shortcut || DEFAULT_QUICK_CHAT_SHORTCUT)
    .split('+')
    .map(part => part.trim())
    .filter(Boolean);
}

function keyLabel(key: string): string {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  if (key === 'CommandOrControl') return isMac ? 'Cmd' : 'Ctrl';
  if (key === 'Control') return 'Ctrl';
  if (key === 'Alt') return isMac ? 'Opt' : 'Alt';
  if (key === 'Shift') return 'Shift';
  if (key === 'Space') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

function keyTokenFromKeyboardEvent(event: KeyboardEvent): string | null {
  if (event.code === 'Space' || event.key === ' ' || event.key === '\u00A0' || event.key === 'Spacebar') {
    return 'Space';
  }
  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
  };
  if (keyMap[event.code]) return keyMap[event.code];
  if (keyMap[event.key]) return keyMap[event.key];
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  const key = event.key || '';
  return key.length === 1 ? key : key || null;
}

function keyFromEvent(event: KeyboardEvent): string | null {
  if (event.key === 'Escape') return null;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const rawKey = keyTokenFromKeyboardEvent(event);
  if (!rawKey) return null;
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length === 0 && !isFunctionKey) return null;
  parts.push(key);
  return parts.join('+');
}

function ShortcutKeycaps({ shortcut }: { shortcut: string }) {
  return (
    <span className={styles['shortcut-keycaps']}>
      {formatShortcut(shortcut).map((part) => (
        <span key={part} className={styles['shortcut-keycap']}>{keyLabel(part)}</span>
      ))}
    </span>
  );
}

function ShortcutRecorder({
  value,
  recording,
  saving,
  onStart,
  onRestoreDefault,
}: {
  value: string;
  recording: boolean;
  saving: boolean;
  onStart: () => void;
  onRestoreDefault: () => void;
}) {
  return (
    <div className={styles['quick-chat-shortcut-control']}>
      <button
        type="button"
        className={`${styles['quick-chat-shortcut-button']} ${recording ? styles.recording : ''}`}
        aria-label={t('settings.general.quickChat.shortcut')}
        onClick={onStart}
        disabled={saving}
      >
        {recording ? t('settings.general.quickChat.recording') : <ShortcutKeycaps shortcut={value} />}
      </button>
      <button
        type="button"
        className={styles['quick-chat-reset-button']}
        onClick={onRestoreDefault}
        disabled={saving || value === DEFAULT_QUICK_CHAT_SHORTCUT}
      >
        {t('settings.general.quickChat.restoreDefault')}
      </button>
    </div>
  );
}

function ReuseTimeoutInput({
  value,
  saving,
  onChange,
}: {
  value: number;
  saving: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className={styles['quick-chat-timeout-control']}>
      <input
        className={styles['quick-chat-timeout-input']}
        type="number"
        min={0}
        max={120}
        step={1}
        inputMode="numeric"
        aria-label={t('settings.general.quickChat.reuseTimeout')}
        value={Number.isFinite(value) ? value : DEFAULT_QUICK_CHAT_REUSE_TIMEOUT_MINUTES}
        disabled={saving}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <span className={styles['quick-chat-timeout-unit']}>{t('settings.general.quickChat.minutes')}</span>
    </div>
  );
}

function normalizeTurnCompletionMode(value: unknown): TurnCompletionNotificationMode {
  return normalizeTurnCompletionNotificationMode(value) as TurnCompletionNotificationMode;
}

function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  return normalizeSharedNotificationPreferences(value) as NotificationPreferences;
}

interface GeneralSettingsProps {
  showStartup?: boolean;
  showAutoLaunch?: boolean;
}

export function GeneralTab({ embedded = false, ...sectionProps }: GeneralSettingsProps & { embedded?: boolean } = {}) {
  return (
    <div
      className={embedded ? styles['settings-embedded-tab-content'] : `${styles['settings-tab-content']} ${styles.active}`}
      data-tab="general"
    >
      <GeneralSettingsSections {...sectionProps} />
    </div>
  );
}

export function GeneralSettingsSections({ showStartup = true, showAutoLaunch = true }: GeneralSettingsProps = {}) {
  const desktopApi = getDesktopApi();
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const showToast = useSettingsStore(s => s.showToast);
  const [autoLaunch, setAutoLaunch] = useState<AutoLaunchStatus | null>(null);
  const [autoLaunchSaving, setAutoLaunchSaving] = useState(false);
  const [keepAwakeSaving, setKeepAwakeSaving] = useState(false);
  const [quickChatPrefs, setQuickChatPrefs] = useState<QuickChatPreferences>(() => normalizeQuickChatPreferences());
  const [quickChatSaving, setQuickChatSaving] = useState(false);
  const [quickChatRecording, setQuickChatRecording] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationPrefs, setNotificationPrefs] = useState<NotificationPreferences>(DEFAULT_NOTIFICATION_PREFERENCES);
  const keepAwake = settingsConfig?.keep_awake === true;

  useEffect(() => {
    let alive = true;
    desktopApi?.getAutoLaunchStatus?.()
      .then((status) => {
        if (alive) setAutoLaunch(status || null);
      })
      .catch(() => {
        if (alive) setAutoLaunch(null);
      });
    return () => {
      alive = false;
    };
  }, [desktopApi]);

  useEffect(() => {
    let alive = true;
    gsapFetch('/api/preferences/quick-chat')
      .then(res => res.json())
      .then((data) => {
        if (alive) setQuickChatPrefs(normalizeQuickChatPreferences(data?.quickChat));
      })
      .catch((err) => {
        if (alive) showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast]);

  useEffect(() => {
    let alive = true;
    gsapFetch('/api/preferences/notifications')
      .then(res => res.json())
      .then((data) => {
        if (alive) setNotificationPrefs(normalizeNotificationPreferences(data?.notifications));
      })
      .catch((err) => {
        if (alive) showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
      });
    return () => {
      alive = false;
    };
  }, [showToast]);

  const saveQuickChatPreferences = useCallback(async (
    patch: Partial<QuickChatPreferences>,
    options: { reloadShortcut?: boolean; eventName?: string } = {},
  ) => {
    const previous = quickChatPrefs;
    const next = normalizeQuickChatPreferences({ ...quickChatPrefs, ...patch });
    setQuickChatPrefs(next);
    setQuickChatSaving(true);
    try {
      const res = await gsapFetch('/api/preferences/quick-chat', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quickChat: next }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      const saved = normalizeQuickChatPreferences(data?.quickChat);
      setQuickChatPrefs(saved);
      if (options.reloadShortcut) {
        const registration = await desktopApi?.quickChatReloadShortcut?.();
        if (registration && registration.ok === false) {
          throw new Error(registration.error || t('settings.general.quickChat.registrationFailed'));
        }
      }
      if (options.eventName) desktopApi?.settingsChanged?.(options.eventName, { quickChat: saved });
    } catch (err: any) {
      setQuickChatPrefs(previous);
      try {
        await gsapFetch('/api/preferences/quick-chat', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quickChat: previous }),
        });
        if (options.reloadShortcut) await desktopApi?.quickChatReloadShortcut?.();
      } catch {}
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setQuickChatSaving(false);
    }
  }, [desktopApi, quickChatPrefs, showToast]);

  const saveQuickChatShortcut = useCallback((shortcut: string) => saveQuickChatPreferences(
    { shortcut },
    { reloadShortcut: true, eventName: 'quick-chat-shortcut-changed' },
  ), [saveQuickChatPreferences]);

  const saveQuickChatReuseTimeout = useCallback((reuseTimeoutMinutes: number) => saveQuickChatPreferences(
    { reuseTimeoutMinutes },
    { eventName: 'quick-chat-preferences-changed' },
  ), [saveQuickChatPreferences]);

  useEffect(() => {
    if (!quickChatRecording) return undefined;
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setQuickChatRecording(false);
        return;
      }
      const shortcut = keyFromEvent(event);
      if (!shortcut) return;
      setQuickChatRecording(false);
      void saveQuickChatShortcut(shortcut);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [quickChatRecording, saveQuickChatShortcut]);

  const handleAutoLaunchToggle = useCallback(async (on: boolean) => {
    if (!desktopApi?.setAutoLaunchEnabled) return;
    const previous = autoLaunch;
    setAutoLaunchSaving(true);
    setAutoLaunch((status) => status ? { ...status, openAtLogin: on } : status);
    try {
      const next = await desktopApi.setAutoLaunchEnabled(on);
      setAutoLaunch(next || previous);
    } catch {
      setAutoLaunch(previous);
    } finally {
      setAutoLaunchSaving(false);
    }
  }, [autoLaunch, desktopApi]);

  const handleKeepAwakeToggle = useCallback(async (on: boolean) => {
    if (!desktopApi?.setKeepAwakeEnabled) return;
    const previous = settingsConfig?.keep_awake === true;
    setKeepAwakeSaving(true);
    try {
      const saved = await autoSaveConfig({ keep_awake: on }, { silent: true });
      if (saved === false) return;
      await desktopApi.setKeepAwakeEnabled(on);
      desktopApi.settingsChanged?.('keep-awake-changed', { keep_awake: on });
    } catch (err: any) {
      if (previous !== on) {
        await autoSaveConfig({ keep_awake: previous }, { silent: true });
        await loadSettingsConfig();
      }
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setKeepAwakeSaving(false);
    }
  }, [desktopApi, settingsConfig?.keep_awake, showToast]);

  const handleTurnCompletionChange = useCallback(async (value: string) => {
    const turnCompletion = normalizeTurnCompletionMode(value);
    const previous = notificationPrefs;
    const next = { turnCompletion };
    setNotificationPrefs(next);
    setNotificationSaving(true);
    try {
      const res = await gsapFetch('/api/preferences/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: next }),
      });
      const data = await res.json();
      if (data?.error) throw new Error(data.error);
      setNotificationPrefs(normalizeNotificationPreferences(data?.notifications));
    } catch (err: any) {
      setNotificationPrefs(previous);
      showToast(t('settings.saveFailed') + ': ' + (err?.message || String(err)), 'error');
    } finally {
      setNotificationSaving(false);
    }
  }, [notificationPrefs, showToast]);

  return (
    <>
      {showStartup && <SettingsSection title={t('settings.general.startup.title')}>
        {showAutoLaunch && autoLaunch?.supported && (
          <SettingsRow
            label={t('settings.general.launchAtLogin')}
            hint={t('settings.general.launchAtLoginDesc')}
            control={(
              <Toggle
                on={autoLaunch.openAtLogin}
                onChange={handleAutoLaunchToggle}
                label={t('settings.general.launchAtLogin')}
                disabled={autoLaunchSaving}
              />
            )}
          />
        )}
        <SettingsRow
          label={t('settings.general.keepAwake')}
          hint={t('settings.general.keepAwakeDesc')}
          control={(
            <Toggle
              on={keepAwake}
              onChange={handleKeepAwakeToggle}
              label={t('settings.general.keepAwake')}
              disabled={keepAwakeSaving || !desktopApi?.setKeepAwakeEnabled}
            />
          )}
        />
      </SettingsSection>}

      <SettingsSection title={t('settings.general.quickChat.title')}>
        <SettingsRow
          label={t('settings.general.quickChat.shortcut')}
          hint={t('settings.general.quickChat.shortcutHint')}
          control={(
            <ShortcutRecorder
              value={quickChatPrefs.shortcut}
              recording={quickChatRecording}
              saving={quickChatSaving}
              onStart={() => setQuickChatRecording(true)}
              onRestoreDefault={() => void saveQuickChatShortcut(DEFAULT_QUICK_CHAT_SHORTCUT)}
            />
          )}
        />
        <SettingsRow
          label={t('settings.general.quickChat.reuseTimeout')}
          hint={t('settings.general.quickChat.reuseTimeoutHint')}
          control={(
            <ReuseTimeoutInput
              value={quickChatPrefs.reuseTimeoutMinutes}
              saving={quickChatSaving}
              onChange={(value) => void saveQuickChatReuseTimeout(value)}
            />
          )}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.general.notifications.title')}>
        <SettingsRow
          label={t('settings.general.notifications.turnCompletion')}
          control={(
            <SelectWidget
              options={[
                { value: 'never', label: t('settings.general.notifications.turnCompletionNever') },
                { value: 'when_unfocused', label: t('settings.general.notifications.turnCompletionWhenUnfocused') },
                { value: 'when_session_unfocused', label: t('settings.general.notifications.turnCompletionWhenSessionUnfocused') },
              ]}
              value={notificationPrefs.turnCompletion}
              onChange={handleTurnCompletionChange}
              disabled={notificationSaving}
            />
          )}
        />
      </SettingsSection>
    </>
  );
}
