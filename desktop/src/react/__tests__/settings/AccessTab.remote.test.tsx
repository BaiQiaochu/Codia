// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessTab } from '../../settings/tabs/AccessTab';
import { useSettingsStore } from '../../settings/store';

const gsapFetchMock = vi.fn();

vi.mock('../../settings/api', () => ({
  gsapFetch: (...args: unknown[]) => gsapFetchMock(...args),
  gsapUrl: (path: string) => `http://127.0.0.1:14500${path}`,
}));

describe('AccessTab remote connection guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as typeof window & { t?: (key: string) => string }).t = (key: string) => ({
      'settings.access.remoteConnection': '当前连接的是远端 G-SAP',
      'settings.access.remoteConnectionDesc': '远端连接说明',
      'settings.access.remoteConnectionName': '连接名称',
      'settings.access.remoteConnectionKind': '连接类型',
      'settings.access.remoteConnectionUrl': '服务器地址',
      'settings.access.remoteLocalOnlyNote': '请先切回本机 G-SAP',
      'settings.access.returnToLocal': '切回本机',
    }[key] || key);
    useSettingsStore.setState({
      showToast: vi.fn(),
      serverConnections: {
        'lan:node:studio': {
          connectionId: 'lan:node:studio',
          kind: 'lan',
          label: '工作站',
          baseUrl: 'http://192.168.31.75:14500',
          wsUrl: 'ws://192.168.31.75:14500',
          token: 'gsap_dev_remote_secret',
          trustState: 'lan',
          credentialKind: 'device_credential',
          capabilities: ['chat'],
        },
      },
      activeServerConnectionId: 'lan:node:studio',
      activeServerConnection: {
        connectionId: 'lan:node:studio',
        kind: 'lan',
        label: '工作站',
        baseUrl: 'http://192.168.31.75:14500',
        wsUrl: 'ws://192.168.31.75:14500',
        token: 'gsap_dev_remote_secret',
        trustState: 'lan',
        credentialKind: 'device_credential',
        capabilities: ['chat'],
      },
    } as any);
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a remote-only panel instead of loading local access settings', async () => {
    render(<AccessTab />);

    expect(screen.getByText('当前连接的是远端 G-SAP')).toBeTruthy();
    expect(screen.getByText('工作站')).toBeTruthy();
    expect(screen.getByText('http://192.168.31.75:14500')).toBeTruthy();
    expect((screen.getByRole('button', { name: '切回本机' }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => {
      expect(gsapFetchMock).not.toHaveBeenCalledWith('/api/access/summary');
    });
  });
});
