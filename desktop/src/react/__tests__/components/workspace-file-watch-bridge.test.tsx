// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resourceMocks = vi.hoisted(() => ({
  retainResourceWatch: vi.fn(),
  releases: [] as Array<ReturnType<typeof vi.fn>>,
}));

let storeState = {
  deskBasePath: 'C:/work',
  deskExpandedPaths: [] as string[],
  deskWorkspaceMountId: null as string | null,
  serverPort: '14500',
  activeServerConnection: null as unknown,
};

vi.mock('../../stores', () => ({
  get useStore() {
    return Object.assign(
      (selector?: (s: typeof storeState) => unknown) => (selector ? selector(storeState) : storeState),
      {
        getState: () => storeState,
      },
    );
  },
}));

vi.mock('../../services/resource-events', () => ({
  resourceWatchKey: (ref: { kind: string; path?: string; mountId?: string }) =>
    ref.kind === 'local-file'
      ? `local:${String(ref.path || '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()}`
      : `mount:${ref.mountId}:${String(ref.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}`,
  retainResourceWatch: (ref: unknown) => resourceMocks.retainResourceWatch(ref),
}));

describe('WorkspaceFileWatchBridge', () => {
  beforeEach(() => {
    storeState = {
      deskBasePath: 'C:/work',
      deskExpandedPaths: [],
      deskWorkspaceMountId: null,
      serverPort: '14500',
      activeServerConnection: null,
    };
    resourceMocks.releases = [];
    resourceMocks.retainResourceWatch.mockReset();
    resourceMocks.retainResourceWatch.mockImplementation(() => {
      const release = vi.fn();
      resourceMocks.releases.push(release);
      return release;
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('subscribes to the current local workspace root through ResourceIO', async () => {
    const { WorkspaceFileWatchBridge } = await import('../../components/right-workspace/WorkspaceFileWatchBridge');

    const view = render(<WorkspaceFileWatchBridge />);

    await waitFor(() => {
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: 'C:/work' });
    });

    view.unmount();
    await waitFor(() => {
      expect(resourceMocks.releases[0]).toHaveBeenCalled();
    });
  });

  it('subscribes to expanded local workspace directories and releases collapsed directories', async () => {
    storeState = {
      deskBasePath: 'C:/work',
      deskExpandedPaths: ['src', 'docs/api'],
      deskWorkspaceMountId: null,
      serverPort: '14500',
      activeServerConnection: null,
    };
    const { WorkspaceFileWatchBridge } = await import('../../components/right-workspace/WorkspaceFileWatchBridge');

    const view = render(<WorkspaceFileWatchBridge />);

    await waitFor(() => {
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: 'C:/work' });
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: 'C:/work/src' });
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: 'C:/work/docs/api' });
    });

    const releaseSrc = resourceMocks.releases[1];
    storeState = {
      deskBasePath: 'C:/work',
      deskExpandedPaths: ['docs/api'],
      deskWorkspaceMountId: null,
      serverPort: '14500',
      activeServerConnection: null,
    };
    view.rerender(<WorkspaceFileWatchBridge />);

    await waitFor(() => {
      expect(releaseSrc).toHaveBeenCalled();
    });
  });

  it('subscribes to mounted workspace refs without materializing native paths', async () => {
    storeState = {
      deskBasePath: 'studio:mount_docs',
      deskExpandedPaths: ['notes'],
      deskWorkspaceMountId: 'mount_docs',
      serverPort: '14500',
      activeServerConnection: null,
    };
    const { WorkspaceFileWatchBridge } = await import('../../components/right-workspace/WorkspaceFileWatchBridge');

    render(<WorkspaceFileWatchBridge />);

    await waitFor(() => {
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'mount', mountId: 'mount_docs', path: '' });
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'mount', mountId: 'mount_docs', path: 'notes' });
    });
    expect(resourceMocks.retainResourceWatch).not.toHaveBeenCalledWith({ kind: 'local-file', path: 'studio:mount_docs' });
  });

  it('dedupes normalized expanded subdir subscriptions', async () => {
    storeState = {
      deskBasePath: 'C:/work',
      deskExpandedPaths: ['notes', '/notes/', 'notes\\'],
      deskWorkspaceMountId: null,
      serverPort: '14500',
      activeServerConnection: null,
    };
    const { WorkspaceFileWatchBridge } = await import('../../components/right-workspace/WorkspaceFileWatchBridge');

    render(<WorkspaceFileWatchBridge />);

    await waitFor(() => {
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledTimes(2);
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: 'C:/work' });
      expect(resourceMocks.retainResourceWatch).toHaveBeenCalledWith({ kind: 'local-file', path: 'C:/work/notes' });
    });
  });
});
