import type { Artifact } from '../types';
import type { PreviewReadingPosition } from '../../../../shared/preview-reading-position.ts';

// ── Owner 常量 ──

/** Desk 模式（无 session）的 owner key */
export const DESK_OWNER = 'desk';

// ── 内部类型 ──

interface OwnerPreviewState {
  artifacts: Artifact[];
  openTabs: string[];
  activeTabId: string | null;
  markdownPreviewIds: string[];
  previewReadingPositions: Record<string, PreviewReadingPosition>;
}

const EMPTY_STATE: OwnerPreviewState = {
  artifacts: [],
  openTabs: [],
  activeTabId: null,
  markdownPreviewIds: [],
  previewReadingPositions: {},
};

export interface PinnedViewer {
  windowId: number;
  filePath: string;
  title: string;
}

// ── Slice ──

export interface ArtifactSlice {
  /** 所有预览状态按 owner 分区。key 为 session path 或 DESK_OWNER */
  previewByOwner: Record<string, OwnerPreviewState>;
  editorDetached: boolean;
  pinnedViewers: PinnedViewer[];
  setEditorDetached: (detached: boolean) => void;
  addPinnedViewer: (viewer: PinnedViewer) => void;
  removePinnedViewer: (windowId: number) => void;
  clearPinnedViewers: () => void;
}

export const createArtifactSlice = (
  set: (partial: Partial<ArtifactSlice> | ((s: ArtifactSlice) => Partial<ArtifactSlice>)) => void
): ArtifactSlice => ({
  previewByOwner: {},
  editorDetached: false,
  pinnedViewers: [],
  setEditorDetached: (detached) => set({ editorDetached: detached }),
  addPinnedViewer: (viewer) =>
    set((s) => {
      if (s.pinnedViewers.some((v) => v.windowId === viewer.windowId)) return {};
      return { pinnedViewers: [...s.pinnedViewers, viewer] };
    }),
  removePinnedViewer: (windowId) =>
    set((s) => ({ pinnedViewers: s.pinnedViewers.filter((v) => v.windowId !== windowId) })),
  clearPinnedViewers: () => set({ pinnedViewers: [] }),
});

// ── Owner 解析 ──

export function getPreviewOwner(s: { currentSessionPath: string | null }): string {
  return s.currentSessionPath ?? DESK_OWNER;
}

/** 读取指定 owner 的预览状态（不存在则返回空） */
export function getOwnerState(s: ArtifactSlice, owner: string): OwnerPreviewState {
  const state = s.previewByOwner[owner];
  return state ? { ...EMPTY_STATE, ...state } : EMPTY_STATE;
}

// ── Selectors ──

type StateWithSession = ArtifactSlice & { currentSessionPath: string | null };

export const selectArtifacts = (s: StateWithSession): Artifact[] =>
  getOwnerState(s, getPreviewOwner(s)).artifacts;

export const selectOpenTabs = (s: StateWithSession): string[] =>
  getOwnerState(s, getPreviewOwner(s)).openTabs;

export const selectActiveTabId = (s: StateWithSession): string | null =>
  getOwnerState(s, getPreviewOwner(s)).activeTabId;

export const selectMarkdownPreviewIds = (s: StateWithSession): string[] =>
  getOwnerState(s, getPreviewOwner(s)).markdownPreviewIds;

export const selectPreviewReadingPositions = (s: StateWithSession): Record<string, PreviewReadingPosition> =>
  getOwnerState(s, getPreviewOwner(s)).previewReadingPositions;

export const selectEditorDetached = (s: ArtifactSlice): boolean => s.editorDetached;
export const selectPinnedViewers = (s: ArtifactSlice): PinnedViewer[] => s.pinnedViewers;
