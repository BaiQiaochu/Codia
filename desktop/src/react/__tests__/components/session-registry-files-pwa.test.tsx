// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let storeState: Record<string, unknown> = {};

vi.mock('../../stores', () => ({
  useStore: Object.assign(
    (selector?: (state: Record<string, unknown>) => unknown) => selector ? selector(storeState) : storeState,
    {
      getState: () => storeState,
      setState: (partial: Record<string, unknown>) => { storeState = { ...storeState, ...partial }; },
    },
  ),
}));

describe('SessionRegistryFilesPanel PWA behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.setAttribute('data-platform', 'web');
    (window as typeof window & { t?: (key: string, vars?: Record<string, string | number>) => string }).t = (key, vars) =>
      vars?.n ? `${key}:${vars.n}` : key;
    (window as typeof window & { __CODIA_PWA__?: { serverUrl: (path: string) => string } }).__CODIA_PWA__ = {
      serverUrl: (path: string) => `https://pwa.local${path}`,
    };
    (window as typeof window & { platform?: unknown }).platform = undefined;
    storeState = {
      currentSessionPath: '/sessions/pwa.jsonl',
      chatSessions: { '/sessions/pwa.jsonl': { items: [] } },
      sessionRegistryFilesByPath: {
        '/sessions/pwa.jsonl': [{
          fileId: 'sf_report',
          filePath: '/remote/report.md',
          label: 'report.md',
          ext: 'md',
          mime: 'text/markdown',
          status: 'available',
          createdAt: 123,
          origin: 'agent_write',
          resource: {
            resourceId: 'res_sf_report',
            studioId: 'studio_1',
            links: {
              self: '/api/resources/res_sf_report',
              content: '/api/resources/res_sf_report/content',
            },
          },
        }],
      },
      deskFiles: [],
      deskBasePath: '',
      deskCurrentPath: '',
    };
  });

  afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute('data-platform');
    delete (window as typeof window & { __CODIA_PWA__?: unknown }).__CODIA_PWA__;
  });

  it('renders preview and download actions for resource-backed files without desktop platform APIs', async () => {
    const { SessionRegistryFilesPanel } = await import('../../components/right-workspace/SessionRegistryFilesPanel');

    render(<SessionRegistryFilesPanel />);

    const preview = screen.getByRole('button', {
      name: 'rightWorkspace.sessionFiles.actions.preview report.md',
    }) as HTMLButtonElement;
    expect(preview.disabled).toBe(false);

    const download = screen.getByRole('link', {
      name: 'rightWorkspace.sessionFiles.actions.downloadToDevice report.md',
    }) as HTMLAnchorElement;
    expect(download.getAttribute('href')).toBe('https://pwa.local/api/resources/res_sf_report/content');
    expect(download.getAttribute('download')).toBe('report.md');
  });
});
