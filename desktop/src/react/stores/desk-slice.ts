import type { DeskFile, RightWorkspaceTab, StudioWorkspace } from '../types';
import type { PreviewReadingPosition } from '../../../../shared/preview-reading-position.ts';

export const DESK_OWNER = 'desk';

export interface DeskSkillInfo {
  name: string;
  enabled: boolean;
  displayName?: string;
  displayNames?: Record<string, string>;
  source?: string;
  externalLabel?: string | null;
  managedBy?: string | null;
}

export interface CwdSkillInfo {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  workspaceMountId?: string | null;
}

export interface WorkspaceDeskState {
  deskCurrentPath: string;
  deskFiles: DeskFile[];
  deskTreeFilesByPath: Record<string, DeskFile[]>;
  deskExpandedPaths: string[];
  deskDirtyTreePaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
  previewOpen: boolean;
  jianDrawerOpen: boolean;
  rightWorkspaceTab: RightWorkspaceTab;
  jianView: string;
  openTabs: string[];
  activeTabId: string | null;
  markdownPreviewIds: string[];
  previewReadingPositions: Record<string, PreviewReadingPosition>;
}

export interface DeskOwnerState {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskTreeFilesByPath: Record<string, DeskFile[]>;
  deskExpandedPaths: string[];
  deskDirtyTreePaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  deskSkills: DeskSkillInfo[];
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
}

const EMPTY_OWNER_STATE: DeskOwnerState = {
  deskFiles: [],
  deskBasePath: '',
  deskCurrentPath: '',
  deskTreeFilesByPath: {},
  deskExpandedPaths: [],
  deskDirtyTreePaths: [],
  deskSelectedPath: '',
  deskJianContent: null,
  deskSkills: [],
  cwdSkills: [],
  cwdSkillsOpen: false,
};

function cloneOwnerState(state?: Partial<DeskOwnerState> | null): DeskOwnerState {
  return {
    deskFiles: [...(state?.deskFiles || [])],
    deskBasePath: state?.deskBasePath || '',
    deskCurrentPath: state?.deskCurrentPath || '',
    deskTreeFilesByPath: { ...(state?.deskTreeFilesByPath || {}) },
    deskExpandedPaths: [...(state?.deskExpandedPaths || [])],
    deskDirtyTreePaths: [...(state?.deskDirtyTreePaths || [])],
    deskSelectedPath: state?.deskSelectedPath || '',
    deskJianContent: state?.deskJianContent ?? null,
    deskSkills: [...(state?.deskSkills || [])],
    cwdSkills: [...(state?.cwdSkills || [])],
    cwdSkillsOpen: state?.cwdSkillsOpen ?? false,
  };
}

function ownerFromState(state?: { currentSessionPath?: string | null }) {
  return state?.currentSessionPath || DESK_OWNER;
}

export interface DeskSlice {
  deskFiles: DeskFile[];
  deskBasePath: string;
  deskCurrentPath: string;
  deskTreeFilesByPath: Record<string, DeskFile[]>;
  deskExpandedPaths: string[];
  deskDirtyTreePaths: string[];
  deskSelectedPath: string;
  deskJianContent: string | null;
  deskSkills: DeskSkillInfo[];
  cwdSkills: CwdSkillInfo[];
  cwdSkillsOpen: boolean;
  deskStateByOwner: Record<string, DeskOwnerState>;
  homeFolder: string | null;
  selectedFolder: string | null;
  selectedWorkspaceMountId: string | null;
  selectedWorkspaceLabel: string | null;
  workspaceFolders: string[];
  cwdHistory: string[];
  deskWorkspaceMountId: string | null;
  deskWorkspaceLabel: string | null;
  deskWorkspaceNativeRoot: string | null;
  studioWorkspaces: StudioWorkspace[];
  workspaceDeskStateByRoot: Record<string, WorkspaceDeskState>;
  getDeskStateForOwner: (owner: string) => DeskOwnerState | null;
  restoreDeskStateForOwner: (owner: string) => void;
  cloneDeskStateToOwner: (targetOwner: string, sourceOwner?: string) => void;
  setCwdSkills: (skills: CwdSkillInfo[]) => void;
  setCwdSkillsOpen: (open: boolean) => void;
  toggleCwdSkillsOpen: () => void;
  setDeskFiles: (files: DeskFile[]) => void;
  setDeskBasePath: (path: string) => void;
  setDeskCurrentPath: (path: string) => void;
  setDeskTreeFiles: (subdir: string, files: DeskFile[]) => void;
  setDeskExpandedPaths: (paths: string[]) => void;
  markDeskTreeDirty: (subdir: string) => void;
  clearDeskTreeDirty: (subdirs: string[]) => void;
  setDeskSelectedPath: (path: string) => void;
  clearDeskTree: () => void;
  setDeskJianContent: (content: string | null) => void;
  setDeskSkills: (skills: DeskSkillInfo[]) => void;
  setHomeFolder: (folder: string | null) => void;
  setSelectedFolder: (folder: string | null) => void;
  setSelectedWorkspaceMount: (mountId: string | null, label?: string | null) => void;
  setWorkspaceFolders: (folders: string[]) => void;
  setCwdHistory: (history: string[]) => void;
  setDeskWorkspaceMount: (mountId: string | null, label?: string | null, nativeRootPath?: string | null) => void;
  setStudioWorkspaces: (workspaces: StudioWorkspace[]) => void;
  setWorkspaceDeskState: (root: string, state: WorkspaceDeskState) => void;
}

export const createDeskSlice = (
  set: (
    partial: Partial<DeskSlice> | ((state: DeskSlice & { currentSessionPath?: string | null }) => Partial<DeskSlice>)
  ) => void,
  get?: () => (DeskSlice & { currentSessionPath?: string | null }),
): DeskSlice => {
  const patchCurrentOwner = (partial: Partial<DeskOwnerState>) => {
    set((state) => {
      const owner = ownerFromState(state);
      const current = cloneOwnerState(state.deskStateByOwner?.[owner] || EMPTY_OWNER_STATE);
      const nextOwnerState = cloneOwnerState({ ...current, ...partial });
      return {
        deskStateByOwner: {
          ...(state.deskStateByOwner || {}),
          [owner]: nextOwnerState,
        },
        ...partial,
      };
    });
  };

  return {
    ...cloneOwnerState(EMPTY_OWNER_STATE),
    deskStateByOwner: {},
    homeFolder: null,
    selectedFolder: null,
    selectedWorkspaceMountId: null,
    selectedWorkspaceLabel: null,
    workspaceFolders: [],
    cwdHistory: [],
    deskWorkspaceMountId: null,
    deskWorkspaceLabel: null,
    deskWorkspaceNativeRoot: null,
    studioWorkspaces: [],
    workspaceDeskStateByRoot: {},
    getDeskStateForOwner: (owner) => {
      const state = get?.();
      if (!state) return null;
      return cloneOwnerState(state.deskStateByOwner?.[owner] || EMPTY_OWNER_STATE);
    },
    restoreDeskStateForOwner: (owner) => {
      const state = get?.();
      const restored = cloneOwnerState(state?.deskStateByOwner?.[owner] || EMPTY_OWNER_STATE);
      set(restored);
    },
    cloneDeskStateToOwner: (targetOwner, sourceOwner) => {
      if (!targetOwner) return;
      const state = get?.();
      if (!state) return;
      const fromOwner = sourceOwner || ownerFromState(state);
      const source = cloneOwnerState(state.deskStateByOwner?.[fromOwner] || {
        ...EMPTY_OWNER_STATE,
        deskBasePath: state.deskBasePath,
        deskCurrentPath: state.deskCurrentPath,
        deskJianContent: state.deskJianContent,
        deskFiles: state.deskFiles,
        deskSkills: state.deskSkills,
        cwdSkills: state.cwdSkills,
        cwdSkillsOpen: state.cwdSkillsOpen,
      });
      set({
        deskStateByOwner: {
          ...(state.deskStateByOwner || {}),
          [targetOwner]: source,
        },
      });
    },
    setCwdSkills: (skills) => patchCurrentOwner({ cwdSkills: skills }),
    setCwdSkillsOpen: (open) => patchCurrentOwner({ cwdSkillsOpen: open }),
    toggleCwdSkillsOpen: () => {
      const state = get?.();
      patchCurrentOwner({ cwdSkillsOpen: !(state?.cwdSkillsOpen ?? false) });
    },
    setDeskFiles: (files) => patchCurrentOwner({ deskFiles: files }),
    setDeskBasePath: (path) => patchCurrentOwner({ deskBasePath: path }),
    setDeskCurrentPath: (path) => patchCurrentOwner({ deskCurrentPath: path }),
    setDeskTreeFiles: (subdir, files) => set((state) => {
      const owner = ownerFromState(state);
      const current = cloneOwnerState(state.deskStateByOwner?.[owner] || EMPTY_OWNER_STATE);
      const deskTreeFilesByPath = {
        ...current.deskTreeFilesByPath,
        [subdir]: files,
      };
      return {
        deskTreeFilesByPath,
        deskStateByOwner: {
          ...(state.deskStateByOwner || {}),
          [owner]: cloneOwnerState({ ...current, deskTreeFilesByPath }),
        },
      };
    }),
    setDeskExpandedPaths: (paths) => patchCurrentOwner({ deskExpandedPaths: paths }),
    markDeskTreeDirty: (subdir) => {
      const normalized = (subdir || '').replace(/^\/+|\/+$/g, '');
      set((state) => {
        const owner = ownerFromState(state);
        const current = cloneOwnerState(state.deskStateByOwner?.[owner] || {
          ...EMPTY_OWNER_STATE,
          deskDirtyTreePaths: state.deskDirtyTreePaths,
        });
        if (current.deskDirtyTreePaths.includes(normalized)) return {};
        const deskDirtyTreePaths = [...current.deskDirtyTreePaths, normalized];
        return {
          deskDirtyTreePaths,
          deskStateByOwner: {
            ...(state.deskStateByOwner || {}),
            [owner]: cloneOwnerState({ ...current, deskDirtyTreePaths }),
          },
        };
      });
    },
    clearDeskTreeDirty: (subdirs) => {
      const clearSet = new Set(subdirs.map(subdir => (subdir || '').replace(/^\/+|\/+$/g, '')));
      if (clearSet.size === 0) return;
      set((state) => {
        const owner = ownerFromState(state);
        const current = cloneOwnerState(state.deskStateByOwner?.[owner] || {
          ...EMPTY_OWNER_STATE,
          deskDirtyTreePaths: state.deskDirtyTreePaths,
        });
        const deskDirtyTreePaths = current.deskDirtyTreePaths.filter((subdir: string) => !clearSet.has(subdir));
        if (deskDirtyTreePaths.length === current.deskDirtyTreePaths.length) return {};
        return {
          deskDirtyTreePaths,
          deskStateByOwner: {
            ...(state.deskStateByOwner || {}),
            [owner]: cloneOwnerState({ ...current, deskDirtyTreePaths }),
          },
        };
      });
    },
    setDeskSelectedPath: (path) => patchCurrentOwner({ deskSelectedPath: path }),
    clearDeskTree: () => patchCurrentOwner({
      deskTreeFilesByPath: {},
      deskExpandedPaths: [],
      deskDirtyTreePaths: [],
      deskSelectedPath: '',
    }),
    setDeskJianContent: (content) => patchCurrentOwner({ deskJianContent: content }),
    setDeskSkills: (skills) => patchCurrentOwner({ deskSkills: skills }),
    setHomeFolder: (folder) => set({ homeFolder: folder }),
    setSelectedFolder: (folder) => set({ selectedFolder: folder }),
    setSelectedWorkspaceMount: (mountId, label = null) => set({
      selectedWorkspaceMountId: mountId,
      selectedWorkspaceLabel: label,
    }),
    setWorkspaceFolders: (folders) => set({ workspaceFolders: folders }),
    setCwdHistory: (history) => set({ cwdHistory: history }),
    setDeskWorkspaceMount: (mountId, label = null, nativeRootPath = null) => set({
      deskWorkspaceMountId: mountId,
      deskWorkspaceLabel: label,
      deskWorkspaceNativeRoot: nativeRootPath,
    }),
    setStudioWorkspaces: (workspaces) => set({ studioWorkspaces: workspaces }),
    setWorkspaceDeskState: (root, state) => set((s) => ({
      workspaceDeskStateByRoot: {
        ...(s.workspaceDeskStateByRoot || {}),
        [root]: state,
      },
    })),
  };
};
