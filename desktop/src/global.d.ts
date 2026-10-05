import type { DesktopNotificationOptions, PlatformApi } from './react/types';

interface GsapE2EStateSnapshot {
  currentSessionPath: string | null;
  pendingNewSession: boolean;
  attachedFiles: Array<{
    path: string;
    name: string;
    isDirectory?: boolean;
    base64Data?: string;
    mimeType?: string;
  }>;
  models: Array<{
    id: string;
    name: string;
    provider?: string;
    isCurrent?: boolean;
    input?: ('text' | 'image' | 'video' | 'audio')[];
    vision?: boolean;
    reasoning?: boolean;
    contextWindow?: number | null;
    maxTokens?: number | null;
  }>;
  sessionModelsByPath: Record<string, {
    id: string;
    name: string;
    provider: string;
    input?: ('text' | 'image' | 'video' | 'audio')[];
    vision?: boolean;
    reasoning?: boolean;
  }>;
  inlineErrors: Record<string, string | null>;
  welcomeVisible: boolean;
}

interface GsapRuntimeDiagnosticsSnapshot {
  currentSessionPath: string | null;
  pendingNewSession: boolean;
  modelSwitching: boolean;
  currentSessionModel: {
    id: string;
    name: string;
    provider: string;
    input?: ('text' | 'image' | 'video' | 'audio')[];
    vision?: boolean;
    reasoning?: boolean;
  } | null;
}

interface GsapE2EApi {
  appReady: boolean;
  seedCopySession(payload: { sessionPath?: string; items: Array<{ type: 'message'; data: unknown }> }): string;
  selectMessages(sessionPath: string, ids: string[]): boolean;
  triggerCopy(messageId: string): boolean;
  serializeMessages(sessionPath: string): string[];
  copySelection(sessionPath: string, messageId?: string): Promise<boolean>;
  readClipboardText(): Promise<string>;
  getStateSnapshot(): GsapE2EStateSnapshot;
  getDeskSnapshot(): {
    currentSessionPath: string | null;
    homeFolder: string | null;
    selectedFolder: string | null;
    deskBasePath: string;
    deskCurrentPath: string;
    deskFiles: Array<{ name: string; isDir: boolean; size?: number; mtime?: string }>;
    deskJianContent: string | null;
    deskSkills: Array<{ name: string; enabled: boolean; source?: string; externalLabel?: string | null; managedBy?: string | null }>;
    cwdSkills: Array<{ name: string; description: string; source: string; filePath: string; baseDir: string }>;
    cwdSkillsOpen: boolean;
  };
  getPreviewSnapshot(): {
    owner: string;
    previewOpen: boolean;
    activeTabId: string | null;
    openTabs: string[];
    artifacts: Array<{ id: string; title: string; type: string; filePath: string | null }>;
  };
  setStore(partial: Record<string, unknown>): boolean;
  createSession(payload?: { cwd?: string | null; selectedFolder?: string | null }): Promise<{ ok: boolean; currentSessionPath: string | null; selectedFolder: string | null }>;
  switchSession(path: string): boolean;
  clearAttachedFiles(): boolean;
  attachFilesFromPaths(paths: string[]): Promise<GsapE2EStateSnapshot['attachedFiles']>;
  addImageAttachment(payload: { name: string; path?: string; base64Data: string; mimeType: string }): Promise<GsapE2EStateSnapshot['attachedFiles'][number]>;
  ensureSession(): Promise<boolean>;
  switchModel(modelId: string, provider?: string, sessionPath?: string | null): Promise<unknown>;
  refreshModels(): Promise<GsapE2EStateSnapshot>;
  callApi(path: string, opts?: RequestInit): Promise<unknown>;
  openSettings(tab?: string): boolean;
  getSessionMessages(sessionPath?: string | null): unknown[];
  installProjectSkill(filePath: string, dir?: string | null): Promise<{ ok?: boolean; error?: string; name?: string }>;
  clickSendButton(): boolean;
  setInputValueByTestId(testId: string, value: string): string;
  getInlineNoticeText(): string;
  setInputText?(text: string): string;
  getInputText?(): string;
}

declare global {
  interface Window {
    t: (path: string, vars?: Record<string, string | number>) => string;
    platform: PlatformApi;
    gsap: PlatformApi;
    hana: PlatformApi;
    __GSAP_DEV_WEB__?: {
      serverPort?: string;
      apiBaseUrl?: string;
    };
    __gsapMobileUpdateAvailable?: boolean;
    __gsapLog: (level: string, module: string, message: string) => void;
    setTheme: (theme: string) => void;
    applyTheme?: (theme: string) => void;
    loadSavedTheme: () => void;
    applyThemeOverrides?: (overrides?: { accent?: string; radius?: number }) => { accent?: string; radius?: number };
    resetThemeOverrides?: () => void;
    setPaperTexture: (enabled: boolean) => void;
    loadSavedPaperTexture: () => void;
    __loadDeskSkills?: () => void;
    showNotification?: (title: string, body: string, agentId?: string | null, options?: DesktopNotificationOptions) => void;
    updateBrowserViewer?: (data: { url: string; thumbnail?: string }) => void;
    __GSAP_E2E__?: GsapE2EApi;
    __GSAP_RUNTIME_DIAGNOSTICS__?: {
      getStateSnapshot(): GsapRuntimeDiagnosticsSnapshot;
    };
    i18n: {
      locale: string;
      defaultName: string;
      _data: Record<string, unknown>;
      _agentOverrides: Record<string, unknown>;
      load(locale: string): Promise<void>;
      setAgentOverrides(overrides: Record<string, unknown> | null): void;
      t(path: string, vars?: Record<string, string | number>): string;
    };
  }

  function loadSavedTheme(): void;
  function setTheme(theme: string): void;
  function setPaperTexture(enabled: boolean): void;
  function t(path: string, vars?: Record<string, string | number>): string;
}

export {};
