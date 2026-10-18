// ── Auto-update ──

export interface AutoUpdateState {
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'latest';
  version: string | null;
  releaseNotes: string | null;
  releaseUrl: string | null;
  downloadUrl: string | null;
  progress: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  } | null;
  error: string | null;
}

export interface AutoLaunchStatus {
  supported: boolean;
  openAtLogin: boolean;
  openedAtLogin: boolean;
  status: string | null;
  executableWillLaunchAtLogin?: boolean | null;
}

export interface KeepAwakeStatus {
  enabled: boolean;
  active: boolean;
  blockerId: number | null;
  type: 'prevent-app-suspension';
}

export type DesktopNotificationFocusPolicy = 'always' | 'when_unfocused' | 'when_session_unfocused';

export interface DesktopNotificationOptions {
  desktopFocusPolicy?: DesktopNotificationFocusPolicy;
  sessionPath?: string | null;
}

// ── 核心数据结构 ──

export interface Session {
  path: string;
  id?: string | null;
  sessionId?: string | null;
  title: string | null;
  firstMessage: string;
  modified: string;
  messageCount: number;
  agentId: string | null;
  agentName: string | null;
  agentDeleted?: boolean;
  readOnlyReason?: string | null;
  continuationAvailable?: boolean;
  deletedAt?: string | null;
  cwd: string | null;
  projectId?: string | null;
  permissionMode?: 'auto' | 'operate' | 'ask' | 'read_only' | null;
  pinnedAt?: string | null;
  hasSummary?: boolean;
  rcAttachment?: {
    sessionKey: string;
    platform: string;
    title?: string | null;
  } | null;
  _optimistic?: boolean;
}

export type SessionPermissionMode = NonNullable<Session['permissionMode']>;

export interface SessionCapabilityDrift {
  version: number;
  fingerprint: string;
  frozenFingerprint: string;
  addedToolNames: string[];
  removedToolNames: string[];
  invalidToolNames: string[];
  promptChanged: boolean;
  hasDrift: boolean;
}

export interface Agent {
  id: string;
  name: string;
  yuan: string;
  isPrimary: boolean;
  hasAvatar?: boolean;
  chatModel?: { id: string; provider?: string | null } | null;
  homeFolder?: string | null;
  memoryMasterEnabled?: boolean;
}

export interface SessionStream {
  streamId: string | null;
  lastSeq: number;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  isCurrent?: boolean;
  contextWindow?: number | null;
  reasoning?: boolean;
  xhigh?: boolean;
  thinkingLevels?: ('off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  defaultThinkingLevel?: 'off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  input?: ('text' | 'image' | 'video' | 'audio')[];
  video?: boolean;
  compat?: ({
    codiaVideoInput?: boolean;
  } & Record<string, unknown>) | null;
  vision?: boolean;
}

export type ChannelMemberRole = 'project_manager' | 'admin' | 'worker';

export interface Channel {
  id: string;
  name: string;
  description?: string;
  members: string[];
  memberRoles?: Record<string, ChannelMemberRole>;
  roleCounts?: Record<ChannelMemberRole, number>;
  lastMessage: string;
  lastSender: string;
  lastTimestamp: string;
  newMessageCount: number;
  messageCount?: number;
  isDM?: boolean;
  dmOwnerId?: string;
  peerId?: string;
  peerName?: string;
}

export interface ChannelMessage {
  sender: string;
  timestamp: string;
  body: string;
  blocks?: import('./stores/chat-types').ContentBlock[];
  resources?: import('./stores/chat-types').ResourceEnvelope[];
}

export interface AgentPhoneActivity {
  conversationId: string;
  conversationType: 'channel' | 'dm';
  agentId: string;
  state: 'idle' | 'viewed' | 'triaging' | 'no_reply' | 'replying' | 'using_tool' | 'waiting_permission' | 'compacting' | 'error' | string;
  summary: string;
  timestamp: string;
  details?: Record<string, unknown> | null;
}

export type ChannelAgentActivities = Record<string, Record<string, AgentPhoneActivity[]>>;

export interface ChannelTickerStatus {
  active?: {
    channelName?: string;
    agentId?: string;
    activeAgentId?: string;
    delivered?: number;
    agentCount?: number;
    checks?: number;
    maxChecks?: number;
    mode?: string;
  } | null;
  nextReminder?: {
    channelName?: string;
    dueAt?: string;
    dueAtMs?: number;
    intervalMs?: number;
  } | null;
  running?: boolean;
  queued?: boolean;
}

export type ChannelTickerStatusMap = Record<string, ChannelTickerStatus | null>;
export type AgentPhoneToolMode = 'read_only' | 'write';

export interface AgentPhoneSettings {
  mode: AgentPhoneToolMode;
  replyMinChars: number | null;
  replyMaxChars: number | null;
  proactiveEnabled: boolean;
  reminderIntervalMinutes: number;
  guardLimit: number;
  modelOverrideEnabled: boolean;
  modelOverrideModel: { id: string; provider: string } | null;
}

export interface Activity {
  id: string;
  type: string;
  title: string;
  timestamp: string;
  agentId?: string;
  agentName?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface Artifact {
  id: string;
  type: string;
  title: string;
  content: string;
  sourceUrl?: string;
  language?: string | null;
  fileId?: string;
  filePath?: string;
  sourceRootPath?: string;
  ext?: string;
  mime?: string;
  kind?: string;
  storageKind?: string;
  fileVersion?: FileVersion | null;
  status?: 'available' | 'missing' | 'expired' | string;
  missingAt?: number | null;
  remoteContentRef?: RemoteContentRef | null;
}

export interface DeskFile {
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
}

export interface StudioWorkspace {
  workspaceId: string;
  mountId: string;
  label: string;
  sourceKind: string | null;
  provider: string | null;
  presentation: string | null;
  capabilities: string[];
  isDefault: boolean;
  nativeRootPath?: string | null;
}

export interface WorkspaceChangePayload {
  rootPath: string;
  changedPath: string;
  affectedDir: string;
  eventType: string;
}

export interface DeskSearchResult {
  name: string;
  relativePath: string;
  parentSubdir: string;
  isDir: boolean;
  size?: number | null;
  mtime?: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
  id?: string;
  parentId?: string | null;
}

// ── 浮动面板类型 ──
export type ActivePanel = 'task-console' | 'activity' | 'automation' | 'skills' | 'bridge' | 'social' | null;
export type IdeActivityPanel =
  | 'explorer'
  | 'search'
  | 'source-control'
  | 'run-debug'
  | 'extensions'
  | 'accounts'
  | 'settings';
export type TabType = 'chat' | 'channels' | 'workflow' | `plugin:${string}`;
export type RightWorkspaceTab = 'session-files' | 'session-library' | 'workspace' | `plugin-widget:${string}`;

export interface FileVersion {
  mtimeMs: number;
  size: number;
  sha256?: string;
}

export interface TextFileSnapshot {
  content: string;
  version: FileVersion;
}

export interface VersionedWriteResult {
  ok: boolean;
  conflict?: boolean;
  version?: FileVersion | null;
}

export interface RemoteWorkbenchContentRef {
  kind: 'workbench-file' | 'mobile-workbench';
  mountId?: string;
  rootId?: string;
  subdir: string;
  name: string;
  contentPath: string;
  version?: FileVersion | null;
}

export type RemoteContentRef = RemoteWorkbenchContentRef;

export interface DesignDocumentPreview {
  kind: string;
  format: string;
  title?: string;
  fileName?: string;
  filePath?: string;
  ext?: string;
  fileSize?: number;
  canRenderNatively: boolean;
  summary?: string;
  sections?: Array<{
    title: string;
    items: string[];
  }>;
  warnings?: string[];
}

// ── Plugin Card Protocol ──
export type { PluginCardDetails, PluginCardSessionRef } from './types/plugin-card';

// ── 插件 UI 信息 ──

export interface PluginPageInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
  hostCapabilities: string[];
}

export interface PluginWidgetInfo {
  pluginId: string;
  title: string | Record<string, string>;
  icon: string | null;
  routeUrl: string;
  hostCapabilities: string[];
}

export interface PluginUiHostCapabilityGrant {
  pluginId: string;
  hostCapabilities: string[];
}

export interface VsCodeFileIconThemeInfo {
  pluginId: string;
  themeId: string;
  label: string;
  defaultFile?: string | null;
  defaultFolder?: string | null;
  defaultFolderExpanded?: string | null;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  rootFolderNames: Record<string, string>;
  rootFolderNamesExpanded: Record<string, string>;
}

// ── Platform API 类型声明 ──
export interface PlatformFileActionResult {
  success: boolean;
  code?: string;
  message?: string;
  path?: string;
  parentPath?: string;
}

export interface PlatformApi {
  getServerPort(): Promise<string>;
  getServerToken(): Promise<string>;
  runConsoleCommand?(payload: { kind: 'powershell' | 'codiactl'; command: string; cwd?: string }): Promise<{ ok: boolean; code: number; output: string }>;
  runEditCommand?(command: 'cut' | 'copy' | 'paste' | 'selectAll'): Promise<boolean>;
  restartServer?(): Promise<{ ok?: boolean; port?: number; token?: string; error?: string }>;
  isE2EMode?(): Promise<boolean>;
  readClipboardText?(): Promise<string>;
  writeClipboardText?(text: string): Promise<boolean>;
  getGpuRuntimeState?(): Promise<{ gpuSafeMode: boolean; hardwareAccelerationEnabled: boolean }>;
  getRuntimeDiagnosticsState?(): Promise<{
    currentSessionPath: string | null;
    pendingNewSession: boolean;
    modelSwitching: boolean;
    currentSessionModel: {
      id: string;
      name: string;
      provider: string;
        input?: ('text' | 'image' | 'video' | 'audio')[];
        video?: boolean;
        compat?: ({
          codiaVideoInput?: boolean;
        } & Record<string, unknown>) | null;
      vision?: boolean;
      reasoning?: boolean;
    } | null;
  } | null>;
  openSettings(tab?: string): void;
  openBrowserViewer(url?: string, theme?: string): void;
  selectFolder(): Promise<string | null>;
  selectFiles(): Promise<string[]>;
  selectSkill(): Promise<string | null>;
  selectPlugin?(): Promise<string | null>;
  readFile(path: string): Promise<string | null>;
  writeFile(filePath: string, content: string): Promise<boolean>;
  readFileSnapshot?(path: string): Promise<TextFileSnapshot | null>;
  writeFileIfUnchanged?(filePath: string, content: string, expectedVersion?: FileVersion | null): Promise<VersionedWriteResult>;
  writeFileBinary?(filePath: string, base64Data: string): Promise<boolean>;
  copyFile?(sourcePath: string, destinationPath: string): Promise<boolean>;
  saveFileAs?(filePath: string, defaultName?: string): Promise<{ success?: boolean; canceled?: boolean; path?: string; error?: string } | undefined>;
  screenshotRender?(payload: unknown): Promise<unknown>;
  saveScreenshotPreview?(payload: { theme: string }): Promise<{ success?: boolean; canceled?: boolean; error?: string } | undefined>;
  watchFile(filePath: string): Promise<boolean>;
  unwatchFile(filePath: string): Promise<boolean>;
  onFileChanged(callback: (filePath: string) => void): void;
  watchWorkspace?(rootPath: string): Promise<boolean>;
  unwatchWorkspace?(rootPath: string): Promise<boolean>;
  onWorkspaceChanged?(callback: (payload: WorkspaceChangePayload) => void): void;
  readFileBase64(path: string): Promise<string | null>;
  getFileUrl?(path: string): string;
  readDocxHtml(path: string): Promise<string | null>;
  readXlsxHtml(path: string): Promise<string | null>;
  readDesignDocumentPreview?(path: string): Promise<DesignDocumentPreview | null>;
  openEditorWindow(data: { filePath: string; title: string; type: string; language?: string | null }): void;
  onEditorDockFile?(callback: (data: { filePath: string; title: string; type: string; language?: string | null }) => void): void;
  onEditorDetached?(callback: (detached: boolean) => void): void;
  spawnViewer?(data: { filePath: string; title: string; type: string; language?: string | null }): Promise<number | null>;
  onViewerLoad?(callback: (data: { filePath: string; title: string; type: string; language?: string | null; windowId: number }) => void): void;
  viewerClose?(): void;
  onViewerClosed?(callback: (windowId: number) => void): void;
  openFolder(path: string): Promise<PlatformFileActionResult>;
  openFile(path: string): Promise<PlatformFileActionResult>;
  openExternal(url: string): void;
  showInFinder(path: string): Promise<PlatformFileActionResult>;
  trashItem?(path: string): Promise<boolean>;
  browserEmergencyStop?(): void;
  openSkillViewer?(opts: { skillPath?: string; name?: string; displayName?: string; baseDir?: string; filePath?: string; installed?: boolean }): void;
  settingsChanged(event: string, payload?: unknown): void;
  onSettingsChanged(callback: (event: string, payload: unknown) => void): void;
  onOpenSettingsModal?(callback: (tab?: string) => void): void;
  onSwitchTab?(callback: (tab: string) => void): void;
  onServerRestarted?(callback: (data: { port: number; token?: string }) => void): void;
  getFilePath?(file: File): string | null;
  startDrag?(filePaths: string | string[]): void;
  appReady(): void;

  // ── Window controls (Windows/Linux) ──
  getPlatform?(): Promise<string>;
  windowMinimize?(): void;
  windowMaximize?(): void;
  windowClose?(): void;
  windowIsMaximized?(): Promise<boolean>;
  onMaximizeChange?(callback: (maximized: boolean) => void): void;

  // ── Browser viewer ──
  updateBrowserViewer?(data: { running?: boolean; url?: string | null; thumbnail?: string | null }): void;
  onBrowserUpdate?(callback: (data: {
    title?: string;
    url?: string;
    canGoBack?: boolean;
    canGoForward?: boolean;
    running?: boolean;
    activeTabId?: string | null;
    tabs?: Array<{
      tabId: string;
      title?: string;
      url?: string | null;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }>;
  }) => void): void;
  closeBrowserViewer?(): void;
  closeBrowser?(): void;
  browserGoBack?(): void;
  browserGoForward?(): void;
  browserReload?(): void;
  browserNavigateTo?(url: string): Promise<unknown> | void;
  browserNewTab?(): Promise<unknown> | void;
  browserSwitchTab?(tabId: string): Promise<unknown> | void;
  browserCloseTab?(tabId: string): Promise<unknown> | void;
  // ── Skill viewer (preload) ──
  listSkillFiles?(baseDir: string): Promise<unknown[]>;
  readSkillFile?(filePath: string): Promise<string | null>;

  // ── Splash / Onboarding ──
  getAvatarPath?(role: string): Promise<string | null>;
  getSplashInfo?(): Promise<{ agentName?: string; locale?: string; yuan?: string } | null>;
  reloadMainWindow?(): Promise<unknown> | void;
  onboardingComplete?(): Promise<void>;

  // ── Notification ──
  showNotification?(title: string, body: string, agentId?: string | null, options?: DesktopNotificationOptions): void;

  // ── App info ──
  getAppVersion?(): Promise<string>;
  getAutoLaunchStatus?(): Promise<AutoLaunchStatus>;
  setAutoLaunchEnabled?(enabled: boolean): Promise<AutoLaunchStatus>;
  getKeepAwakeStatus?(): Promise<KeepAwakeStatus>;
  setKeepAwakeEnabled?(enabled: boolean): Promise<KeepAwakeStatus>;
  quickChatReloadShortcut?(): Promise<{ ok: boolean; shortcut: string; error?: string }>;
  quickChatShortcutStatus?(): Promise<{ shortcut: string; registered: boolean }>;
  quickChatShow?(): Promise<boolean> | void;
  quickChatHide?(): Promise<boolean> | void;
  quickChatResize?(request: 'compact' | 'chat' | { mode: 'compact' | 'chat'; height?: number }): Promise<boolean> | void;
  quickChatOpenSession?(sessionPath: string): Promise<boolean> | void;
  onQuickChatOpenSession?(callback: (payload: { sessionPath?: string }) => void): (() => void) | void;
  onQuickChatShown?(callback: () => void): (() => void) | void;
  checkUpdate?(): Promise<{ version: string; downloadUrl: string } | null>;

  // ── Auto-update (Windows) ──
  autoUpdateCheck?(): Promise<string | null>;
  autoUpdateDownload?(): Promise<boolean>;
  autoUpdateInstall?(): Promise<boolean>;
  autoUpdateState?(): Promise<AutoUpdateState>;
  autoUpdateSetChannel?(channel: 'stable' | 'beta'): Promise<void>;
  onAutoUpdateState?(callback: (state: AutoUpdateState) => void): (() => void) | void;

  // ── Skill viewer overlay ──
  onShowSkillViewer?(callback: (data: unknown) => void): void;

  // ── Inter-window communication ──
  notifyMainWindow?(event: string, payload?: unknown): void;

  [key: string]: unknown;
}
