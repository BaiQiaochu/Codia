/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getAppVersion: vi.fn(),
  getAutoLaunchStatus: vi.fn(),
  setAutoLaunchEnabled: vi.fn(),
  autoSaveConfig: vi.fn(),
  gsapFetch: vi.fn(),
}));

vi.mock('../../helpers', () => ({
  t: (key: string) => key,
  VALID_THEMES: ['codia-lilac'],
  autoSaveConfig: (...args: unknown[]) => mocks.autoSaveConfig(...args),
}));
vi.mock('../../api', () => ({ gsapFetch: (...args: unknown[]) => mocks.gsapFetch(...args) }));
vi.mock('../../actions', () => ({ loadSettingsConfig: vi.fn() }));
vi.mock('../../../utils/desktop-api', () => ({ getDesktopApi: () => mocks }));

import { AboutTab } from '../AboutTab';
import { useSettingsStore } from '../../store';

beforeEach(() => {
  mocks.getAppVersion.mockResolvedValue('0.2.0');
  mocks.getAutoLaunchStatus.mockResolvedValue({ supported: true, openAtLogin: false });
  mocks.setAutoLaunchEnabled.mockResolvedValue({ supported: true, openAtLogin: true });
  mocks.autoSaveConfig.mockResolvedValue(true);
  mocks.gsapFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  useSettingsStore.setState({ settingsConfig: {}, platformName: 'win32' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useSettingsStore.setState({ settingsConfig: null });
});

describe('combined general settings', () => {
  it('composes sections in order under one module and keeps product information last', async () => {
    const { container } = render(<AboutTab />);
    expect(await screen.findByText('v0.2.0')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-tab]')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 2 }).map(node => node.textContent)).toEqual([
      'settings.general.startup.title',
      'settings.general.quickChat.title',
      'settings.general.notifications.title',
      'settings.appearance.chatLayout',
      'settings.editor.title',
      'settings.interface.sidebar',
      'settings.interface.system',
      'settings.interface.shortcuts',
      'settings.locale.title',
      'settings.about.title',
    ]);
    const logo = screen.getByRole('img', { name: 'Codia 小豆蔻' });
    expect(logo).toHaveAttribute('src', expect.stringContaining('codia-flower'));
    expect(logo.parentElement).toHaveTextContent('Codia · 小豆蔻');
    expect(container.textContent).not.toContain('G-SAP');
  });

  it('updates the single launch setting using the desktop result', async () => {
    render(<AboutTab />);
    const control = await screen.findByRole('switch', { name: 'settings.general.launchAtLogin' });
    expect(screen.getAllByRole('switch', { name: 'settings.general.launchAtLogin' })).toHaveLength(1);
    fireEvent.click(control);
    await waitFor(() => expect(mocks.setAutoLaunchEnabled).toHaveBeenCalledWith(true));
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('omits launch controls when the platform cannot change startup', async () => {
    mocks.getAutoLaunchStatus.mockResolvedValue({ supported: false, openAtLogin: false });
    render(<AboutTab />);
    await waitFor(() => expect(mocks.getAutoLaunchStatus).toHaveBeenCalled());
    expect(screen.queryByRole('switch', { name: 'settings.general.launchAtLogin' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'settings.general.keepAwake' })).toBeInTheDocument();
  });
});
