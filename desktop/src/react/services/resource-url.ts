import type { FileRef } from '../types/file-ref';
import { buildConnectionUrl, isLocalOwnerConnection, type ServerConnection } from './server-connection';

export type FileRefUrlMode = 'local-file' | 'resource-content' | 'inline-data' | 'direct-url';

export interface FileRefUrlResult {
  mode: FileRefUrlMode;
  url: string;
}

export interface ResourceUrlPlatform {
  getFileUrl?: (path: string) => string;
}

const DIRECT_MEDIA_URL_RE = /^(?:https?:|data:|blob:|file:)/i;

export function resolveFileRefUrl(ref: FileRef, {
  connection,
  platform,
  preferLocalFile = true,
  resourceContentUrl,
}: {
  connection?: ServerConnection | null;
  platform?: ResourceUrlPlatform | null;
  preferLocalFile?: boolean;
  resourceContentUrl?: (path: string) => string;
}): FileRefUrlResult {
  return resolveFileRefUrls(ref, {
    connection,
    platform,
    preferLocalFile,
    resourceContentUrl,
  })[0];
}

/**
 * Resolve every usable representation in retry order. Registered resources are
 * preferred for remote-safe previews, while local desktop callers can opt into
 * the native file channel first.
 */
export function resolveFileRefUrls(ref: FileRef, {
  connection,
  platform,
  preferLocalFile = true,
  resourceContentUrl,
}: {
  connection?: ServerConnection | null;
  platform?: ResourceUrlPlatform | null;
  preferLocalFile?: boolean;
  resourceContentUrl?: (path: string) => string;
}): FileRefUrlResult[] {
  const previewResult: FileRefUrlResult | null = ref.previewUrl && DIRECT_MEDIA_URL_RE.test(ref.previewUrl)
    ? { mode: 'direct-url', url: appendFileRefVersion(ref.previewUrl, ref) }
    : null;
  if (ref.path && DIRECT_MEDIA_URL_RE.test(ref.path)) {
    return [
      { mode: 'direct-url', url: appendFileRefVersion(ref.path, ref) },
      ...(previewResult && previewResult.url !== ref.path ? [previewResult] : []),
    ];
  }

  const isLocalTransport = !connection || isLocalOwnerConnection(connection);
  const getFileUrl = platform?.getFileUrl;
  const canUseLocalFile = isLocalTransport
    && !!ref.path
    && typeof getFileUrl === 'function';

  const localResult: FileRefUrlResult | null = canUseLocalFile
    ? { mode: 'local-file', url: appendFileRefVersion(getFileUrl(ref.path), ref) }
    : null;

  const resource = ref.resource;
  const contentLink = resource?.links.content;
  let resourceResult: FileRefUrlResult | null = null;
  if (contentLink) {
    if (!connection && !resourceContentUrl) {
      throw new Error(`resource URL requires server connection: ${resource.resourceId}`);
    }
    const url = connection
      ? buildConnectionUrl(connection, contentLink, { includeTokenQuery: true })
      : resourceContentUrl!(contentLink);
    resourceResult = {
      mode: 'resource-content',
      url: appendFileRefVersion(url, ref),
    };
  }

  const inlineResult: FileRefUrlResult | null = ref.inlineData
    ? {
        mode: 'inline-data',
        url: `data:${ref.inlineData.mimeType};base64,${ref.inlineData.base64}`,
      }
    : null;

  const ordered = preferLocalFile
    ? [previewResult, localResult, resourceResult, inlineResult]
    : [previewResult, resourceResult, inlineResult, localResult];
  const unique = ordered.filter((entry, index, entries): entry is FileRefUrlResult => (
    !!entry && entries.findIndex(candidate => candidate?.url === entry.url) === index
  ));
  if (unique.length > 0) return unique;

  if (ref.path && isLocalTransport) {
    if (typeof getFileUrl !== 'function') {
      throw new Error('platform.getFileUrl not available and resource content link missing');
    }
    return [{ mode: 'local-file', url: appendFileRefVersion(getFileUrl(ref.path), ref) }];
  }

  if (ref.path) {
    throw new Error(`remote file ref requires resource content link: ${ref.id}`);
  }

  throw new Error(`file ref lacks local path, resource content link, and inline data: ${ref.id}`);
}

const WINDOWS_ABSOLUTE_PATH_RE = /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/\/[^/]+\/[^/]+)/i;

export function isNativeFilePath(value: string | null | undefined): value is string {
  if (!value || value.includes('\0') || DIRECT_MEDIA_URL_RE.test(value)) return false;
  return WINDOWS_ABSOLUTE_PATH_RE.test(value) || value.startsWith('/');
}

export function resolveFileRefNativePath(
  ref: FileRef,
  connection?: ServerConnection | null,
): string | null {
  if (connection && !isLocalOwnerConnection(connection)) return null;
  return isNativeFilePath(ref.path) ? ref.path : null;
}

export function fileRefVersionToken(ref: Pick<FileRef, 'version'>): string | null {
  const version = ref.version;
  if (!version || typeof version.mtimeMs !== 'number' || typeof version.size !== 'number') return null;
  if (!Number.isFinite(version.mtimeMs) || !Number.isFinite(version.size)) return null;
  const parts = [String(version.mtimeMs), String(version.size)];
  if (version.sha256) parts.push(version.sha256);
  return parts.join('-');
}

function appendFileRefVersion(url: string, ref: FileRef): string {
  const token = fileRefVersionToken(ref);
  if (!token) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('v', token);
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}v=${encodeURIComponent(token)}`;
  }
}
