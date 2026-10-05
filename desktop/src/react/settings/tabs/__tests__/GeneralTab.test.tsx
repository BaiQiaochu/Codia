/**
 * @vitest-environment jsdom
 */

import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getAutoLaunchStatus = vi.fn();
const setAutoLaunchEnabled = vi.fn();
const setKeepAwakeEnabled = vi.fn();
const quickChatReloadShortcut = vi.fn();
const settingsChanged = vi.fn();
const autoSaveConfig = vi.fn();
const loadSettingsConfig = vi.fn();
const gsapFetch = vi.fn();
const desktopApi = {
  getAutoLaunchStatus,
  setAutoLaunchEnabled,
  setKeepAwakeEnabled,
  quickChatReloadShortcut,
  settingsChanged,
};

vi.mock('../../api', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetch(...args),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  autoSaveConfig: (...args: unknown[]) => autoSaveConfig(...args),
}));

vi.mock('../../actions', () => ({
  loadSettingsConfig: (...args: unknown[]) => loadSettingsConfig(...args),
}));

vi.mock('../../../utils/desktop-api', () => ({
  getDesktopApi: () => desktopApi,
}));

vi.mock('../../widgets/Toggle', () => ({
  Toggle: ({
    on,
    onChange,
    label,
    ariaLabel,
    disabled,
  }: {
    on: boolean;
    onChange: (next: boolean) => void;
    label?: string;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <button
      type="button"
      aria-label={ariaLabel || label}
      data-testid={`${ariaLabel || label}-${on ? 'on' : 'off'}`}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      toggle
    </button>
  ),
}));

vi.mock('../../widgets/SelectWidget', () => ({
  SelectWidget: ({
    options,
    value,
    onChange,
    disabled,
  }: {
    options: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="turn-completion-notification"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value)}
    >
      {options.map(option => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

import { GeneralTab } from '../GeneralTab';
import { useSettingsStore } from '../../store';

function jsonResponse(data: unknown) {
  return {
    json: vi.fn(async () => data),
  };
}

beforeEach(() => {
  getAutoLaunchStatus.mockResolvedValue({
    supported: true,
    openAtLogin: false,
    openedAtLogin: false,
    status: null,
  });
  gsapFetch.mockResolvedValue(jsonResponse({
    notifications: { turnCompletion: 'never' },
  }));
  quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'Alt+Space' });
  useSettingsStore.setState({
    settingsConfig: { keep_awake: false },
    toastMessage: '',
    toastType: '',
    toastVisible: false,
  });
});

afterEach(() => {
  cleanup();
  getAutoLaunchStatus.mockReset();
  setAutoLaunchEnabled.mockReset();
  setKeepAwakeEnabled.mockReset();
  quickChatReloadShortcut.mockReset();
  settingsChanged.mockReset();
  autoSaveConfig.mockReset();
  loadSettingsConfig.mockReset();
  gsapFetch.mockReset();
  useSettingsStore.setState({ settingsConfig: null });
  vi.unstubAllGlobals();
});

describe('GeneralTab', () => {
  it('renders startup and background controls in one section', async () => {
    render(<GeneralTab />);

    expect(await screen.findByText('settings.general.startup.title')).toBeInTheDocument();
    const launchRow = await screen.findByText('settings.general.launchAtLogin');
    const keepAwakeRow = screen.getByText('settings.general.keepAwake');
    const quickChatSection = screen.getByText('settings.general.quickChat.title');
    const notificationSection = screen.getByText('settings.general.notifications.title');

    expect(launchRow.compareDocumentPosition(keepAwakeRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keepAwakeRow.compareDocumentPosition(quickChatSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(quickChatSection.compareDocumentPosition(notificationSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('settings.general.launchAtLogin-off')).toBeInTheDocument();
    expect(screen.getByTestId('settings.general.keepAwake-off')).toBeInTheDocument();
  });

  it('updates the launch-at-login row from the main-process result', async () => {
    setAutoLaunchEnabled.mockResolvedValue({
      supported: true,
      openAtLogin: true,
      openedAtLogin: false,
      status: null,
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.launchAtLogin-off'));

    await waitFor(() => expect(setAutoLaunchEnabled).toHaveBeenCalledWith(true));
    await screen.findByTestId('settings.general.launchAtLogin-on');
  });

  it('persists keep-awake preference before applying it in the main process', async () => {
    autoSaveConfig.mockResolvedValue(undefined);
    loadSettingsConfig.mockResolvedValue(undefined);
    setKeepAwakeEnabled.mockResolvedValue({
      enabled: true,
      active: true,
      blockerId: 42,
      type: 'prevent-app-suspension',
    });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByTestId('settings.general.keepAwake-off'));

    await waitFor(() => expect(autoSaveConfig).toHaveBeenCalledWith({ keep_awake: true }, { silent: true }));
    await waitFor(() => expect(setKeepAwakeEnabled).toHaveBeenCalledWith(true));
    expect(autoSaveConfig.mock.invocationCallOrder[0]).toBeLessThan(setKeepAwakeEnabled.mock.invocationCallOrder[0]);
  });

  it('saves turn completion notification preference through the notification route', async () => {
    gsapFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space' } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { turnCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, notifications: { turnCompletion: 'when_session_unfocused' } }));

    render(<GeneralTab />);

    const select = await screen.findByLabelText('turn-completion-notification');
    expect(screen.getByText('settings.general.notifications.turnCompletionWhenSessionUnfocused')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'when_session_unfocused' } });

    await waitFor(() => expect(gsapFetch).toHaveBeenLastCalledWith('/api/preferences/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifications: { turnCompletion: 'when_session_unfocused' } }),
    }));
    expect((select as HTMLSelectElement).value).toBe('when_session_unfocused');
  });

  it('records and registers the quick chat shortcut', async () => {
    gsapFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { turnCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 } }));
    quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'CommandOrControl+Shift+K' });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByLabelText('settings.general.quickChat.shortcut'));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(gsapFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 } }),
    }));
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
    expect(settingsChanged).toHaveBeenCalledWith('quick-chat-shortcut-changed', {
      quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 5 },
    });
  });

  it('saves the quick chat reuse timeout without re-registering the shortcut', async () => {
    gsapFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { turnCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }));

    render(<GeneralTab />);

    const input = await screen.findByLabelText('settings.general.quickChat.reuseTimeout');
    fireEvent.change(input, { target: { value: '5' } });

    await waitFor(() => expect(gsapFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 5 } }),
    }));
    expect(quickChatReloadShortcut).not.toHaveBeenCalled();
  });

  it('records macOS Option+Space as Alt+Space instead of an invisible character', async () => {
    gsapFetch
      .mockResolvedValueOnce(jsonResponse({ quickChat: { shortcut: 'CommandOrControl+Shift+K', reuseTimeoutMinutes: 10 } }))
      .mockResolvedValueOnce(jsonResponse({ notifications: { turnCompletion: 'never' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }));
    quickChatReloadShortcut.mockResolvedValue({ ok: true, shortcut: 'Alt+Space' });

    render(<GeneralTab />);

    fireEvent.click(await screen.findByLabelText('settings.general.quickChat.shortcut'));
    fireEvent.keyDown(window, { key: '\u00A0', code: 'Space', altKey: true });

    await waitFor(() => expect(gsapFetch).toHaveBeenLastCalledWith('/api/preferences/quick-chat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quickChat: { shortcut: 'Alt+Space', reuseTimeoutMinutes: 10 } }),
    }));
    expect(quickChatReloadShortcut).toHaveBeenCalledOnce();
  });
});
