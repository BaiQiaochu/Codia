/**
 * desk-actions.ts - desk file operations
 *
 * Pure functions used by React components.
 */

import { useStore } from './index';
import { codiaFetch } from '../hooks/use-codia-fetch';
import { clearChat } from './agent-actions';
import type { DeskFile, DeskSearchResult, StudioWorkspace } from '../types';
import { DESK_OWNER, type WorkspaceDeskState } from './desk-slice';
import { getApiErrorMessage } from '../utils/api-error';
import { isWebRuntime } from '../utils/platform-runtime';
import { isLocalOwnerConnection, resolveServerConnection } from '../services/server-connection';
import {
  hydratePersistedPreviewArtifacts,
  loadPersistedWorkspaceUiState,
  readingPositionsFromPersistedWorkspaceUiState,
  schedulePersistCurrentWorkspaceUiState,
} from './workspace-ui-state-actions';
import { mergeWorkspaceHistory, normalizeWorkspacePath, removeWorkspaceHistoryEntries } from '../../../../shared/workspace-history.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

const t = (key: string, vars?: Record<string, string | number>) => window.t?.(key, vars) ?? key;

let _deskLoadVersion = 0;
const _deskTreeLoadVersion = new Map<string, number>();

function normalizeFolder(value: string | null | undefined): string | null {
  return normalizeWorkspacePath(value);
}

function normalizeMountId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function studioWorkspaceKey(mountId: string): string {
  return `studio:${mountId}`;
}

function deskStateRootKey(root: string | null | undefined, mountId: string | null | undefined): string | null {
  const normalizedMountId = normalizeMountId(mountId);
  if (normalizedMountId) return studioWorkspaceKey(normalizedMountId);
  return normalizeFolder(root);
}

function activeDeskMountId(s: ReturnType<typeof useStore.getState>, overrideMountId?: string | null): string | null {
  if (overrideMountId !== undefined) return normalizeMountId(overrideMountId);
  return normalizeMountId(s.deskWorkspaceMountId);
}

function canUseNativeDeskPath(s: ReturnType<typeof useStore.getState>): boolean {
  const connection = resolveServerConnection(s);
  return !connection || isLocalOwnerConnection(connection);
}

function shouldUseWorkbenchDeskAction(s: ReturnType<typeof useStore.getState>): boolean {
  return isWebRuntime() || !!activeDeskMountId(s) || !canUseNativeDeskPath(s);
}

function activeDeskRoot(s: ReturnType<typeof useStore.getState>, overrideDir?: string | null): string | undefined {
  return overrideDir !== undefined
    ? (overrideDir || undefined)
    : defaultDeskRoot(s);
}

function defaultDeskRoot(s: ReturnType<typeof useStore.getState>): string | undefined {
  return normalizeFolder(s.deskBasePath)
    || normalizeFolder(s.selectedFolder)
    || normalizeFolder(s.homeFolder)
    || undefined;
}

function selectedDeskAgentId(s: ReturnType<typeof useStore.getState>): string | null {
  return typeof s.selectedAgentId === 'string' && s.selectedAgentId.trim()
    ? s.selectedAgentId.trim()
    : null;
}

function addSelectedDeskAgentParam(params: URLSearchParams, s: ReturnType<typeof useStore.getState>): void {
  const agentId = selectedDeskAgentId(s);
  if (agentId) params.set('agentId', agentId);
}

function selectedDeskAgentBody(s: ReturnType<typeof useStore.getState>): { agentId?: string } {
  const agentId = selectedDeskAgentId(s);
  return agentId ? { agentId } : {};
}

function normalizeStudioWorkspace(value: any): StudioWorkspace | null {
  const mountId = normalizeMountId(value?.mountId);
  const workspaceId = typeof value?.workspaceId === 'string' && value.workspaceId.trim()
    ? value.workspaceId.trim()
    : mountId;
  if (!mountId || !workspaceId) return null;
  return {
    workspaceId,
    mountId,
    label: typeof value?.label === 'string' && value.label.trim() ? value.label.trim() : mountId,
    sourceKind: typeof value?.sourceKind === 'string' ? value.sourceKind : null,
    provider: typeof value?.provider === 'string' ? value.provider : null,
    presentation: typeof value?.presentation === 'string' ? value.presentation : null,
    capabilities: Array.isArray(value?.capabilities)
      ? value.capabilities.filter((cap: unknown): cap is string => typeof cap === 'string')
      : [],
    isDefault: value?.isDefault === true,
    nativeRootPath: normalizeFolder(value?.nativeRootPath),
  };
}

function normalizeMountNativeRoot(value: unknown): string | null {
  return normalizeFolder(typeof value === 'string' ? value : null);
}

export async function loadStudioWorkspaces(): Promise<StudioWorkspace[]> {
  const s = useStore.getState();
  if (!s.serverPort) return [];
  try {
    const res = await codiaFetch('/api/studio/workspaces');
    const data = await res.json();
    if (data.error) throw new Error(getApiErrorMessage(data));
    const workspaces = (Array.isArray(data.workspaces) ? data.workspaces : [])
      .map(normalizeStudioWorkspace)
      .filter((workspace: StudioWorkspace | null): workspace is StudioWorkspace => !!workspace);
    useStore.getState().setStudioWorkspaces(workspaces);
    return workspaces;
  } catch (err) {
    console.error('[workspace] load studio workspaces failed:', err);
    return [];
  }
}

export async function createLocalStudioWorkspaceFromFolder(folder: string): Promise<StudioWorkspace | null> {
  const normalized = normalizeFolder(folder);
  const s = useStore.getState();
  if (!normalized || !s.serverPort) return null;
  try {
    const res = await codiaFetch('/api/studio/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalized }),
    });
    const data = await res.json();
    if (data.error) throw new Error(getApiErrorMessage(data));
    const workspace = normalizeStudioWorkspace(data.workspace);
    if (!workspace) throw new Error('invalid workspace response');
    useStore.setState((state: any) => ({
      studioWorkspaces: [
        workspace,
        ...(state.studioWorkspaces || []).filter((item: StudioWorkspace) => item.mountId !== workspace.mountId),
      ],
    }));
    return workspace;
  } catch (err) {
    console.error('[workspace] create local studio workspace failed:', err);
    return null;
  }
}

export async function applyStudioWorkspace(workspace: Pick<StudioWorkspace, 'mountId' | 'label'> & Partial<Pick<StudioWorkspace, 'nativeRootPath'>>): Promise<void> {
  const mountId = normalizeMountId(workspace.mountId);
  if (!mountId) return;
  const label = typeof workspace.label === 'string' && workspace.label.trim() ? workspace.label.trim() : mountId;
  const nativeRootPath = normalizeMountNativeRoot(workspace.nativeRootPath);
  useStore.setState((s: any) => ({
    selectedWorkspaceMountId: mountId,
    selectedWorkspaceLabel: label,
    selectedFolder: null,
    workspaceFolders: s.workspaceFolders || [],
  }));
  void activateWorkspaceDesk(null, { mountId, label, nativeRootPath, reload: false });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true });
    clearChat();
    useStore.getState().requestInputFocus();
  }
  await loadDeskFiles('', null, mountId);
}

export async function removeStudioWorkspace(mountId: string): Promise<boolean> {
  const normalized = normalizeMountId(mountId);
  const s = useStore.getState();
  if (!normalized || !s.serverPort) return false;
  useStore.setState((state: any) => ({
    studioWorkspaces: (state.studioWorkspaces || [])
      .filter((workspace: StudioWorkspace) => workspace.mountId !== normalized),
  }));
  try {
    const res = await codiaFetch(`/api/studio/workspaces/${encodeURIComponent(normalized)}`, {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.error) throw new Error(getApiErrorMessage(data));
    const nextWorkspaces = await loadStudioWorkspaces();
    const latest = useStore.getState();
    if (latest.selectedWorkspaceMountId === normalized || latest.deskWorkspaceMountId === normalized) {
      useStore.setState({
        selectedWorkspaceMountId: null,
        selectedWorkspaceLabel: null,
      });
      const defaultWorkspace = nextWorkspaces.find((workspace) => workspace.isDefault);
      if (defaultWorkspace?.nativeRootPath) {
        await activateWorkspaceDesk(defaultWorkspace.nativeRootPath, { mountId: null, reload: true });
      } else {
        await activateWorkspaceDesk(null, { mountId: null, reload: false });
      }
    }
    return true;
  } catch (err) {
    console.error('[workspace] remove studio workspace failed:', err);
    await loadStudioWorkspaces();
    return false;
  }
}

function buildWorkspaceDeskState(s: ReturnType<typeof useStore.getState>): WorkspaceDeskState {
  const preview = s.previewByOwner?.[DESK_OWNER] || {
    openTabs: [],
    activeTabId: null,
    markdownPreviewIds: [],
    previewReadingPositions: {},
  };
  return {
    deskCurrentPath: s.deskCurrentPath || '',
    deskFiles: [...(s.deskFiles || [])],
    deskTreeFilesByPath: { ...(s.deskTreeFilesByPath || {}) },
    deskExpandedPaths: [...(s.deskExpandedPaths || [])],
    deskDirtyTreePaths: [...(s.deskDirtyTreePaths || [])],
    deskSelectedPath: s.deskSelectedPath || '',
    deskJianContent: s.deskJianContent ?? null,
    cwdSkills: [...(s.cwdSkills || [])],
    cwdSkillsOpen: !!s.cwdSkillsOpen,
    previewOpen: !!s.previewOpen,
    jianDrawerOpen: !!s.jianDrawerOpen,
    rightWorkspaceTab: s.rightWorkspaceTab || 'workspace',
    jianView: s.jianView || 'desk',
    openTabs: [...(preview.openTabs || [])],
    activeTabId: preview.activeTabId ?? null,
    markdownPreviewIds: [...(preview.markdownPreviewIds || [])],
    previewReadingPositions: { ...(preview.previewReadingPositions || {}) },
  };
}

export function captureCurrentWorkspaceDeskState(root?: string | null): void {
  const s = useStore.getState();
  const key = deskStateRootKey(root ?? s.deskBasePath, s.deskWorkspaceMountId);
  if (!key) return;
  s.setWorkspaceDeskState(key, buildWorkspaceDeskState(s));
  schedulePersistCurrentWorkspaceUiState(key);
}

export async function activateWorkspaceDesk(root: string | null | undefined, options: {
  reload?: boolean;
  mountId?: string | null;
  label?: string | null;
  nativeRootPath?: string | null;
} = {}): Promise<void> {
  _deskLoadVersion += 1;

  const mountId = normalizeMountId(options.mountId);
  const normalized = mountId ? null : normalizeFolder(root);
  const workspaceKey = deskStateRootKey(normalized, mountId);
  const s = useStore.getState();
  const currentRoot = deskStateRootKey(s.deskBasePath, s.deskWorkspaceMountId);

  if (currentRoot) {
    captureCurrentWorkspaceDeskState(currentRoot);
  }

  if (!workspaceKey) {
    useStore.setState({
      deskBasePath: '',
      deskWorkspaceMountId: null,
      deskWorkspaceLabel: null,
      deskWorkspaceNativeRoot: null,
      deskCurrentPath: '',
      deskFiles: [],
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskDirtyTreePaths: [],
      deskSelectedPath: '',
      deskJianContent: null,
      cwdSkills: [],
      cwdSkillsOpen: false,
      previewOpen: false,
      jianDrawerOpen: false,
      rightWorkspaceTab: 'workspace',
      jianView: 'desk',
      previewByOwner: {
        ...(s.previewByOwner || {}),
        [DESK_OWNER]: {
          ...(s.previewByOwner?.[DESK_OWNER] || { artifacts: [] }),
          openTabs: [],
          activeTabId: null,
          markdownPreviewIds: [],
          previewReadingPositions: {},
        },
      },
    });
    updateDeskContextBtn();
    return;
  }

  const latest = useStore.getState();
  const saved = latest.workspaceDeskStateByRoot?.[workspaceKey] || null;
  const sameRoot = currentRoot === workspaceKey;
  const nextSubdir = sameRoot
    ? (latest.deskCurrentPath || '')
    : (saved?.deskCurrentPath || '');

  useStore.setState({
    deskBasePath: normalized || workspaceKey,
    deskWorkspaceMountId: mountId,
    deskWorkspaceLabel: mountId ? (options.label || null) : null,
    deskWorkspaceNativeRoot: mountId ? normalizeMountNativeRoot(options.nativeRootPath) : null,
    deskCurrentPath: nextSubdir,
    deskFiles: [],
    deskTreeFilesByPath: saved?.deskTreeFilesByPath || {},
    deskExpandedPaths: saved?.deskExpandedPaths || [],
    deskDirtyTreePaths: [],
    deskSelectedPath: saved?.deskSelectedPath || '',
    deskJianContent: null,
    cwdSkills: saved?.cwdSkills || [],
    cwdSkillsOpen: saved?.cwdSkillsOpen || false,
    previewOpen: saved?.previewOpen || false,
    jianDrawerOpen: saved?.jianDrawerOpen ?? false,
    rightWorkspaceTab: saved?.rightWorkspaceTab || 'workspace',
    jianView: saved?.jianView || 'desk',
    previewByOwner: {
      ...(latest.previewByOwner || {}),
      [DESK_OWNER]: {
        ...(latest.previewByOwner?.[DESK_OWNER] || { artifacts: [] }),
        openTabs: saved?.openTabs || [],
        activeTabId: saved?.activeTabId ?? null,
        markdownPreviewIds: saved?.markdownPreviewIds || [],
        previewReadingPositions: saved?.previewReadingPositions || {},
      },
    },
  });
  updateDeskContextBtn();

  let effectiveSubdir = nextSubdir;
  if (!saved) {
    const persisted = await loadPersistedWorkspaceUiState(workspaceKey);
    const restoredPreviewArtifacts = mountId ? [] : await hydratePersistedPreviewArtifacts(workspaceKey, persisted);
    const restoredPreviewArtifactsById = new Map(restoredPreviewArtifacts.map(item => [item.id, item]));
    const restoredOpenTabs = (persisted?.openTabs || []).filter(id => restoredPreviewArtifactsById.has(id));
    const restoredReadingPositions = readingPositionsFromPersistedWorkspaceUiState(
      persisted,
      restoredPreviewArtifacts.map(item => item.id),
    );
    const restoredActiveTabId = persisted?.activeTabId && restoredOpenTabs.includes(persisted.activeTabId)
      ? persisted.activeTabId
      : (restoredOpenTabs[0] || null);
    if (persisted && deskStateRootKey(useStore.getState().deskBasePath, useStore.getState().deskWorkspaceMountId) === workspaceKey) {
      effectiveSubdir = sameRoot ? effectiveSubdir : (persisted.deskCurrentPath || '');
      useStore.setState((state: any) => ({
        deskCurrentPath: effectiveSubdir,
        deskExpandedPaths: persisted.deskExpandedPaths || [],
        deskSelectedPath: persisted.deskSelectedPath || '',
        rightWorkspaceTab: persisted.rightWorkspaceTab || 'workspace',
        jianView: persisted.jianView || 'desk',
        jianDrawerOpen: persisted.jianDrawerOpen ?? false,
        previewOpen: persisted.previewOpen ?? false,
        previewByOwner: {
          ...(state.previewByOwner || {}),
          [DESK_OWNER]: {
            ...(state.previewByOwner?.[DESK_OWNER] || { artifacts: [] }),
            artifacts: restoredPreviewArtifacts,
            openTabs: restoredOpenTabs,
            activeTabId: restoredActiveTabId,
            previewReadingPositions: restoredReadingPositions,
          },
        },
      }));
    }
  }

  if (options.reload === false) return;
  await loadDeskFiles(effectiveSubdir, normalized, mountId);
  const expandedPaths = useStore.getState().deskExpandedPaths || [];
  for (const subdir of expandedPaths) {
    await loadDeskTreeFiles(subdir, { force: true, overrideDir: normalized, overrideMountId: mountId });
  }
}

interface DeskSnapshot {
  sessionPath: string | null;
  basePath: string;
  currentPath: string;
}

function captureDeskSnapshot(): DeskSnapshot {
  const s = useStore.getState();
  return {
    sessionPath: s.currentSessionPath || null,
    basePath: s.deskBasePath || '',
    currentPath: s.deskCurrentPath || '',
  };
}

function isSameDeskSnapshot(snapshot: DeskSnapshot): boolean {
  const s = useStore.getState();
  return (s.currentSessionPath || null) === snapshot.sessionPath
    && (s.deskBasePath || '') === snapshot.basePath
    && (s.deskCurrentPath || '') === snapshot.currentPath;
}

function setDeskFilesForCurrentPath(files: ReturnType<typeof useStore.getState>['deskFiles']): void {
  const st = useStore.getState();
  st.setDeskFiles(files);
  st.setDeskTreeFiles?.(st.deskCurrentPath || '', files);
}

function applyFilesForSubdir(subdir: string, files: DeskFile[]): void {
  const normalizedSubdir = normalizeSubdir(subdir);
  const st = useStore.getState();
  st.setDeskTreeFiles?.(normalizedSubdir, files);
  if ((st.deskCurrentPath || '') === normalizedSubdir) st.setDeskFiles(files);
}

function deskTreeLoadKey(root: string | undefined, subdir: string): string {
  return `${root || ''}\n${subdir}`;
}

function normalizeSubdir(value: string | null | undefined): string {
  return (value || '').replace(/^\/+|\/+$/g, '');
}

function childSubdir(parent: string, name: string): string {
  const normalized = normalizeSubdir(parent);
  return normalized ? `${normalized}/${name}` : name;
}

function ancestorSubdirs(pathValue: string): string[] {
  const normalized = normalizeSubdir(pathValue);
  if (!normalized) return [];
  const parts = normalized.split('/').filter(Boolean);
  const result: string[] = [];
  for (let i = 1; i <= parts.length; i += 1) {
    result.push(parts.slice(0, i).join('/'));
  }
  return result;
}

function replaceSubdirPrefix(value: string, oldPrefix: string, newPrefix: string): string {
  if (value === oldPrefix) return newPrefix;
  if (value.startsWith(`${oldPrefix}/`)) return `${newPrefix}${value.slice(oldPrefix.length)}`;
  return value;
}

function removeSubdirPrefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`);
}

function isPlainFileName(value: string): boolean {
  return !!value && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
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

function nextAvailableDeskFileName(baseName: string): string {
  const existing = new Set((useStore.getState().deskFiles || []).map((f: { name: string }) => f.name));
  if (!existing.has(baseName)) return baseName;

  const dot = baseName.lastIndexOf('.');
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : '';
  let i = 2;
  while (existing.has(`${stem} ${i}${ext}`)) i += 1;
  return `${stem} ${i}${ext}`;
}

function mindmapNameFromDocumentName(sourceName: string): string {
  const base = String(sourceName || '').split(/[\\/]/).pop() || 'Mind Map';
  return `${base.replace(/\.[^.]+$/i, '') || 'Mind Map'}.xmind`;
}

function joinDeskPath(basePath: string, subdir: string, name: string): string {
  const separator = basePath.includes('\\') && !basePath.includes('/') ? '\\' : '/';
  const base = basePath.replace(/[\\/]+$/g, '');
  const parts = normalizeSubdir(subdir).split('/').filter(Boolean);
  return [base, ...parts, name].join(separator);
}

export function deskNativeRootDir(s: Pick<ReturnType<typeof useStore.getState>, 'deskBasePath' | 'deskWorkspaceMountId' | 'deskWorkspaceNativeRoot'>): string | null {
  if (s.deskWorkspaceMountId) return s.deskWorkspaceNativeRoot || null;
  return s.deskBasePath || null;
}

export function deskFullPath(name: string): string | null {
  const s = useStore.getState();
  const root = deskNativeRootDir(s);
  if (!root) return null;
  return s.deskCurrentPath
    ? `${root}/${s.deskCurrentPath}/${name}`
    : `${root}/${name}`;
}

export function deskCurrentDir(): string | null {
  const s = useStore.getState();
  const root = deskNativeRootDir(s);
  if (!root) return null;
  return s.deskCurrentPath
    ? `${root}/${s.deskCurrentPath}`
    : root;
}

export async function loadDeskFiles(subdir?: string, overrideDir?: string | null, overrideMountId?: string | null): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  if (subdir !== undefined) s.setDeskCurrentPath(subdir);

  const myVersion = ++_deskLoadVersion;

  try {
    const params = new URLSearchParams();
    const mountId = activeDeskMountId(s, overrideMountId);
    const dir = mountId ? undefined : activeDeskRoot(s, overrideDir);
    if (mountId) {
      params.set('mountId', mountId);
    } else if (dir) {
      params.set('dir', dir);
    }
    if (!mountId) addSelectedDeskAgentParam(params, s);
    const curPath = subdir !== undefined ? subdir : s.deskCurrentPath;
    if (curPath) params.set('subdir', curPath);
    const qs = params.toString() ? `?${params}` : '';
    const res = await codiaFetch(`${mountId ? '/api/workbench/files' : '/api/desk/files'}${qs}`);
    const data = await res.json();

    if (myVersion !== _deskLoadVersion) return;
    if (data.error) throw new Error(getApiErrorMessage(data));

    const st = useStore.getState();
    st.setDeskFiles(data.files || []);
    st.setDeskTreeFiles?.(curPath || '', data.files || []);
    st.setDeskSelectedPath?.(curPath || '');
    if (mountId) {
      st.setDeskWorkspaceMount?.(
        data.mountId || mountId,
        data.mount?.label || st.deskWorkspaceLabel || null,
        normalizeMountNativeRoot(data.mount?.nativeRootPath) || st.deskWorkspaceNativeRoot || null,
      );
      st.setDeskBasePath(studioWorkspaceKey(data.mountId || mountId));
    } else {
      st.setDeskWorkspaceMount?.(null);
      if (data.basePath) st.setDeskBasePath(data.basePath);
      void loadJianContent(captureDeskSnapshot());
    }
    updateDeskContextBtn();
  } catch (err) {
    console.error('[jian-desk] load failed:', err);
    if (myVersion !== _deskLoadVersion) return;
    updateDeskContextBtn();
  }
}

export async function loadDeskTreeFiles(subdir = '', options: { force?: boolean; overrideDir?: string | null; overrideMountId?: string | null } = {}): Promise<boolean> {
  const s = useStore.getState();
  if (!s.serverPort) return false;
  const mountId = activeDeskMountId(s, options.overrideMountId);
  const dir = mountId ? undefined : activeDeskRoot(s, options.overrideDir);
  const normalizedSubdir = normalizeSubdir(subdir);
  const cached = s.deskTreeFilesByPath?.[normalizedSubdir];
  if (cached && !options.force) return true;

  const key = deskTreeLoadKey(mountId ? studioWorkspaceKey(mountId) : dir, normalizedSubdir);
  const myVersion = (_deskTreeLoadVersion.get(key) || 0) + 1;
  _deskTreeLoadVersion.set(key, myVersion);

  try {
    const params = new URLSearchParams();
    if (mountId) {
      params.set('mountId', mountId);
    } else if (dir) {
      params.set('dir', dir);
    }
    if (normalizedSubdir) params.set('subdir', normalizedSubdir);
    if (!mountId) addSelectedDeskAgentParam(params, s);
    const qs = params.toString() ? `?${params}` : '';
    const res = await codiaFetch(`${mountId ? '/api/workbench/files' : '/api/desk/files'}${qs}`);
    const data = await res.json();
    if (_deskTreeLoadVersion.get(key) !== myVersion) return false;
    if (data.error) throw new Error(getApiErrorMessage(data));
    const st = useStore.getState();
    if (mountId) {
      st.setDeskWorkspaceMount?.(
        data.mountId || mountId,
        data.mount?.label || st.deskWorkspaceLabel || null,
        normalizeMountNativeRoot(data.mount?.nativeRootPath) || st.deskWorkspaceNativeRoot || null,
      );
      st.setDeskBasePath(studioWorkspaceKey(data.mountId || mountId));
    } else {
      st.setDeskWorkspaceMount?.(null);
      if (data.basePath) st.setDeskBasePath(data.basePath);
    }
    st.setDeskTreeFiles?.(normalizedSubdir, data.files || []);
    if ((st.deskCurrentPath || '') === normalizedSubdir) st.setDeskFiles(data.files || []);
    return true;
  } catch (err) {
    console.error('[desk-tree] load failed:', err);
    if (_deskTreeLoadVersion.get(key) !== myVersion) return false;
    return false;
  }
}

export async function searchDeskFiles(query: string): Promise<DeskSearchResult[]> {
  const s = useStore.getState();
  if (!s.serverPort) return [];
  const trimmed = query.trim();
  if (!trimmed) return [];
  try {
    const params = new URLSearchParams();
    const mountId = activeDeskMountId(s);
    const dir = mountId ? undefined : defaultDeskRoot(s);
    if (mountId) {
      params.set('mountId', mountId);
    } else if (dir) {
      params.set('dir', dir);
    }
    if (!mountId) addSelectedDeskAgentParam(params, s);
    params.set('q', trimmed);
    const res = await codiaFetch(`${mountId ? '/api/workbench/search' : '/api/desk/search-files'}?${params}`);
    const data = await res.json();
    if (data.error) throw new Error(getApiErrorMessage(data));
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    console.error('[desk] search failed:', err);
    return [];
  }
}

export async function jumpToDeskSearchResult(result: DeskSearchResult): Promise<void> {
  const target = normalizeSubdir(result.relativePath);
  if (!target) return;
  const parent = normalizeSubdir(result.parentSubdir);
  const foldersToExpand = result.isDir
    ? ancestorSubdirs(target)
    : ancestorSubdirs(parent);
  useStore.setState((s: any) => ({
    deskExpandedPaths: Array.from(new Set([...(s.deskExpandedPaths || []), ...foldersToExpand])),
    deskSelectedPath: target,
  }));
  schedulePersistCurrentWorkspaceUiState();
  for (const subdir of foldersToExpand) {
    await loadDeskTreeFiles(subdir);
  }
  useStore.getState().setDeskSelectedPath?.(target);
}

export async function loadJianContent(expected?: DeskSnapshot): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;

  const snapshot = expected || captureDeskSnapshot();

  try {
    const params = new URLSearchParams();
    if (snapshot.basePath) params.set('dir', snapshot.basePath);
    if (snapshot.currentPath) params.set('subdir', snapshot.currentPath);
    addSelectedDeskAgentParam(params, s);
    const qs = params.toString() ? `?${params}` : '';
    const res = await codiaFetch(`/api/desk/jian${qs}`);
    const data = await res.json();

    if (!isSameDeskSnapshot(snapshot)) return;
    useStore.getState().setDeskJianContent(data.content || null);
  } catch (err) {
    console.error('[jian] load jian.md failed:', err);
    if (!isSameDeskSnapshot(snapshot)) return;
    useStore.getState().setDeskJianContent(null);
  }
}

export async function saveJianContent(content?: string): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;

  const text = content ?? s.deskJianContent ?? '';
  const snapshot = captureDeskSnapshot();

  try {
    await codiaFetch('/api/desk/jian', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        content: text,
      }),
    });

    if (!isSameDeskSnapshot(snapshot)) return;
    useStore.getState().setDeskJianContent(text || null);

    const params = new URLSearchParams();
    if (snapshot.basePath) params.set('dir', snapshot.basePath);
    if (snapshot.currentPath) params.set('subdir', snapshot.currentPath);
    addSelectedDeskAgentParam(params, useStore.getState());
    const qs = params.toString() ? `?${params}` : '';
    const res2 = await codiaFetch(`/api/desk/files${qs}`);
    const data2 = await res2.json();

    if (!isSameDeskSnapshot(snapshot)) return;
    setDeskFilesForCurrentPath(data2.files || []);
  } catch (err) {
    console.error('[jian] save jian.md failed:', err);
  }
}

export async function deskUploadFiles(paths: string[]): Promise<void> {
  const snapshot = captureDeskSnapshot();
  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'upload',
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        paths,
      }),
    });
    const data = await res.json();
    if (!isSameDeskSnapshot(snapshot)) return;
    if (data.files) setDeskFilesForCurrentPath(data.files);
  } catch (err) {
    console.error('[jian-desk] upload failed:', err);
  }
}

export async function deskUploadFilesToSubdir(paths: string[], subdir: string): Promise<void> {
  const snapshot = captureDeskSnapshot();
  const normalizedSubdir = normalizeSubdir(subdir);
  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'upload',
        dir: snapshot.basePath || undefined,
        subdir: normalizedSubdir,
        paths,
      }),
    });
    const data = await res.json();
    if ((useStore.getState().deskBasePath || '') !== snapshot.basePath) return;
    if (data.files) applyFilesForSubdir(normalizedSubdir, data.files);
  } catch (err) {
    console.error('[jian-desk] upload to tree failed:', err);
  }
}

export async function deskUploadBrowserFilesToSubdir(files: File[], subdir: string): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSubdir = normalizeSubdir(subdir);
  const mountId = activeDeskMountId(s) || 'default';
  if (!s.deskBasePath || files.length === 0) return false;
  try {
    const payloadFiles = await Promise.all(files.map(async file => ({
      name: file.name,
      type: file.type || '',
      contentBase64: await blobToBase64(file),
    })));
    const res = await codiaFetch('/api/workbench/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mountId,
        subdir: normalizedSubdir,
        files: payloadFiles,
      }),
    });
    const data = await res.json();
    if (data.error || data.ok === false) {
      console.error('[jian-desk] workbench upload error:', data.error || data.results);
      return false;
    }
    if (data.files) applyFilesForSubdir(normalizedSubdir, data.files);
    return true;
  } catch (err) {
    console.error('[jian-desk] workbench upload failed:', err);
    return false;
  }
}

export async function deskCreateFile(text: string): Promise<boolean> {
  const snapshot = captureDeskSnapshot();
  const d = new Date();
  const ts = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const locale = typeof window !== 'undefined' ? (window.i18n?.locale || 'zh') : 'zh';
  const prefix = locale.startsWith('zh')
    ? '\u5907\u6ce8'
    : locale.startsWith('ja')
      ? '\u30e1\u30e2'
      : locale.startsWith('ko')
        ? '\uba54\ubaa8'
        : 'note';
  const name = nextAvailableDeskFileName(`${ts}-${prefix}.md`);

  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'create',
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        name,
        content: text,
      }),
    });
    const data = await res.json();
    if (data.error) {
      useStore.getState().addToast?.(getApiErrorMessage(data), 'error');
      return false;
    }
    if (!isSameDeskSnapshot(snapshot)) return true;
    if (data.files) setDeskFilesForCurrentPath(data.files);
    return true;
  } catch (err) {
    console.error('[jian-desk] create failed:', err);
    useStore.getState().addToast?.(
      err instanceof Error ? err.message : String(err),
      'error',
    );
    return false;
  }
}

export async function deskCreateMindmap(): Promise<boolean> {
  const snapshot = captureDeskSnapshot();
  const name = nextAvailableDeskFileName(t('desk.newMindmapFile'));

  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'createMindmap',
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        name,
        title: name.replace(/\.xmind$/i, ''),
      }),
    });
    const data = await res.json();
    if (data.error) {
      useStore.getState().addToast?.(getApiErrorMessage(data), 'error');
      return false;
    }
    if (!isSameDeskSnapshot(snapshot)) return true;
    if (data.files) setDeskFilesForCurrentPath(data.files);
    return true;
  } catch (err) {
    console.error('[jian-desk] create mindmap failed:', err);
    useStore.getState().addToast?.(
      err instanceof Error ? err.message : String(err),
      'error',
    );
    return false;
  }
}

export async function deskCreateMindmapFromDocument(sourceName: string, options: {
  sourceSubdir?: string;
} = {}): Promise<boolean> {
  const snapshot = captureDeskSnapshot();
  const targetSubdir = options.sourceSubdir ?? snapshot.currentPath ?? '';
  const name = nextAvailableDeskFileName(mindmapNameFromDocumentName(sourceName));

  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'createMindmapFromDocument',
        dir: snapshot.basePath || undefined,
        subdir: targetSubdir,
        sourceName,
        name,
      }),
    });
    const data = await res.json();
    if (data.error) {
      useStore.getState().addToast?.(getApiErrorMessage(data), 'error');
      return false;
    }
    if (!isSameDeskSnapshot(snapshot)) return true;
    if ((targetSubdir || '') !== (snapshot.currentPath || '')) {
      if (data.files) useStore.getState().setDeskTreeFiles?.(targetSubdir || '', data.files);
      return true;
    }
    if (data.files) setDeskFilesForCurrentPath(data.files);
    return true;
  } catch (err) {
    console.error('[jian-desk] create mindmap from document failed:', err);
    useStore.getState().addToast?.(
      err instanceof Error ? err.message : String(err),
      'error',
    );
    return false;
  }
}

export async function deskMoveFiles(names: string[], destFolder: string): Promise<void> {
  const snapshot = captureDeskSnapshot();
  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'move',
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        names,
        destFolder,
      }),
    });
    const data = await res.json();
    if (!isSameDeskSnapshot(snapshot)) return;
    if (data.files) setDeskFilesForCurrentPath(data.files);
  } catch (err) {
    console.error('[jian-desk] move failed:', err);
  }
}

export interface DeskTreeMoveItem {
  sourceSubdir: string;
  name: string;
  isDirectory?: boolean;
}

function applyRenamedDirectoryCache(oldSubdir: string, newSubdir: string): void {
  useStore.setState((s: any) => {
    const nextTree: Record<string, DeskFile[]> = {};
    for (const [key, files] of Object.entries(s.deskTreeFilesByPath || {})) {
      const nextKey = replaceSubdirPrefix(key, oldSubdir, newSubdir);
      nextTree[nextKey] = files as DeskFile[];
    }
    return {
      deskTreeFilesByPath: nextTree,
      deskExpandedPaths: (s.deskExpandedPaths || []).map((path: string) => replaceSubdirPrefix(path, oldSubdir, newSubdir)),
      deskSelectedPath: replaceSubdirPrefix(s.deskSelectedPath || '', oldSubdir, newSubdir),
      deskCurrentPath: replaceSubdirPrefix(s.deskCurrentPath || '', oldSubdir, newSubdir),
    };
  });
  schedulePersistCurrentWorkspaceUiState();
}

function pruneRemovedDirectoryCache(removedSubdirs: string[]): void {
  if (removedSubdirs.length === 0) return;
  useStore.setState((s: any) => {
    const nextTree: Record<string, DeskFile[]> = {};
    for (const [key, files] of Object.entries(s.deskTreeFilesByPath || {})) {
      if (removedSubdirs.some(prefix => removeSubdirPrefix(key, prefix))) continue;
      nextTree[key] = files as DeskFile[];
    }
    return {
      deskTreeFilesByPath: nextTree,
      deskExpandedPaths: (s.deskExpandedPaths || []).filter((path: string) => !removedSubdirs.some(prefix => removeSubdirPrefix(path, prefix))),
      deskSelectedPath: removedSubdirs.some(prefix => removeSubdirPrefix(s.deskSelectedPath || '', prefix)) ? '' : s.deskSelectedPath,
    };
  });
  schedulePersistCurrentWorkspaceUiState();
}

export async function deskMoveTreeFiles(items: DeskTreeMoveItem[], destSubdir: string): Promise<void> {
  const s = useStore.getState();
  if (items.length === 0) return;
  const normalizedDest = normalizeSubdir(destSubdir);
  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        action: 'movePaths',
        dir: s.deskBasePath || undefined,
        items: items.map(item => ({
          sourceSubdir: normalizeSubdir(item.sourceSubdir),
          name: item.name,
          isDirectory: !!item.isDirectory,
        })),
        destSubdir: normalizedDest,
        currentSubdir: s.deskCurrentPath || '',
      }),
    });
    const data = await res.json();
    const st = useStore.getState();
    if (data.filesByPath && typeof data.filesByPath === 'object') {
      for (const [subdir, files] of Object.entries(data.filesByPath)) {
        st.setDeskTreeFiles?.(subdir, files as DeskFile[]);
        if ((st.deskCurrentPath || '') === subdir) st.setDeskFiles(files as DeskFile[]);
      }
    }
    if (data.files && !data.filesByPath) {
      st.setDeskFiles(data.files);
      st.setDeskTreeFiles?.(st.deskCurrentPath || '', data.files);
    }
  } catch (err) {
    console.error('[jian-desk] tree move failed:', err);
  }
}

export async function deskRenameTreeItem(sourceSubdir: string, oldName: string, newName: string, isDirectory = false): Promise<boolean> {
  const s = useStore.getState();
  const normalizedSource = normalizeSubdir(sourceSubdir);
  const trimmed = newName.trim();
  if (!isPlainFileName(oldName) || !isPlainFileName(trimmed)) return false;
  if (oldName === trimmed) return true;
  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        action: 'rename',
        dir: s.deskBasePath || undefined,
        subdir: normalizedSource,
        oldName,
        newName: trimmed,
      }),
    });
    const data = await res.json();
    if (data.error) { console.error('[desk] tree rename error:', data.error); return false; }
    if (isDirectory) {
      applyRenamedDirectoryCache(childSubdir(normalizedSource, oldName), childSubdir(normalizedSource, trimmed));
    }
    if (data.files) {
      const st = useStore.getState();
      st.setDeskTreeFiles?.(normalizedSource, data.files);
      if ((st.deskCurrentPath || '') === normalizedSource) st.setDeskFiles(data.files);
    }
    return true;
  } catch (err) {
    console.error('[desk] tree rename failed:', err);
    return false;
  }
}

export async function deskTrashTreeItems(items: DeskTreeMoveItem[]): Promise<boolean> {
  const s = useStore.getState();
  if (shouldUseWorkbenchDeskAction(s)) {
    return deskSafeDeleteMobileWorkbenchItems(items);
  }
  const trashItem = window.platform?.trashItem;
  if (!trashItem) {
    console.error('[desk] system trash is not available');
    return false;
  }
  if (!s.deskBasePath || items.length === 0) return false;

  const affectedParents = new Set<string>();
  const removedDirs: string[] = [];
  const paths = items.map(item => ({
    ...item,
    sourceSubdir: normalizeSubdir(item.sourceSubdir),
    path: joinDeskPath(s.deskBasePath, item.sourceSubdir, item.name),
  }));

  let trashedCount = 0;
  try {
    for (const item of paths) {
      if (!isPlainFileName(item.name)) break;
      const ok = await trashItem(item.path);
      if (!ok) break;
      trashedCount += 1;
      affectedParents.add(item.sourceSubdir);
      if (item.isDirectory) removedDirs.push(childSubdir(item.sourceSubdir, item.name));
    }
  } catch (err) {
    console.error('[desk] tree trash failed:', err);
  } finally {
    pruneRemovedDirectoryCache(removedDirs);
    for (const parent of affectedParents) {
      await loadDeskTreeFiles(parent, { force: true });
    }
  }
  return trashedCount === paths.length;
}

async function deskSafeDeleteMobileWorkbenchItems(items: DeskTreeMoveItem[]): Promise<boolean> {
  const s = useStore.getState();
  if (!s.deskBasePath || items.length === 0) return false;
  const mountId = activeDeskMountId(s) || 'default';
  const paths = items.map(item => ({
    ...item,
    sourceSubdir: normalizeSubdir(item.sourceSubdir),
  }));
  const removedDirs: string[] = [];
  let deletedCount = 0;
  try {
    for (const item of paths) {
      if (!isPlainFileName(item.name)) break;
      const res = await codiaFetch('/api/workbench/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'safeDelete',
          mountId,
          subdir: item.sourceSubdir,
          name: item.name,
        }),
      });
      const data = await res.json();
      if (data.error || data.ok === false) break;
      deletedCount += 1;
      if (data.files) applyFilesForSubdir(item.sourceSubdir, data.files);
      if (item.isDirectory) removedDirs.push(childSubdir(item.sourceSubdir, item.name));
    }
  } catch (err) {
    console.error('[desk] workbench safe delete failed:', err);
  } finally {
    pruneRemovedDirectoryCache(removedDirs);
  }
  return deletedCount === paths.length;
}

export async function deskRemoveFile(name: string): Promise<void> {
  const snapshot = captureDeskSnapshot();
  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'remove',
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        name,
      }),
    });
    const data = await res.json();
    if (!isSameDeskSnapshot(snapshot)) return;
    if (data.files) setDeskFilesForCurrentPath(data.files);
  } catch (err) {
    console.error('[jian-desk] remove failed:', err);
  }
}

export async function deskMkdir(): Promise<string | null> {
  const s = useStore.getState();
  const snapshot = captureDeskSnapshot();
  let name = t('desk.newFolder');
  const existing = new Set(s.deskFiles.map((f: { name: string }) => f.name));
  if (existing.has(name)) {
    let i = 2;
    while (existing.has(`${name} ${i}`)) i++;
    name = `${name} ${i}`;
  }

  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(s),
        action: 'mkdir',
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        name,
      }),
    });
    const data = await res.json();
    if (!isSameDeskSnapshot(snapshot)) return null;
    if (data.files) {
      setDeskFilesForCurrentPath(data.files);
      return name;
    }
  } catch (err) {
    console.error('[desk] mkdir failed:', err);
  }
  return null;
}

export async function deskRenameFile(oldName: string, newName: string): Promise<boolean> {
  const snapshot = captureDeskSnapshot();
  try {
    const res = await codiaFetch('/api/desk/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...selectedDeskAgentBody(useStore.getState()),
        action: 'rename',
        dir: snapshot.basePath || undefined,
        subdir: snapshot.currentPath || '',
        oldName,
        newName,
      }),
    });
    const data = await res.json();
    if (data.error) {
      console.error('[desk] rename error:', data.error);
      return false;
    }
    if (!isSameDeskSnapshot(snapshot)) return true;
    if (data.files) setDeskFilesForCurrentPath(data.files);
    return true;
  } catch (err) {
    console.error('[desk] rename failed:', err);
    return false;
  }
}

export function toggleMemory(): void {
  useStore.setState((s: any) => ({ memoryEnabled: !s.memoryEnabled }));
}

export async function applyFolder(folder: string): Promise<void> {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    selectedFolder: normalized,
    selectedWorkspaceMountId: null,
    selectedWorkspaceLabel: null,
    cwdHistory: mergeWorkspaceHistory(s.cwdHistory, [normalized]),
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => normalizeFolder(p) !== normalized),
  }));
  void activateWorkspaceDesk(normalized, { mountId: null, reload: false });
  const s = useStore.getState();
  if (!s.pendingNewSession) {
    useStore.setState({ currentSessionPath: null, pendingNewSession: true });
    clearChat();
    useStore.getState().requestInputFocus();
  }
  await persistWorkspaceHistory(normalized);
  await loadDeskFiles(useStore.getState().deskCurrentPath || '', normalized, null);
}

async function persistWorkspaceHistory(folder: string): Promise<void> {
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const res = await codiaFetch('/api/config/workspaces/recent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: folder }),
    });
    const data = await res.json();
    if (data.error) throw new Error(String(data.error));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] persist history failed:', err);
  }
}

export async function removeRecentWorkspace(folder: string): Promise<void> {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    cwdHistory: removeWorkspaceHistoryEntries(s.cwdHistory, [normalized]),
  }));
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const res = await codiaFetch('/api/config/workspaces/recent', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: normalized }),
    });
    const data = await res.json();
    if (data.error) throw new Error(getApiErrorMessage(data));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] remove recent history failed:', err);
  }
}

export async function clearRecentWorkspaces(): Promise<void> {
  useStore.setState({ cwdHistory: [] });
  const s = useStore.getState();
  if (!s.serverPort) return;
  try {
    const res = await codiaFetch('/api/config/workspaces/recent/all', {
      method: 'DELETE',
    });
    const data = await res.json();
    if (data.error) throw new Error(getApiErrorMessage(data));
    if (Array.isArray(data.cwd_history)) {
      useStore.setState({ cwdHistory: mergeWorkspaceHistory(data.cwd_history, []) });
    }
  } catch (err) {
    console.error('[workspace] clear recent history failed:', err);
  }
}

export function addWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => {
    const primary = normalizeFolder(s.selectedFolder) || normalizeFolder(s.homeFolder);
    if (normalized === primary) return {};
    if ((s.workspaceFolders || []).includes(normalized)) return {};
    return { workspaceFolders: [...(s.workspaceFolders || []), normalized] };
  });
}

export function removeWorkspaceFolder(folder: string): void {
  const normalized = normalizeFolder(folder);
  if (!normalized) return;
  useStore.setState((s: any) => ({
    workspaceFolders: (s.workspaceFolders || []).filter((p: string) => p !== normalized),
  }));
}

export function updateDeskContextBtn(): void {
  const s = useStore.getState();
  const available = !!s.deskBasePath && s.deskFiles.length > 0;
  if (!available && s.deskContextAttached) {
    s.setDeskContextAttached(false);
  }
}

export function toggleJianSidebar(forceOpen?: boolean): void {
  const s = useStore.getState();
  const newOpen = forceOpen !== undefined ? forceOpen : !s.jianOpen;
  s.setJianOpen(newOpen);
  const tab = s.currentTab || 'chat';
  localStorage.setItem(`codia-jian-${tab}`, newOpen ? 'open' : 'closed');
  if (forceOpen === undefined) s.setJianAutoCollapsed(false);
}

export function initJian(): void {
  const legacy = localStorage.getItem('codia-jian');
  if (legacy && !localStorage.getItem('codia-jian-chat')) {
    localStorage.setItem('codia-jian-chat', legacy);
  }
  const savedJian = localStorage.getItem('codia-jian-chat');
  if (savedJian !== null) useStore.getState().setJianOpen(savedJian !== 'closed');
  const s = useStore.getState();
  void activateWorkspaceDesk(s.selectedFolder || s.homeFolder || null);
}
