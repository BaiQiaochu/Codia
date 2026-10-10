import { codiaFetch } from '../hooks/use-codia-fetch';
import type { Artifact, RightWorkspaceTab } from '../types';
import { readFileForPreviewType } from '../utils/preview-file-reader';
import { useStore } from './index';
import { normalizeWorkspacePath } from '../../../../shared/workspace-history.ts';
import {
  normalizePreviewReadingPosition,
  type PreviewReadingPosition,
} from '../../../../shared/preview-reading-position.ts';

interface PersistedPreviewTab {
  id: string;
  filePath?: string;
  relativePath?: string;
  title?: string;
  type?: string;
  ext?: string;
  language?: string | null;
  sourceRootPath?: string;
  readingPosition?: PreviewReadingPosition;
}

export interface PersistedWorkspaceUiState {
  updatedAt?: number;
  deskCurrentPath?: string;
  deskExpandedPaths?: string[];
  deskSelectedPath?: string;
  rightWorkspaceTab?: RightWorkspaceTab;
  jianView?: string;
  jianDrawerOpen?: boolean;
  previewOpen?: boolean;
  previewTabs?: PersistedPreviewTab[];
  openTabs?: string[];
  activeTabId?: string | null;
}

export type WorkspaceUiSurface = 'electron' | 'pwa';

const SAVE_DEBOUNCE_MS = 350;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function normalizeRoot(root: string | null | undefined): string | null {
  return normalizeWorkspacePath(root);
}

function normalizeSubdir(value: string | null | undefined): string {
  return (value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function joinWorkspacePath(root: string, relativePath: string): string {
  const base = root.replace(/[\\/]+$/g, '');
  const rel = normalizeSubdir(relativePath);
  return rel ? `${base}/${rel}` : base;
}

function relativePathFor(root: string, filePath: string | undefined): string {
  if (!filePath) return '';
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/g, '');
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (normalizedPath === normalizedRoot) return '';
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : '';
}

function previewTabFromArtifact(
  root: string,
  artifact: Artifact,
  readingPosition?: PreviewReadingPosition | null,
): PersistedPreviewTab | null {
  if (!artifact.filePath) return null;
  const relativePath = relativePathFor(root, artifact.filePath);
  const normalizedReadingPosition = normalizePreviewReadingPosition(readingPosition);
  return {
    id: artifact.id,
    filePath: artifact.filePath,
    ...(relativePath ? { relativePath } : {}),
    title: artifact.title,
    type: artifact.type,
    ext: artifact.ext,
    language: artifact.language ?? null,
    ...(artifact.sourceRootPath ? { sourceRootPath: artifact.sourceRootPath } : {}),
    ...(normalizedReadingPosition ? { readingPosition: normalizedReadingPosition } : {}),
  };
}

function hasServerConnection(state: ReturnType<typeof useStore.getState>): boolean {
  if (state.serverPort) return true;
  return typeof window !== 'undefined'
    && typeof (window as typeof window & { __CODIA_PWA__?: { serverUrl?: unknown } }).__CODIA_PWA__?.serverUrl === 'function';
}

export function resolveWorkspaceUiSurface(): WorkspaceUiSurface {
  if (typeof document !== 'undefined' && document.documentElement.getAttribute('data-platform') === 'web') {
    return 'pwa';
  }
  if (typeof window !== 'undefined' && window.location?.pathname?.startsWith('/mobile')) {
    return 'pwa';
  }
  return 'electron';
}

function workspaceUiStateUrl(root: string): string {
  const params = new URLSearchParams();
  params.set('workspace', root);
  params.set('surface', resolveWorkspaceUiSurface());
  return `/api/preferences/workspace-ui-state?${params.toString()}`;
}

export function buildPersistedWorkspaceUiState(root: string): PersistedWorkspaceUiState {
  const state = useStore.getState();
  const preview = state.previewByOwner?.desk || {
    artifacts: [],
    openTabs: [],
    activeTabId: null,
    previewReadingPositions: {},
  };
  const previewItemsById = new Map((preview.artifacts || []).map((item: Artifact) => [item.id, item]));
  const previewTabs = (preview.openTabs || [])
    .map(id => previewItemsById.get(id))
    .filter((item): item is Artifact => !!item)
    .map(item => previewTabFromArtifact(root, item, preview.previewReadingPositions?.[item.id]))
    .filter((item): item is PersistedPreviewTab => !!item);
  const persistedIds = new Set(previewTabs.map(tab => tab.id));
  const openTabs = (preview.openTabs || []).filter(id => persistedIds.has(id));
  const activeTabId = preview.activeTabId && openTabs.includes(preview.activeTabId)
    ? preview.activeTabId
    : (openTabs[0] || null);
  return {
    deskCurrentPath: normalizeSubdir(state.deskCurrentPath),
    deskExpandedPaths: [...(state.deskExpandedPaths || [])].map(normalizeSubdir).filter(Boolean),
    deskSelectedPath: normalizeSubdir(state.deskSelectedPath),
    rightWorkspaceTab: state.rightWorkspaceTab,
    jianView: state.jianView,
    jianDrawerOpen: !!state.jianDrawerOpen,
    previewOpen: !!state.previewOpen,
    openTabs,
    activeTabId,
    previewTabs,
  };
}

export async function loadPersistedWorkspaceUiState(root: string): Promise<PersistedWorkspaceUiState | null> {
  const normalized = normalizeRoot(root);
  const state = useStore.getState();
  if (!normalized || !hasServerConnection(state)) return null;
  try {
    const res = await codiaFetch(workspaceUiStateUrl(normalized));
    const data = await res.json().catch(() => null);
    return data?.state && typeof data.state === 'object' ? data.state as PersistedWorkspaceUiState : null;
  } catch (err) {
    console.warn('[workspace-ui-state] load failed:', err);
    return null;
  }
}

export async function hydratePersistedPreviewArtifacts(
  root: string,
  persisted: PersistedWorkspaceUiState | null,
): Promise<Artifact[]> {
  const normalizedRoot = normalizeRoot(root);
  if (!normalizedRoot || !persisted?.previewTabs?.length) return [];
  const artifacts: Artifact[] = [];
  for (const tab of persisted.previewTabs) {
    const filePath = tab.relativePath
      ? joinWorkspacePath(normalizedRoot, tab.relativePath)
      : (tab.filePath || '');
    if (!filePath || !tab.id) continue;
    try {
      const type = tab.type || 'file-info';
      const read = await readFileForPreviewType(filePath, type);
      if (!read) continue;
      artifacts.push({
        id: tab.id,
        type,
        title: tab.title || filePath.split('/').pop() || filePath,
        content: read.content,
        filePath,
        ...(tab.sourceRootPath ? { sourceRootPath: tab.sourceRootPath } : {}),
        ext: tab.ext,
        language: tab.language ?? undefined,
        fileVersion: read.fileVersion,
      });
    } catch (err) {
      console.warn('[workspace-ui-state] preview tab restore failed:', err);
    }
  }
  return artifacts;
}

export function readingPositionsFromPersistedWorkspaceUiState(
  persisted: PersistedWorkspaceUiState | null,
  allowedIds?: Iterable<string>,
): Record<string, PreviewReadingPosition> {
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const out: Record<string, PreviewReadingPosition> = {};
  for (const tab of persisted?.previewTabs || []) {
    if (!tab.id || (allowed && !allowed.has(tab.id))) continue;
    const normalized = normalizePreviewReadingPosition(tab.readingPosition);
    if (normalized) out[tab.id] = normalized;
  }
  return out;
}

export function schedulePersistCurrentWorkspaceUiState(root?: string | null): void {
  const normalized = normalizeRoot(root ?? useStore.getState().deskBasePath);
  if (!normalized || !hasServerConnection(useStore.getState())) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistCurrentWorkspaceUiStateNow(normalized);
  }, SAVE_DEBOUNCE_MS);
}

export async function persistCurrentWorkspaceUiStateNow(root?: string | null): Promise<void> {
  const normalized = normalizeRoot(root ?? useStore.getState().deskBasePath);
  if (!normalized || !hasServerConnection(useStore.getState())) return;
  const state = buildPersistedWorkspaceUiState(normalized);
  const surface = resolveWorkspaceUiSurface();
  try {
    await codiaFetch('/api/preferences/workspace-ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: normalized, surface, state }),
    });
  } catch (err) {
    console.warn('[workspace-ui-state] save failed:', err);
  }
}
