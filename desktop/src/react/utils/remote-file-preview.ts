import type {
  Artifact,
  DeskFile,
  FileVersion,
  RemoteWorkbenchContentRef,
  VersionedWriteResult,
} from '../types';
import type { FileRef } from '../types/file-ref';
import { codiaFetch, codiaUrl } from '../hooks/use-codia-fetch';
import { useStore } from '../stores';
import { openPreview, upsertArtifactForOwner } from '../stores/preview-actions';
import { resolveServerConnection } from '../services/server-connection';
import {
  encodeWorkbenchContentPath,
  resolveFileRefPreviewAccess,
  resolveWorkbenchFilePreviewAccess,
} from '../services/resource-access';
import { BINARY_PREVIEW_TYPES, PREVIEWABLE_EXTS, openFilePreview } from './file-preview';
import { extOfName, inferKindByExt, isMediaKind } from './file-kind';
import { openMediaViewerForRef } from './open-media-viewer';
import { openSvgDiagramPreviewForRef, openSvgDiagramPreviewFromUrl } from './svg-diagram-preview';
import { showError } from './ui-helpers';

export interface WorkbenchPreviewInput {
  file: DeskFile;
  mountId?: string | null;
  rootId?: string | null;
  subdir: string;
  localRootPath?: string | null;
  nativeRootPath?: string | null;
  preferNativePath?: boolean;
}

export interface FileRefPreviewContext {
  origin: 'desk' | 'session';
  sessionPath?: string;
  messageId?: string;
  blockIdx?: number;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isWebRuntime(): boolean {
  return typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-platform') === 'web';
}

export { encodeWorkbenchContentPath };

export function isRemoteWorkbenchContentRef(value: unknown): value is RemoteWorkbenchContentRef {
  if (!isRecord(value)) return false;
  return (value.kind === 'workbench-file' || value.kind === 'mobile-workbench')
    && (typeof value.mountId === 'string' || typeof value.rootId === 'string')
    && typeof value.subdir === 'string'
    && typeof value.name === 'string';
}

export function normalizeWorkbenchContentRef(ref: RemoteWorkbenchContentRef): RemoteWorkbenchContentRef {
  const mountId = ref.mountId || ref.rootId || 'default';
  return {
    ...ref,
    kind: 'workbench-file',
    mountId,
    rootId: ref.rootId || mountId,
    subdir: ref.subdir || '',
    name: ref.name,
  };
}

function previewId(prefix: string, key: string): string {
  return `${prefix}-${encodeURIComponent(key)}`;
}

function appendCacheBustQuery(path: string, attempt: number): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}v=${encodeURIComponent(`${Date.now()}-${attempt}`)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeFileVersion(value: unknown): FileVersion | null {
  if (!isRecord(value)) return null;
  const mtimeMs = Number(value.mtimeMs);
  const size = Number(value.size);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return null;
  return {
    mtimeMs,
    size,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : undefined,
  };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

interface PreviewContentSnapshot {
  content: string;
  fileVersion?: FileVersion;
}

function numberHeader(headers: Headers, ...names: string[]): number {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return NaN;
}

function fileVersionFromContentHeaders(headers: Headers): FileVersion | undefined {
  const mtimeMs = numberHeader(headers, 'X-CODIA-File-MtimeMs', 'X-Codia-File-MtimeMs');
  const size = numberHeader(headers, 'X-CODIA-File-Size', 'X-Codia-File-Size');
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(size)) return undefined;
  return { mtimeMs, size };
}

function newestKnownFileVersion(
  ...versions: Array<FileVersion | null | undefined>
): FileVersion | undefined {
  let newest: FileVersion | undefined;
  for (const version of versions) {
    if (!version || !Number.isFinite(version.mtimeMs) || !Number.isFinite(version.size)) continue;
    if (!newest || version.mtimeMs > newest.mtimeMs) {
      newest = version;
      continue;
    }
    if (version.mtimeMs === newest.mtimeMs && version.size > newest.size) newest = version;
  }
  return newest;
}

function remoteContentRefWithVersion(
  ref: RemoteWorkbenchContentRef | undefined,
  version: FileVersion | undefined,
): RemoteWorkbenchContentRef | undefined {
  if (!ref) return ref;
  return {
    ...ref,
    version,
  };
}

async function readContentForPreview(contentPath: string, previewType: string): Promise<PreviewContentSnapshot> {
  const res = await codiaFetch(contentPath);
  const fileVersion = fileVersionFromContentHeaders(res.headers);
  if (BINARY_PREVIEW_TYPES.has(previewType)) {
    return { content: await blobToBase64(await res.blob()), fileVersion };
  }
  return { content: await res.text(), fileVersion };
}

const REMOTE_REFRESH_RETRY_DELAYS_MS = [80, 240, 600] as const;

export interface RemoteWorkbenchRefreshOptions {
  retryMissing?: boolean;
  retryUnchanged?: boolean;
  retryDelaysMs?: readonly number[];
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function readRemotePreviewContentWithRetry(
  contentPath: string,
  item: Artifact,
  options: RemoteWorkbenchRefreshOptions,
): Promise<PreviewContentSnapshot> {
  const retryDelaysMs = options.retryDelaysMs ?? REMOTE_REFRESH_RETRY_DELAYS_MS;
  let lastRead: PreviewContentSnapshot = { content: '' };
  for (let attempt = 0; ; attempt += 1) {
    const nextRead = await readContentForPreview(appendCacheBustQuery(contentPath, attempt), item.type);
    const canRetry = attempt < retryDelaysMs.length;
    const shouldRetryUnchanged = options.retryUnchanged && nextRead.content === item.content;
    if (!canRetry || !shouldRetryUnchanged) return nextRead;
    lastRead = nextRead;
    await delay(retryDelaysMs[attempt] ?? 0);
  }
  return lastRead;
}

async function openRemoteContentPreview({
  contentPath,
  id,
  title,
  ext,
  mediaRef,
  mediaContext,
  remoteContentRef,
}: {
  contentPath: string;
  id: string;
  title: string;
  ext: string;
  mediaRef?: FileRef;
  mediaContext: { origin: 'desk' | 'session'; sessionPath?: string };
  remoteContentRef?: RemoteWorkbenchContentRef;
}): Promise<void> {
  const mediaKind = inferKindByExt(ext);
  if (mediaKind === 'svg') {
    openSvgDiagramPreviewFromUrl({
      id,
      title,
      url: codiaUrl(contentPath, { includeTokenQuery: true }),
      ext,
      storageKind: 'remote-content',
    });
    return;
  }
  if (isMediaKind(mediaKind) && mediaRef) {
    openMediaViewerForRef(mediaRef, mediaContext);
    return;
  }

  const previewType = PREVIEWABLE_EXTS[ext];
  if (previewType && previewType !== 'docx' && previewType !== 'xlsx') {
    const read = await readContentForPreview(contentPath, previewType);
    const fileVersion = read.fileVersion ?? remoteContentRef?.version ?? undefined;
    const artifact = {
      id,
      type: previewType,
      title,
      content: read.content,
      ext,
      language: previewType === 'code' ? ext : undefined,
      storageKind: 'remote-content',
      fileVersion,
      remoteContentRef: remoteContentRefWithVersion(remoteContentRef, fileVersion),
    };
    openPreview(artifact as Artifact);
    return;
  }

  openPreview({
    id,
    type: 'file-info',
    title,
    content: '',
    ext,
    storageKind: 'remote-content',
    remoteContentRef,
  } as Artifact);
}

export async function saveRemoteWorkbenchContent(
  ref: RemoteWorkbenchContentRef,
  content: string,
  expectedVersion?: FileVersion | null,
): Promise<VersionedWriteResult> {
  const normalized = normalizeWorkbenchContentRef(ref);
  const res = await codiaFetch('/api/workbench/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'writeText',
      mountId: normalized.mountId || 'default',
      subdir: normalized.subdir || '',
      name: normalized.name,
      content,
      expectedVersion: expectedVersion ?? null,
    }),
  });
  const data: unknown = await res.json();
  if (!isRecord(data)) throw new Error('invalid remote write response');
  return {
    ok: data.ok === true,
    conflict: data.conflict === true,
    version: normalizeFileVersion(data.version),
  };
}

function refsPointToSameWorkbenchFile(
  left: RemoteWorkbenchContentRef | null | undefined,
  right: RemoteWorkbenchContentRef,
): boolean {
  if (!isRemoteWorkbenchContentRef(left)) return false;
  const normalizedLeft = normalizeWorkbenchContentRef(left);
  const normalizedRight = normalizeWorkbenchContentRef(right);
  return (normalizedLeft.mountId || 'default') === (normalizedRight.mountId || 'default')
    && (normalizedLeft.subdir || '') === (normalizedRight.subdir || '')
    && normalizedLeft.name === normalizedRight.name;
}

export async function refreshPreviewItemsFromRemoteWorkbenchTarget(
  target: RemoteWorkbenchContentRef,
  options: RemoteWorkbenchRefreshOptions = {},
): Promise<void> {
  const normalized = normalizeWorkbenchContentRef(target);
  const state = useStore.getState();
  const owners = Object.entries(state.previewByOwner || {});
  for (const [owner, preview] of owners) {
    for (const item of preview.artifacts || []) {
      if (!refsPointToSameWorkbenchFile(item.remoteContentRef, normalized)) continue;
      const contentPath = item.remoteContentRef?.contentPath || encodeWorkbenchContentPath(normalized);
      const read = await readRemotePreviewContentWithRetry(contentPath, item, options);
      const nextVersion = newestKnownFileVersion(
        read.fileVersion,
        item.fileVersion,
        normalized.version ?? undefined,
        item.remoteContentRef?.version ?? undefined,
      );
      const remoteContentRef = item.remoteContentRef
        ? {
            ...item.remoteContentRef,
            version: nextVersion,
          }
        : item.remoteContentRef;
      upsertArtifactForOwner(owner, {
        ...item,
        content: read.content,
        fileVersion: nextVersion,
        remoteContentRef,
        status: 'available',
        missingAt: null,
      } as Artifact);
    }
  }
}

export async function openWorkbenchFilePreview(input: WorkbenchPreviewInput): Promise<void> {
  if (input.file.isDir) return;
  const name = input.file.name;
  const connection = resolveServerConnection(useStore.getState());
  const access = resolveWorkbenchFilePreviewAccess(input, { connection }, {
    preferNativePath: input.preferNativePath,
  });
  if (access.mode === 'unsupported') return;
  if (access.mode === 'native-path') {
    await openFilePreview(access.path, name, access.ext, {
      origin: 'desk',
      sourceRootPath: access.sourceRootPath,
    });
    return;
  }
  const studioId = connection?.studioId || 'default';
  const mediaKind = inferKindByExt(access.ext);
  const mediaRef: FileRef | undefined = isMediaKind(mediaKind)
    ? {
        id: `workbench:${access.mountId}:${access.subdir}:${name}`,
        kind: mediaKind,
        source: 'desk',
        name,
        path: '',
        ext: access.ext,
        version: access.version,
        resource: {
          resourceId: `workbench:${access.mountId}:${access.subdir}:${name}`,
          studioId,
          links: { self: access.contentPath, content: access.contentPath },
        },
      }
    : undefined;

  try {
    await openRemoteContentPreview({
      contentPath: access.versionedContentPath,
      id: previewId('workbench', `${access.mountId}:${access.subdir}:${name}`),
      title: name,
      ext: access.ext,
      mediaRef,
      mediaContext: { origin: 'desk' },
      remoteContentRef: access.remoteContentRef,
    });
  } catch (err) {
    console.error('[remote-preview] workbench preview failed:', err);
    showError(getErrorMessage(err));
  }
}

export async function openMobileWorkbenchPreview(input: WorkbenchPreviewInput): Promise<void> {
  await openWorkbenchFilePreview(input);
}

export async function openFileRefPreview(file: FileRef, context: FileRefPreviewContext): Promise<void> {
  if (file.status === 'expired') return;
  if (file.kind === 'svg') {
    const contentLink = file.resource?.links.content;
    if (contentLink) {
      openSvgDiagramPreviewFromUrl({
        id: previewId('resource', file.resource?.resourceId || file.id),
        title: file.name,
        url: codiaUrl(contentLink, { includeTokenQuery: true }),
        ext: file.ext || extOfName(file.name) || 'svg',
        storageKind: 'remote-content',
      });
    } else {
      openSvgDiagramPreviewForRef(file);
    }
    return;
  }
  if (isMediaKind(file.kind)) {
    openMediaViewerForRef(file, {
      origin: context.origin,
      sessionPath: context.sessionPath,
    });
    return;
  }

  const connection = resolveServerConnection(useStore.getState());
  const access = resolveFileRefPreviewAccess(file, { connection });
  if (access.mode === 'native-path') {
    await openFilePreview(access.path, file.name, file.ext || extOfName(file.name) || '', {
      origin: context.origin,
      sessionPath: context.sessionPath,
      messageId: context.messageId,
      blockIdx: context.blockIdx,
    });
    return;
  }
  if (access.mode !== 'resource-content') return;

  try {
    await openRemoteContentPreview({
      contentPath: access.contentPath,
      id: previewId('resource', access.resourceId),
      title: file.name,
      ext: file.ext || extOfName(file.name) || '',
      mediaContext: {
        origin: context.origin,
        sessionPath: context.sessionPath,
      },
    });
  } catch (err) {
    console.error('[remote-preview] session file preview failed:', err);
    showError(getErrorMessage(err));
  }
}

export function fileRefDownloadUrl(file: FileRef): string | null {
  if (file.status === 'expired') return null;
  const contentPath = file.resource?.links.content;
  if (contentPath) {
    try {
      return codiaUrl(contentPath, { includeTokenQuery: true });
    } catch {
      return contentPath;
    }
  }
  if (file.inlineData) {
    return `data:${file.inlineData.mimeType};base64,${file.inlineData.base64}`;
  }
  return null;
}
