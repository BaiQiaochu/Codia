import { useMemo } from 'react';
import { useStore } from '../stores';
import { CloudWorkspace } from '../mobile/CloudWorkspace';
import { createCloudWorkspaceClient, type CloudWorkspaceClient } from '../mobile/cloud-workspace-api';
import { appendConnectionAuth, buildConnectionUrl, requireServerConnection, type ServerConnection } from '../services/server-connection';
import { openProviderModelSettings } from '../utils/model-settings-navigation';
import '../mobile/CloudWorkspace.css';

/** Use the actual selected server and its existing authorization. Never put credentials in download URLs. */
export function createDesktopCloudClient(connection: ServerConnection): CloudWorkspaceClient {
  const request = (path: string, init: RequestInit = {}) => fetch(buildConnectionUrl(connection, path), {
    ...init,
    headers: appendConnectionAuth(connection, init.headers),
  });
  const client = createCloudWorkspaceClient(request);
  return {
    ...client,
    contentUrl: (versionId, download) => buildConnectionUrl(connection, client.contentUrl(versionId, download)),
    async download(versionId, filename) {
      const response = await client.content(versionId);
      if (!response.ok) throw new Error(`下载未完成（${response.status}），请检查连接后重试。`);
      const url = URL.createObjectURL(await response.blob());
      // eslint-disable-next-line no-restricted-syntax -- intentional low-level authenticated Blob download, not rendered UI
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give Chromium time to consume the object URL before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}

export function DesktopCloudWorkspace() {
  const activeConnection = useStore(state => state.activeServerConnection);
  const serverPort = useStore(state => state.serverPort);
  const serverToken = useStore(state => state.serverToken);
  const connection = useMemo(() => {
    try { return requireServerConnection({ activeServerConnection: activeConnection, serverPort, serverToken }, '工作空间服务尚未连接'); }
    catch { return null; }
  }, [activeConnection, serverPort, serverToken]);
  const client = useMemo(() => connection ? createDesktopCloudClient(connection) : null, [connection]);
  if (!connection || !client) return <div className="cw-initial-loading" role="status">正在连接工作空间服务…</div>;
  return <CloudWorkspace
    key={`${connection.connectionId}:${connection.baseUrl}:${connection.userId || ''}`}
    principal={{ userId: `${connection.serverId}:${connection.userId || connection.connectionId}` }}
    client={client}
    desktop
    onConfigureAI={() => openProviderModelSettings()}
  />;
}
