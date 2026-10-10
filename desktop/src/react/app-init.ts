/**
 * Application bootstrap logic extracted from App.tsx.
 */

import { useStore } from './stores';
import { codiaFetch } from './hooks/use-codia-fetch';
import { applyAgentIdentity, loadAgents, loadAvatars } from './stores/agent-actions';
import { ensureSession, loadSessions, switchSession as switchSessionAction } from './stores/session-actions';
import { initSessionProjectCatalog } from './stores/session-project-actions';
import { sessionScopedValue } from './stores/session-slice';
import { selectSelectedIdsBySession } from './stores/session-selectors';
import { connectWebSocket, getWebSocket } from './services/websocket';
import { setStatus, loadModels } from './utils/ui-helpers';
import { initJian } from './stores/desk-actions';
import { initEditorEvents, initViewerEvents } from './stores/preview-actions';
import { initQuotedSelectionLifecycle } from './stores/selection-actions';
import { updateLayout } from './services/layout-state';
import { initErrorBusBridge } from './errors/error-bus-bridge';
import { refreshPluginUI } from './stores/plugin-ui-actions';
import { switchTab } from './components/channels/tab-router';
import { canRestorePluginTab, normalizeSavedTab } from './utils/saved-tab';
import { configureAppEventActions, handleAppEvent, readConfigCwdHistory, readConfigHomeFolder } from './services/app-event-actions';
import { configureWsMessageHandler } from './services/ws-message-handler';
import { persistAppearancePreferences } from './services/appearance-sync';
import {
  LOCAL_CONNECTION_ID,
  createLocalServerConnection,
  hasServerConnection,
  mergeServerIdentity,
  readPersistedServerConnectionState,
  refreshLocalServerConnection,
  upsertServerConnection,
  type ServerConnection,
} from './services/server-connection';
import { serializeChatMessageForCopy } from './utils/chat-copy';
import { writeClipboardText } from './utils/clipboard';
import { getDesktopApi } from './utils/desktop-api';
import { prepareImageAttachmentForVision } from './utils/image-attachments';
import { applyChatLayout } from './chat/layout';
import { applyEditorTypography } from './editor/typography';
import { openSettingsModal } from './stores/settings-modal-actions';
import { installI18nKeyLeakAudit } from './utils/i18n-key-leak-audit';
import { errorBus as _errorBus } from '../../../shared/error-bus.ts';
import { AppError as _AppError } from '../../../shared/errors.ts';

declare const i18n: {
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
};
declare function t(key: string, vars?: Record<string, string | number>): string;

/* eslint-disable @typescript-eslint/no-explicit-any -- platform and IPC callback signatures are dynamic. */

// Race guard: rapid agent switches can cause stale async responses.
// from earlier switches to overwrite current state. Same pattern as
// _switchVersion in session-actions.ts.
let _appReadySent = false;
let _activeSessionFocusBridgeInstalled = false;
let _lastPublishedActiveSessionPath: string | null | undefined;
let _stopI18nKeyLeakAudit: (() => void) | null = null;

function markAppReady(platform: typeof window.platform): void {
  if (_appReadySent) return;
  _appReadySent = true;
  if (window.__CODIA_E2E__) window.__CODIA_E2E__.appReady = true;
  platform.appReady();
}

function mobileRuntimeAlreadyInitialized(): boolean {
  return Boolean((window as Window & { __CODIA_MOBILE_RUNTIME_READY__?: boolean }).__CODIA_MOBILE_RUNTIME_READY__);
}

function publishActiveSessionPath(): void {
  const api = getDesktopApi();
  if (!api?.notifyMainWindow) return;
  const currentSessionPath = useStore.getState().currentSessionPath || null;
  if (currentSessionPath === _lastPublishedActiveSessionPath) return;
  _lastPublishedActiveSessionPath = currentSessionPath;
  api.notifyMainWindow?.('active-session-changed', { sessionPath: currentSessionPath });
}

function installActiveSessionFocusBridge(): void {
  if (_activeSessionFocusBridgeInstalled) return;
  _activeSessionFocusBridgeInstalled = true;
  publishActiveSessionPath();
  useStore.subscribe(() => {
    publishActiveSessionPath();
  });
}

function ensureI18nKeyLeakAudit(): void {
  if (_stopI18nKeyLeakAudit) return;
  _stopI18nKeyLeakAudit = installI18nKeyLeakAudit();
}

// Forward frontend logs to the server.
window.__codiaLog = function (level: string, module: string, message: string) {
  if (!hasServerConnection(useStore.getState())) return;
  codiaFetch('/api/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, module, message }),
  }).catch(err => console.warn('[codiaLog] log upload failed:', err));
};

//
window.addEventListener('error', (e) => {
  _errorBus.report(_AppError.wrap(e.error || e.message), {
    context: { filename: e.filename, line: e.lineno },
  });
});
window.addEventListener('unhandledrejection', (e) => {
  _errorBus.report(_AppError.wrap(e.reason));
});

//

window.__CODIA_RUNTIME_DIAGNOSTICS__ = {
  getStateSnapshot() {
    const state = useStore.getState();
    const currentSessionPath = state.currentSessionPath;
    return {
      currentSessionPath,
      pendingNewSession: state.pendingNewSession,
      modelSwitching: state.modelSwitching,
      currentSessionModel: currentSessionPath ? sessionScopedValue(state, state.sessionModelsByPath, currentSessionPath) || null : null,
    };
  },
};

async function installE2EHelpers(): Promise<void> {
  const desktopApi = getDesktopApi();
  if (!desktopApi?.isE2EMode) return;
  const enabled = await desktopApi.isE2EMode().catch(() => false);
  if (!enabled) return;

  window.__CODIA_E2E__ = {
    appReady: false,
    seedCopySession(payload) {
      const sessionPath = payload.sessionPath || '/__e2e__/copy-session';
      useStore.getState().initSession(sessionPath, payload.items as never, false);
      useStore.setState({
        currentSessionPath: sessionPath,
        pendingNewSession: false,
        welcomeVisible: false,
      });
      useStore.getState().clearSelection(sessionPath);
      return sessionPath;
    },
    selectMessages(sessionPath: string, ids: string[]) {
      useStore.getState().setMessageSelection(sessionPath, ids);
      return true;
    },
    triggerCopy(messageId: string) {
      const root = document.querySelector(`[data-message-id="${messageId}"]`);
      if (!root) throw new Error(`message not found: ${messageId}`);
      const buttons = root.querySelectorAll('button');
      const copyTitle = t('common.copyText');
      const copyButton = Array.from(buttons).find((button) => button.title === copyTitle) as HTMLButtonElement | undefined;
      if (!copyButton) throw new Error(`copy button not found for: ${messageId}`);
      copyButton.click();
      return true;
    },
    serializeMessages(sessionPath: string) {
      const state = useStore.getState();
      const session = sessionScopedValue(state, state.chatSessions, sessionPath);
      return (session?.items || [])
        .filter((item) => item.type === 'message')
        .map((item) => serializeChatMessageForCopy(item.data));
    },
    async copySelection(sessionPath: string, messageId?: string) {
      const state = useStore.getState();
      const ids = selectSelectedIdsBySession(state, sessionPath);
      const session = sessionScopedValue(state, state.chatSessions, sessionPath);
      if (!session) return false;

      const texts: string[] = [];
      for (const item of session.items) {
        if (item.type !== 'message') continue;
        if (ids.length > 0 && !ids.includes(item.data.id)) continue;
        if (ids.length === 0 && messageId && item.data.id !== messageId) continue;
        const text = serializeChatMessageForCopy(item.data);
        if (text) texts.push(text);
      }

      if (texts.length === 0) return false;
      return await writeClipboardText(texts.join('\n\n'));
    },
    async readClipboardText() {
      if (!desktopApi.readClipboardText) throw new Error('clipboard bridge unavailable');
      return await desktopApi.readClipboardText();
    },
    getStateSnapshot() {
      const state = useStore.getState();
      return {
        currentSessionPath: state.currentSessionPath,
        pendingNewSession: state.pendingNewSession,
        connected: state.connected,
        streamingSessions: state.streamingSessions,
        modelSwitching: state.modelSwitching,
        attachedFiles: state.attachedFiles,
        models: state.models,
        sessionModelsByPath: state.sessionModelsByPath,
        inlineErrors: state.inlineErrors,
        toasts: state.toasts,
        runtimeDiagnostics: state.runtimeDiagnosticIds.map(id => state.runtimeDiagnosticsById[id]).filter(Boolean),
        welcomeVisible: state.welcomeVisible,
      };
    },
    getDeskSnapshot() {
      const state = useStore.getState();
      return {
        currentSessionPath: state.currentSessionPath,
        homeFolder: state.homeFolder,
        selectedFolder: state.selectedFolder,
        deskBasePath: state.deskBasePath,
        deskCurrentPath: state.deskCurrentPath,
        deskFiles: state.deskFiles,
        deskJianContent: state.deskJianContent,
        deskSkills: state.deskSkills,
        cwdSkills: state.cwdSkills,
        cwdSkillsOpen: state.cwdSkillsOpen,
      };
    },
    getPreviewSnapshot() {
      const state = useStore.getState();
      const owner = state.currentSessionPath || 'desk';
      const preview = state.previewByOwner?.[owner] || { artifacts: [], openTabs: [], activeTabId: null };
      return {
        owner,
        previewOpen: state.previewOpen,
        activeTabId: preview.activeTabId,
        openTabs: preview.openTabs,
        artifacts: preview.artifacts.map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          type: artifact.type,
          filePath: artifact.filePath || null,
        })),
      };
    },
    setStore(partial: Record<string, unknown>) {
      useStore.setState(partial as never);
      return true;
    },
    async createSession(payload?: { cwd?: string | null; selectedFolder?: string | null }) {
      const nextFolder = payload?.cwd ?? payload?.selectedFolder ?? null;
      useStore.setState({
        welcomeVisible: true,
        currentSessionPath: null,
        selectedFolder: nextFolder,
        selectedAgentId: null,
        pendingNewSession: true,
        attachedFiles: [],
        deskContextAttached: false,
        docContextAttached: false,
      });
      const ok = await ensureSession();
      return {
        ok,
        currentSessionPath: useStore.getState().currentSessionPath,
        selectedFolder: useStore.getState().selectedFolder,
      };
    },
    switchSession(path: string) {
      void switchSessionAction(path);
      return true;
    },
    clearAttachedFiles() {
      useStore.getState().clearAttachedFiles();
      return true;
    },
    async attachFilesFromPaths(paths: string[]) {
      const readFileBase64 = desktopApi?.readFileBase64?.bind(desktopApi);
      for (const filePath of paths) {
        const name = String(filePath).replace(/\\/g, '/').split('/').pop() || String(filePath);
        const prepared = await prepareImageAttachmentForVision({
          path: filePath,
          name,
        }, readFileBase64);
        useStore.getState().addAttachedFile(prepared);
      }
      return useStore.getState().attachedFiles;
    },
    async addImageAttachment(payload: { name: string; path?: string; base64Data: string; mimeType: string }) {
      const ext = payload.name.split('.').pop() || 'png';
      const prepared = await prepareImageAttachmentForVision({
        path: payload.path || `/__e2e__/${Date.now()}.${ext}`,
        name: payload.name,
        base64Data: payload.base64Data,
        mimeType: payload.mimeType,
      });
      useStore.getState().addAttachedFile(prepared);
      return prepared;
    },
    async ensureSession() {
      return await ensureSession();
    },
    async switchModel(modelId: string, provider?: string, sessionPath?: string | null) {
      const targetPath = sessionPath || useStore.getState().currentSessionPath;
      const response = await codiaFetch('/api/models/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionPath: targetPath, modelId, provider }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'model switch failed');
      if (targetPath && data.model) {
        useStore.getState().updateSessionModel(targetPath, data.model);
      }
      await loadModels({ sessionPath: targetPath });
      return data;
    },
    async refreshModels() {
      await loadModels();
      return this.getStateSnapshot();
    },
    async callApi(path: string, opts?: RequestInit) {
      const response = await codiaFetch(path, opts || {});
      const text = await response.text();
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return text;
      }
    },
    openSettings(tab?: string) {
      openSettingsModal(tab);
      return true;
    },
    getSessionMessages(sessionPath?: string | null) {
      const targetPath = sessionPath || useStore.getState().currentSessionPath;
      const state = useStore.getState();
      const session = targetPath ? sessionScopedValue(state, state.chatSessions, targetPath) : null;
      return session?.items || [];
    },
    async installProjectSkill(filePath: string, dir?: string | null) {
      const targetDir = dir || useStore.getState().deskBasePath || '';
      const response = await codiaFetch('/api/desk/install-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath, dir: targetDir }),
      });
      const data = await response.json();
      if (response.ok && targetDir) {
        const refreshRes = await codiaFetch(`/api/desk/skills?dir=${encodeURIComponent(targetDir)}`);
        const refreshData = await refreshRes.json();
        useStore.getState().setCwdSkills(refreshData.skills || []);
        window.__loadDeskSkills?.();
      }
      return data;
    },
    clickSendButton() {
      const button = document.querySelector('button[class*="send-btn"]') as HTMLButtonElement | null;
      if (!button) throw new Error('send button not found');
      button.click();
      return true;
    },
    setInputValueByTestId(testId: string, value: string) {
      const input = document.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLSelectElement | null;
      if (!input) throw new Error(`input not found: ${testId}`);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    },
    getInlineNoticeText() {
      const node = document.querySelector('[class*="slash-busy-bar"], [class*="slash-error-bar"], .codia-toast');
      const text = node?.textContent || '';
      if (text) return text;
      return useStore.getState().toasts.map((toast) => toast.text).join('\n');
    },
  };
}

export async function initApp(): Promise<void> {
  const platform = window.platform;
  const mobileRuntimeReady = mobileRuntimeAlreadyInitialized();
  await installE2EHelpers();

  const requestContextUsage = (sessionPath: string) => {
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'context_usage', sessionPath }));
    }
  };
  configureAppEventActions({ requestContextUsage });
  configureWsMessageHandler({ requestContextUsage });
  installActiveSessionFocusBridge();
  initQuotedSelectionLifecycle();

  // 1. 初始化 server 连接并绑定到 Zustand
  const serverPort = await platform.getServerPort();
  const serverToken = await platform.getServerToken();
  const localServerConnection = createLocalServerConnection({ serverPort, serverToken });
  const persistedConnections = readPersistedServerConnectionState();
  const initialRegistry = localServerConnection
    ? upsertServerConnection(persistedConnections.serverConnections, localServerConnection)
    : persistedConnections.serverConnections;
  const requestedActiveConnection = persistedConnections.activeServerConnectionId
    ? initialRegistry[persistedConnections.activeServerConnectionId]
    : null;
  const activeServerConnection = requestedActiveConnection || localServerConnection;
  useStore.setState({
    serverPort,
    serverToken,
    serverConnections: initialRegistry,
    activeServerConnectionId: activeServerConnection?.connectionId ?? null,
    activeServerConnection,
  });

  if (!activeServerConnection) {
    setStatus('status.serverNotReady', false);
    markAppReady(platform);
    return;
  }

  try {
    await refreshDeviceWebSession(activeServerConnection);
    const mergedConnection = await loadIdentityForActiveConnection(activeServerConnection);
    useStore.setState({
      serverConnections: upsertServerConnection(useStore.getState().serverConnections, mergedConnection),
      activeServerConnectionId: mergedConnection.connectionId,
      activeServerConnection: mergedConnection,
    });
  } catch (err) {
    if (activeServerConnection.connectionId !== LOCAL_CONNECTION_ID && localServerConnection) {
      console.warn('[init] remote server identity failed, returning to local server:', err);
      useStore.setState({
        activeServerConnectionId: localServerConnection.connectionId,
        activeServerConnection: localServerConnection,
      });
      try {
        await refreshDeviceWebSession(localServerConnection);
        const mergedConnection = await loadIdentityForActiveConnection(localServerConnection);
        useStore.setState({
          serverConnections: upsertServerConnection(useStore.getState().serverConnections, mergedConnection),
          activeServerConnectionId: mergedConnection.connectionId,
          activeServerConnection: mergedConnection,
        });
      } catch (localErr) {
        console.error('[init] server identity failed:', localErr);
        setStatus('status.serverNotReady', false);
        markAppReady(platform);
        return;
      }
    } else {
      console.error('[init] server identity failed:', err);
      setStatus('status.serverNotReady', false);
      markAppReady(platform);
      return;
    }
  }

  persistAppearancePreferences().catch(() => {});

  if (!mobileRuntimeReady) {
    // 2. 楠炴儼顢戦懢宄板絿 health + config
    try {
      const [healthRes, configRes] = await Promise.all([
        codiaFetch('/api/health'),
        codiaFetch('/api/config'),
      ]);
      const healthData = await healthRes.json();
      const configData = await configRes.json();
      applyEditorTypography(configData.editor);
      applyChatLayout(configData.chat);

      //
      await i18n.load(configData.locale || 'system');
      useStore.setState({ locale: i18n.locale });
      ensureI18nKeyLeakAudit();

      await applyAgentIdentity({
        agentName: healthData.agent || '助手',
        userName: healthData.user || t('common.user'),
        ui: { avatars: false, agents: false, welcome: true },
      });

      // Initialize Desk state from config.
      const homeFolder = readConfigHomeFolder(configData);
      useStore.setState({
        homeFolder,
        selectedFolder: homeFolder,
        workspaceFolders: [],
        cwdHistory: readConfigCwdHistory(configData),
      });

 // 6. 加载头像
      loadAvatars(healthData.avatars);
    } catch (err) {
      console.error('[init] i18n/health/config failed:', err);
    }
  }

  // Show the main window after the essential identity/i18n pass. Slower
  // secondary data continues loading below without holding the splash screen.
  markAppReady(platform);

  //
  if (!mobileRuntimeReady || !getWebSocket()) connectWebSocket();
  initErrorBusBridge();
  platform.onServerRestarted?.((data: { port: number; token?: string }) => {
    const store = useStore.getState();
    const serverToken = data.token || store.serverToken;
    const activeServerConnection = refreshLocalServerConnection({
      existingConnection: store.serverConnections?.[LOCAL_CONNECTION_ID] ?? store.activeServerConnection,
      serverPort: data.port,
      serverToken,
    });
    useStore.setState({
      serverPort: String(data.port),
      serverToken,
      ...(activeServerConnection
        ? {
            serverConnections: upsertServerConnection(store.serverConnections, activeServerConnection),
            activeServerConnectionId: activeServerConnection.connectionId,
            activeServerConnection,
          }
        : {
            activeServerConnectionId: null,
            activeServerConnection: null,
          }),
    });
    connectWebSocket();
    loadModels().catch(() => {});
  });

 // 9. 加载主界面
  if (!mobileRuntimeReady) {
    await loadModels();

    //
    useStore.setState({ pendingNewSession: true });
    await loadAgents();
    await loadSessions();
    await initSessionProjectCatalog();
  }

  // Initialize journal.
  initJian();

  //
  initEditorEvents();
  initViewerEvents();

 // 13b. 初始化 layout 观测
  updateLayout();

  // Initialize automation badge count.
  try {
    const res = await codiaFetch('/api/desk/cron');
    const data = await res.json();
    const count = (data.jobs || []).length;
    useStore.setState({ automationCount: count });
  } catch { /* ignore */ }

  // Load bridge status once at startup for the sidebar indicator.
  try {
    const res = await codiaFetch('/api/bridge/status');
    const data = await res.json();
    const anyConnected = data.telegram?.status === 'connected'
      || data.feishu?.status === 'connected'
      || data.qq?.status === 'connected'
      || data.wechat?.status === 'connected'
      || data.whatsapp?.status === 'connected';
    useStore.setState({ bridgeDotConnected: anyConnected });
  } catch { /* ignore */ }

  // Restore the saved primary page independently from the removed titlebar menu.
  // Plugin pages wait for discovery and yield to any navigation the user performs
  // while discovery is in flight. Knowledge graph and mind map now live in chat.
  const rawSavedTab = localStorage.getItem('codia-tab');
  const savedTab = normalizeSavedTab(rawSavedTab);
  if (rawSavedTab !== savedTab) localStorage.setItem('codia-tab', savedTab);
  if (!savedTab.startsWith('plugin:')) switchTab(savedTab);

  void refreshPluginUI().then(() => {
    if (!savedTab.startsWith('plugin:')) return;
    if (localStorage.getItem('codia-tab') !== savedTab) return;
    if (canRestorePluginTab(savedTab, useStore.getState().pluginPages)) {
      switchTab(savedTab);
      return;
    }
    localStorage.setItem('codia-tab', 'chat');
    switchTab('chat');
  });

  // Register settings shortcut.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',') {
      e.preventDefault();
      openSettingsModal();
    }
  });

  // 19. 监听设置变更事件
  platform.onSettingsChanged((type: string, data: unknown) => {
    handleAppEvent(type, data);
  });

  platform.onOpenSettingsModal?.((tab?: string) => {
    openSettingsModal(tab);
  });

  platform.onQuickChatOpenSession?.((payload: { sessionPath?: string }) => {
    if (!payload?.sessionPath) return;
    void switchSessionAction(payload.sessionPath);
    void loadSessions();
  });

  // Wire Skill Viewer overlay events from desktop windows.
  getDesktopApi()?.onShowSkillViewer?.((data: any) => {
    useStore.setState({ skillViewerData: data });
  });

  //
  markAppReady(platform);
}

async function loadIdentityForActiveConnection(connection: ServerConnection): Promise<ServerConnection> {
  const identityRes = await codiaFetch('/api/server/identity');
  const identityData = await identityRes.json();
  return mergeServerIdentity(connection, identityData);
}

async function refreshDeviceWebSession(connection: ServerConnection): Promise<void> {
  if (connection.credentialKind !== 'device_credential' || !connection.token) return;
  await codiaFetch('/api/web-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ credential: connection.token }),
  });
}
