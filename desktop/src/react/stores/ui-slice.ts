import type { ActivePanel, RightWorkspaceTab, TabType } from '../types';
import type { FileRef } from '../types/file-ref';

export interface MediaViewerState {
  files: FileRef[];
  currentId: string;
  origin: 'desk' | 'session';
}

export interface SettingsModalState {
  open: boolean;
  activeTab: string;
}

export type AppViewMode = 'standard';
type LegacyAppViewModeInput = AppViewMode | 'obsidian';

const APP_VIEW_MODE_KEY = 'codia-app-view-mode';

function readInitialAppViewMode(): AppViewMode {
  if (typeof localStorage === 'undefined') return 'standard';
  try {
    // Reader mode was removed. Rewrite the legacy value during startup so an
    // existing profile can never reopen in the retired full-screen surface.
    if (localStorage.getItem(APP_VIEW_MODE_KEY) !== 'standard') {
      localStorage.setItem(APP_VIEW_MODE_KEY, 'standard');
    }
    return 'standard';
  } catch {
    return 'standard';
  }
}

function persistAppViewMode(mode: AppViewMode): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(APP_VIEW_MODE_KEY, mode);
  } catch {
    // Best effort only; the in-memory UI mode still works if storage is blocked.
  }
}

function stateForViewMode(_requestedMode: unknown): Partial<UiSlice> {
  return { appViewMode: 'standard' };
}

export interface UiSlice {
  sidebarOpen: boolean;
  sidebarAutoCollapsed: boolean;
  jianOpen: boolean;
  jianAutoCollapsed: boolean;
  previewOpen: boolean;
  welcomeVisible: boolean;
  currentTab: TabType;
  appViewMode: AppViewMode;
  rightWorkspaceTab: RightWorkspaceTab;
  jianDrawerOpen: boolean;
  activePanel: ActivePanel;
  locale: string;
  voiceRecording: boolean;
  voiceSpeakingMessageId: string | null;
  /** Skill 预览 overlay 数据（null = 关闭） */
  skillViewerData: { name: string; baseDir: string; filePath?: string; installed?: boolean } | null;
  /** 媒体预览 overlay 状态（null = 关闭） */
  mediaViewer: MediaViewerState | null;
  /** 主窗口内嵌设置浮层状态 */
  settingsModal: SettingsModalState;
  /** 频道创建弹窗是否可见 */
  channelCreateOverlayVisible: boolean;
  setSidebarOpen: (open: boolean) => void;
  setSidebarAutoCollapsed: (collapsed: boolean) => void;
  setJianOpen: (open: boolean) => void;
  setJianAutoCollapsed: (collapsed: boolean) => void;
  setPreviewOpen: (open: boolean) => void;
  setWelcomeVisible: (visible: boolean) => void;
  setCurrentTab: (tab: TabType) => void;
  /** @deprecated Kept only to normalize profiles saved before reader-mode removal. */
  setAppViewMode: (mode: LegacyAppViewModeInput) => void;
  toggleAppViewMode: () => void;
  setRightWorkspaceTab: (tab: RightWorkspaceTab) => void;
  setJianDrawerOpen: (open: boolean) => void;
  setActivePanel: (panel: ActivePanel) => void;
  setChannelCreateOverlayVisible: (visible: boolean) => void;
  setVoiceRecording: (recording: boolean) => void;
  setVoiceSpeakingMessageId: (messageId: string | null) => void;
  setMediaViewer: (state: MediaViewerState | null) => void;
  setSettingsModal: (state: SettingsModalState) => void;
  setMediaViewerCurrent: (id: string) => void;
  closeMediaViewer: () => void;
  toggleSidebar: () => void;
  toggleJian: () => void;
}

export const createUiSlice = (
  set: (partial: Partial<UiSlice> | ((s: UiSlice) => Partial<UiSlice>)) => void
): UiSlice => {
  const initialAppViewMode = readInitialAppViewMode();

  return ({
  sidebarOpen: true,
  sidebarAutoCollapsed: false,
  jianOpen: true,
  jianAutoCollapsed: false,
  previewOpen: false,
  welcomeVisible: true,
  currentTab: 'chat',
  appViewMode: initialAppViewMode,
  rightWorkspaceTab: 'workspace',
  jianDrawerOpen: false,
  activePanel: null,
  voiceRecording: false,
  voiceSpeakingMessageId: null,
  // Keep locale empty until i18n.load() finishes so the first successful
  // locale sync always triggers a rerender, even for the default zh locale.
  locale: '',
  skillViewerData: null,
  mediaViewer: null,
  settingsModal: { open: false, activeTab: 'agent' },
  channelCreateOverlayVisible: false,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarAutoCollapsed: (collapsed) => set({ sidebarAutoCollapsed: collapsed }),
  setJianOpen: (open) => set({ jianOpen: open }),
  setJianAutoCollapsed: (collapsed) => set({ jianAutoCollapsed: collapsed }),
  setPreviewOpen: (open) => set({ previewOpen: open }),
  setWelcomeVisible: (visible) => set({ welcomeVisible: visible }),
  setCurrentTab: (tab) => set({ currentTab: tab }),
  setAppViewMode: (mode) => {
    persistAppViewMode('standard');
    set(stateForViewMode(mode));
  },
  toggleAppViewMode: () => {
    persistAppViewMode('standard');
    set({ appViewMode: 'standard' });
  },
  setRightWorkspaceTab: (tab) => set({ rightWorkspaceTab: tab }),
  setJianDrawerOpen: (open) => set({ jianDrawerOpen: open }),
  setActivePanel: (panel) => set({ activePanel: panel }),
  setChannelCreateOverlayVisible: (visible) => set({ channelCreateOverlayVisible: visible }),
  setVoiceRecording: (recording) => set({ voiceRecording: recording }),
  setVoiceSpeakingMessageId: (messageId) => set({ voiceSpeakingMessageId: messageId }),
  setMediaViewer: (state) => set({ mediaViewer: state }),
  setSettingsModal: (state) => set({ settingsModal: state }),
  setMediaViewerCurrent: (id) => set((s) => ({
    mediaViewer: s.mediaViewer ? { ...s.mediaViewer, currentId: id } : null,
  })),
  closeMediaViewer: () => set({ mediaViewer: null }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleJian: () => set((s) => ({ jianOpen: !s.jianOpen })),
});
};
