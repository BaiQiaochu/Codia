import { describe, expect, it } from 'vitest';
import {
  canUseNativeResourcePath,
  resolveFileRefPreviewAccess,
  resolveWorkbenchFilePreviewAccess,
} from '../../services/resource-access';
import type { ServerConnection } from '../../services/server-connection';
import type { DeskFile } from '../../types';
import type { FileRef } from '../../types/file-ref';

const localConnection: ServerConnection = {
  connectionId: 'local',
  kind: 'local',
  serverId: 'local',
  studioId: 'local',
  label: 'Local G-SAP',
  baseUrl: 'http://127.0.0.1:14500',
  wsUrl: 'ws://127.0.0.1:14500',
  token: 'token',
  authState: 'paired',
  trustState: 'local',
  credentialKind: 'loopback_token',
  platformAccountId: null,
  officialServiceKind: null,
  capabilities: ['resources', 'files'],
};

const remoteConnection: ServerConnection = {
  ...localConnection,
  connectionId: 'browser:server_lan',
  kind: 'lan',
  serverId: 'server_lan',
  studioId: 'studio_lan',
  label: 'LAN G-SAP',
  baseUrl: 'http://gsap.local:14500',
  wsUrl: 'ws://gsap.local:14500',
  token: null,
  trustState: 'lan',
  credentialKind: 'device_credential',
};

function fileRef(patch: Partial<FileRef> = {}): FileRef {
  return {
    id: 'session-registry:/tmp/report.md',
    fileId: 'sf_report',
    kind: 'markdown',
    source: 'session-registry',
    name: 'report.md',
    path: '/tmp/report.md',
    ext: 'md',
    status: 'available',
    resource: {
      resourceId: 'res_sf_report',
      studioId: 'studio_lan',
      links: {
        self: '/api/resources/res_sf_report',
        content: '/api/resources/res_sf_report/content',
      },
    },
    ...patch,
  };
}

function deskFile(patch: Partial<DeskFile> = {}): DeskFile {
  return {
    name: 'note.md',
    isDir: false,
    mtime: '2026-06-25T01:02:03.000Z',
    size: 12,
    ...patch,
  };
}

describe('resource access resolver', () => {
  it('treats only loopback-owned local connections as native-path capable', () => {
    expect(canUseNativeResourcePath({ connection: localConnection })).toBe(true);
    expect(canUseNativeResourcePath({ connection: remoteConnection })).toBe(false);
    expect(canUseNativeResourcePath({
      connection: {
        ...localConnection,
        credentialKind: 'device_credential',
      },
    })).toBe(false);
  });

  it('uses FileRef native paths only for the owner process and content links for remote clients', () => {
    expect(resolveFileRefPreviewAccess(fileRef(), { connection: localConnection })).toEqual({
      mode: 'native-path',
      path: '/tmp/report.md',
    });

    expect(resolveFileRefPreviewAccess(fileRef(), { connection: remoteConnection })).toEqual({
      mode: 'resource-content',
      contentPath: '/api/resources/res_sf_report/content',
      resourceId: 'res_sf_report',
    });
  });

  it('routes default workbench files through ResourceIO content for remote clients', () => {
    const access = resolveWorkbenchFilePreviewAccess({
      file: deskFile(),
      subdir: 'notes',
      localRootPath: '/Users/me/project',
      mountId: null,
    }, { connection: remoteConnection });

    expect(access).toMatchObject({
      mode: 'workbench-content',
      mountId: 'default',
      rootId: 'default',
      contentPath: '/api/workbench/content?mountId=default&subdir=notes&name=note.md',
      remoteContentRef: {
        kind: 'workbench-file',
        mountId: 'default',
        rootId: 'default',
        subdir: 'notes',
        name: 'note.md',
      },
    });
  });

  it('keeps local default workbench preview on the native fast path', () => {
    expect(resolveWorkbenchFilePreviewAccess({
      file: deskFile(),
      subdir: 'notes',
      localRootPath: '/Users/me/project',
      mountId: null,
    }, { connection: localConnection })).toEqual({
      mode: 'native-path',
      path: '/Users/me/project/notes/note.md',
      ext: 'md',
      sourceRootPath: '/Users/me/project',
    });
  });
});
