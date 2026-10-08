/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoUpdateState } from '../../types';
import { SidebarUpdateNoticeCard } from '../../components/notices/SidebarNoticeSlot';

const labels: Record<string, string> = {
  'settings.about.updateAvailable': 'New version available: v{version}',
  'settings.about.updateDownloading': '{agentName} is preparing an update {percent}%',
  'settings.about.updateProgress': '{percent}%',
  'settings.about.updateReadyInstall': 'v{version} ready to install',
  'settings.about.updateInstallManualHint': 'Install after clicking Restart to update',
  'settings.about.updateInstall': 'Restart to update',
  'settings.about.updateInstalling': 'Installing update. G-SAP will restart automatically',
  'settings.about.updateDiskSpace': 'Not enough disk space to download update',
  'settings.about.updateNeedInstall': 'Please move G-SAP to the Applications folder first',
  'settings.about.updateError': 'Update check failed',
  'window.close': 'Close',
};

function translate(key: string, vars?: Record<string, string | number>): string {
  let value = labels[key] ?? key;
  for (const [name, replacement] of Object.entries(vars ?? {})) {
    value = value.replace(`{${name}}`, String(replacement));
  }
  return value;
}

function updateState(partial: Partial<AutoUpdateState>): AutoUpdateState {
  return {
    status: 'idle',
    version: null,
    releaseNotes: null,
    releaseUrl: null,
    downloadUrl: null,
    progress: null,
    error: null,
    ...partial,
  };
}

describe('SidebarUpdateNoticeCard', () => {
  beforeEach(() => {
    window.t = translate as typeof window.t;
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('does not render for non-actionable updater states', () => {
    const { container, rerender } = render(
      <SidebarUpdateNoticeCard state={updateState({ status: 'idle' })} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'latest' })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not render until the update is ready to install', () => {
    const { container, rerender } = render(
      <SidebarUpdateNoticeCard state={updateState({ status: 'available', version: '0.235.0' })} />,
    );

    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({
      status: 'downloading',
      version: '0.235.0',
      progress: { percent: 42, bytesPerSecond: 1, transferred: 1, total: 2 },
    })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'downloaded', version: '0.235.0' })} />);
    expect(screen.getByText('v0.235.0 ready to install')).toBeInTheDocument();
  });

  it('keeps a ready update visible until the user dismisses that version', () => {
    const { container, rerender } = render(
      <SidebarUpdateNoticeCard state={updateState({ status: 'downloaded', version: '0.235.0' })} />,
    );

    expect(screen.getByText('v0.235.0 ready to install')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'downloaded', version: '0.235.0' })} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<SidebarUpdateNoticeCard state={updateState({ status: 'downloaded', version: '0.236.0' })} />);
    expect(screen.getByText('v0.236.0 ready to install')).toBeInTheDocument();
  });

  it('offers install action once the update is downloaded', () => {
    const onInstall = vi.fn();
    render(
      <SidebarUpdateNoticeCard
        state={updateState({ status: 'downloaded', version: '0.235.0' })}
        onInstall={onInstall}
      />,
    );

    expect(screen.getByText('v0.235.0 ready to install')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Restart to update/ }));
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});
