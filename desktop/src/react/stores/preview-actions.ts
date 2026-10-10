/**
 * preview-actions.ts — Artifact 预览管理
 *
 * 所有写入都走 owner-keyed previewByOwner，不存在无主的 flat state。
 * owner = session path | DESK_OWNER。
 */

import { useStore } from './index';
import { DESK_OWNER, getPreviewOwner, getOwnerState } from './preview-slice';
import { schedulePersistCurrentWorkspaceUiState } from './workspace-ui-state-actions';
import { updateLayout } from '../services/layout-state';
import type { Artifact } from '../types';
import {
  normalizePreviewReadingPosition,
  type PreviewReadingMode,
  type PreviewReadingPosition,
  type PreviewScrollSnapshot,
} from '../../../../shared/preview-reading-position.ts';

/* eslint-disable @typescript-eslint/no-explicit-any -- IPC callback data */

let _artifactCounter = 0;

const VIEWER_SUPPORTED_TYPES = new Set(['markdown', 'code', 'csv']);

function schedulePersistDeskPreview(owner: string): void {
  if (owner === DESK_OWNER) schedulePersistCurrentWorkspaceUiState();
}

export function canSpawnViewer(artifact: Artifact | null): boolean {
  if (!artifact?.filePath) return false;
  return VIEWER_SUPPORTED_TYPES.has(artifact.type);
}

export async function spawnViewer(artifact: Artifact): Promise<void> {
  if (!canSpawnViewer(artifact)) return;
  if (!artifact.filePath) return;
  const windowId = await window.platform?.spawnViewer?.({
    filePath: artifact.filePath,
    title: artifact.title,
    type: artifact.type,
    language: artifact.language,
  });

  if (typeof windowId !== 'number') return;

  useStore.getState().addPinnedViewer({
    windowId,
    filePath: artifact.filePath,
    title: artifact.title,
  });
}

export function initViewerEvents(): void {
  window.platform?.onViewerClosed?.((windowId: number) => {
    useStore.getState().removePinnedViewer(windowId);
  });
}

// ── Owner-keyed write primitive ──

/**
 * 更新指定 owner 的预览状态。
 * updater 接收当前 owner 的 state，返回要合并的 partial。
 */
type OwnerPreviewPatch = Partial<{
  artifacts: Artifact[];
  openTabs: string[];
  activeTabId: string | null;
  markdownPreviewIds: string[];
  previewReadingPositions: Record<string, PreviewReadingPosition>;
}>;

function updateOwner(
  owner: string,
  updater: (prev: {
    artifacts: Artifact[];
    openTabs: string[];
    activeTabId: string | null;
    markdownPreviewIds: string[];
    previewReadingPositions: Record<string, PreviewReadingPosition>;
  }) => OwnerPreviewPatch,
): void {
  useStore.setState(s => {
    const prev = getOwnerState(s, owner);
    const patch = updater(prev);
    return {
      previewByOwner: {
        ...s.previewByOwner,
        [owner]: { ...prev, ...patch },
      },
    };
  });
}

/** 向指定 owner 的 artifacts 中 upsert 一条 */
export function upsertArtifactForOwner(owner: string, artifact: Artifact): void {
  updateOwner(owner, prev => {
    const arts = [...prev.artifacts];
    const idx = arts.findIndex(a => a.id === artifact.id);
    if (idx >= 0) arts[idx] = artifact;
    else arts.push(artifact);
    return { artifacts: arts };
  });
}

/** 在指定 owner 下打开 tab */
export function openTabForOwner(owner: string, id: string): void {
  updateOwner(owner, prev => {
    const tabs = prev.openTabs.includes(id) ? prev.openTabs : [...prev.openTabs, id];
    return { openTabs: tabs, activeTabId: id };
  });
  schedulePersistDeskPreview(owner);
}

/** 在指定 owner 下关闭 tab */
export function closeTabForOwner(owner: string, id: string): void {
  updateOwner(owner, prev => {
    const idx = prev.openTabs.indexOf(id);
    if (idx < 0) return {};
    const tabs = prev.openTabs.filter(t => t !== id);
    let active = prev.activeTabId;
    if (active === id) {
      active = tabs[Math.max(0, idx - 1)] ?? null;
    }
    return {
      openTabs: tabs,
      activeTabId: active,
      markdownPreviewIds: prev.markdownPreviewIds.filter(previewId => previewId !== id),
      previewReadingPositions: Object.fromEntries(
        Object.entries(prev.previewReadingPositions || {}).filter(([previewId]) => previewId !== id),
      ),
    };
  });
  schedulePersistDeskPreview(owner);
}

/** 在指定 owner 下切换激活 tab */
export function setActiveTabForOwner(owner: string, id: string): void {
  updateOwner(owner, () => ({ activeTabId: id }));
  schedulePersistDeskPreview(owner);
}

/** 清空指定 owner 的全部预览状态 */
export function clearOwnerPreview(owner: string): void {
  useStore.setState(s => {
    const next = { ...s.previewByOwner };
    delete next[owner];
    return { previewByOwner: next };
  });
  schedulePersistDeskPreview(owner);
}

// ── 便捷函数：自动解析当前 owner ──

function currentOwner(): string {
  return getPreviewOwner(useStore.getState());
}

export function upsertArtifact(artifact: Artifact): void {
  upsertArtifactForOwner(currentOwner(), artifact);
}

export function openTab(id: string): void {
  openTabForOwner(currentOwner(), id);
}

export function closeTab(id: string): void {
  closeTabForOwner(currentOwner(), id);
}

export function setActiveTab(id: string): void {
  setActiveTabForOwner(currentOwner(), id);
}

export function clearPreview(): void {
  clearOwnerPreview(currentOwner());
}

export function setMarkdownPreviewActiveForOwner(owner: string, id: string, active: boolean): void {
  updateOwner(owner, prev => {
    const current = new Set(prev.markdownPreviewIds);
    if (active) current.add(id);
    else current.delete(id);
    return { markdownPreviewIds: [...current] };
  });
  schedulePersistDeskPreview(owner);
}

export function setMarkdownPreviewActive(id: string, active: boolean): void {
  setMarkdownPreviewActiveForOwner(currentOwner(), id, active);
}

export function toggleMarkdownPreview(id: string): void {
  const owner = currentOwner();
  const previewIds = getOwnerState(useStore.getState(), owner).markdownPreviewIds;
  setMarkdownPreviewActiveForOwner(owner, id, !previewIds.includes(id));
}

export function setPreviewReadingPositionForOwner(owner: string, id: string, position: PreviewReadingPosition | null): void {
  if (!id) return;
  updateOwner(owner, prev => {
    const next = { ...(prev.previewReadingPositions || {}) };
    if (position) {
      const normalized = normalizePreviewReadingPosition(position);
      if (normalized) next[id] = normalized;
      else delete next[id];
    } else {
      delete next[id];
    }
    return { previewReadingPositions: next };
  });
  schedulePersistDeskPreview(owner);
}

export function setPreviewReadingPosition(id: string, position: PreviewReadingPosition | null): void {
  setPreviewReadingPositionForOwner(currentOwner(), id, position);
}

export function updatePreviewReadingPositionForOwner(
  owner: string,
  id: string,
  mode: PreviewReadingMode,
  snapshot: PreviewScrollSnapshot,
  heading?: { id: string; text: string } | null,
): void {
  if (!id) return;
  const now = Date.now();
  const current = getOwnerState(useStore.getState(), owner).previewReadingPositions[id] || {};
  setPreviewReadingPositionForOwner(owner, id, {
    ...current,
    [mode]: {
      ...snapshot,
      updatedAt: snapshot.updatedAt ?? now,
    },
    ...(heading?.id ? { currentHeadingId: heading.id } : {}),
    ...(heading?.text ? { currentHeadingText: heading.text } : {}),
    ...(snapshot.contentHash ? { contentHash: snapshot.contentHash } : {}),
    updatedAt: now,
  });
}

export function updatePreviewReadingPosition(
  id: string,
  mode: PreviewReadingMode,
  snapshot: PreviewScrollSnapshot,
  heading?: { id: string; text: string } | null,
): void {
  updatePreviewReadingPositionForOwner(currentOwner(), id, mode, snapshot, heading);
}

// ── 公共 API ──

/** 注册 artifact 并打开为 tab */
export function openPreview(artifact: Artifact): void {
  const owner = currentOwner();
  upsertArtifactForOwner(owner, artifact);
  openTabForOwner(owner, artifact.id);
  useStore.getState().setPreviewOpen(true);
  schedulePersistDeskPreview(owner);
  updateLayout();
}

/** 关闭面板（保留 openTabs 状态，下次打开时恢复） */
/** Toggle the preview panel without changing the existing tabs or artifacts. */
export function togglePreviewPanel(forceOpen?: boolean): void {
  const s = useStore.getState();
  const open = forceOpen ?? !s.previewOpen;
  if (open === s.previewOpen) return;
  if (!open && s.quoteCandidate?.sourceKind === 'preview') s.clearQuoteCandidate();
  s.setPreviewOpen(open);
  schedulePersistCurrentWorkspaceUiState();
  updateLayout();
}

export function closePreview(): void {
  togglePreviewPanel(false);
}

/** 注册 artifact 到 store（流式事件用）。要求 data 携带 sessionPath。 */
export function handleArtifact(data: Record<string, unknown>): void {
  const id = (data.artifactId as string) || `artifact-${++_artifactCounter}`;
  const artifact: Artifact = {
    id,
    type: data.artifactType as string,
    title: data.title as string,
    content: data.content as string,
    language: data.language as string | undefined,
  };

  // owner 必须由事件显式携带，不从全局焦点指针推导
  const sp = data.sessionPath as string | undefined;
  if (!sp) {
    console.warn('[artifact] handleArtifact called without sessionPath, skipping keyed write');
    return;
  }
  upsertArtifactForOwner(sp, artifact);
}

/**
 * 切换 session 后，根据目标 owner 的 tab 状态同步 previewOpen。
 * 有 tabs → 展开面板，无 tabs → 收起面板。
 */
export function syncPreviewPanelForOwner(sessionPath: string): void {
  const owner = sessionPath; // session path 就是 owner
  const state = getOwnerState(useStore.getState(), owner);
  const shouldOpen = state.openTabs.length > 0;
  useStore.getState().setPreviewOpen(shouldOpen);
  if (shouldOpen) updateLayout();
}

/**
 * 注册编辑器 dock/detach 事件监听
 * 在 App mount 时调用一次
 */
export function initEditorEvents(): void {
  window.platform?.onEditorDockFile?.((data: any) => {
    const owner = currentOwner();
    const ownerState = getOwnerState(useStore.getState(), owner);
    const existing = ownerState.artifacts.find(a => a.filePath === data.filePath);
    if (existing) {
      openPreview(existing);
    } else {
      void (async () => {
        const snapshot = await window.platform?.readFileSnapshot?.(data.filePath);
        if (snapshot) return snapshot;
        const content = await window.platform?.readFile(data.filePath);
        return content == null ? null : { content, version: null };
      })().then((snapshot) => {
        const content = snapshot?.content;
        if (content == null) return;
        const artifact: Artifact = {
          id: `file-${data.filePath}`,
          type: data.type,
          title: data.title,
          content,
          filePath: data.filePath,
          fileVersion: snapshot?.version ?? null,
          language: data.language,
        };
        openPreview(artifact);
      });
    }
    useStore.getState().setEditorDetached(false);
  });

  window.platform?.onEditorDetached?.((detached: boolean) => {
    useStore.getState().setEditorDetached(detached);
    if (detached) {
      const owner = currentOwner();
      const ownerState = getOwnerState(useStore.getState(), owner);
      if (ownerState.activeTabId) {
        closeTabForOwner(owner, ownerState.activeTabId);
        const afterState = getOwnerState(useStore.getState(), owner);
        if (afterState.openTabs.length === 0) {
          closePreview();
        }
      }
    }
  });
}
