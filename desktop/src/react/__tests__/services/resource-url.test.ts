import { describe, expect, it, vi } from 'vitest';
import { resolveFileRefUrl } from '../../services/resource-url';
import type { FileRef } from '../../types/file-ref';
import type { ServerConnection } from '../../services/server-connection';

function fileRef(overrides: Partial<FileRef> = {}): FileRef {
  return {
    id: 'file-1',
    kind: 'image',
    source: 'desk',
    name: 'cover.png',
    path: 'E:\\文档\\cover.png',
    ...overrides,
  };
}

function remoteConnection(): ServerConnection {
  return {
    connectionId: 'remote-1',
    kind: 'lan',
    serverId: 'remote',
    studioId: 'studio-1',
    label: 'Remote',
    baseUrl: 'https://remote.example.test/',
    wsUrl: 'wss://remote.example.test/',
    token: 'secret-token',
    authState: 'paired',
    trustState: 'lan',
    credentialKind: 'device_credential',
    platformAccountId: null,
    officialServiceKind: null,
    capabilities: ['resources'],
  };
}

describe('resolveFileRefUrl', () => {
  it('uses local file URLs with version tokens for local desktop refs', () => {
    const getFileUrl = vi.fn((path: string) => `file:///${encodeURIComponent(path)}`);

    const result = resolveFileRefUrl(fileRef({
      version: { mtimeMs: 1710000000000, size: 2048, sha256: 'abc' },
    }), {
      platform: { getFileUrl },
    });

    expect(result.mode).toBe('local-file');
    expect(result.url).toContain('v=1710000000000-2048-abc');
    expect(getFileUrl).toHaveBeenCalledWith('E:\\文档\\cover.png');
  });

  it('uses resource content links for remote refs instead of leaking server-local paths', () => {
    const result = resolveFileRefUrl(fileRef({
      path: 'E:\\server-only\\cover.png',
      version: { mtimeMs: 1710000000000, size: 4096 },
      resource: {
        resourceId: 'resource-1',
        studioId: 'studio-1',
        links: {
          self: '/api/resources/resource-1',
          content: '/api/resources/resource-1/content',
        },
      },
    }), {
      connection: remoteConnection(),
      platform: { getFileUrl: () => 'file:///should-not-be-used.png' },
    });

    expect(result.mode).toBe('resource-content');
    expect(result.url).toBe('https://remote.example.test/api/resources/resource-1/content?v=1710000000000-4096');
  });

  it('does not treat non-owner local transports as native-file capable', () => {
    const getFileUrl = vi.fn(() => 'file:///should-not-be-used.png');

    const result = resolveFileRefUrl(fileRef({
      path: 'E:\\server-only\\cover.png',
      resource: {
        resourceId: 'resource-2',
        studioId: 'studio-1',
        links: {
          self: '/api/resources/resource-2',
          content: '/api/resources/resource-2/content',
        },
      },
    }), {
      connection: {
        ...remoteConnection(),
        connectionId: 'local-non-owner',
        kind: 'local',
        baseUrl: 'http://127.0.0.1:14500',
        wsUrl: 'ws://127.0.0.1:14500',
      },
      platform: { getFileUrl },
    });

    expect(result.mode).toBe('resource-content');
    expect(result.url).toBe('http://127.0.0.1:14500/api/resources/resource-2/content');
    expect(getFileUrl).not.toHaveBeenCalled();
  });
});
