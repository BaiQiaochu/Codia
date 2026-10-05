/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModalShell } from '../../components/SettingsModalShell';
import { useStore } from '../../stores';
import { openSettingsModal } from '../../stores/settings-modal-actions';
import { useSettingsStore } from '../../settings/store';

vi.mock('../../settings/SettingsContent', () => ({
  SettingsContent: ({ activeTabOverride, onActiveTabChange }: {
    activeTabOverride?: string;
    onActiveTabChange?: (tab: string) => void;
  }) => {
    const activeTab = useSettingsStore((s) => s.activeTab);
    const renderedTab = activeTabOverride || activeTab;
    useEffect(() => {
      onActiveTabChange?.(renderedTab);
    }, [onActiveTabChange, renderedTab]);
    return <div data-testid="settings-content" data-active-tab={renderedTab} />;
  },
}));

describe('SettingsModalShell active tab sync', () => {
  beforeEach(() => {
    window.t = ((key: string) => key) as typeof window.t;
    useSettingsStore.setState({ activeTab: 'agent', ready: true });
    useStore.setState({ settingsModal: { open: false, activeTab: 'agent' } });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders the requested modal tab on first open instead of falling back to the settings store default', async () => {
    useStore.setState({ settingsModal: { open: true, activeTab: 'plugin-marketplace' } });

    render(<SettingsModalShell />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-content').getAttribute('data-active-tab')).toBe('plugin-marketplace');
    });
    expect(useStore.getState().settingsModal.activeTab).toBe('plugin-marketplace');
  });

  it('normalizes the legacy computer settings tab to experiments before opening', async () => {
    openSettingsModal('computer');

    expect(useStore.getState().settingsModal.activeTab).toBe('experiments');

    render(<SettingsModalShell />);

    await waitFor(() => {
      expect(screen.getByTestId('settings-content').getAttribute('data-active-tab')).toBe('experiments');
    });
  });
});
