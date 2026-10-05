import { useStore } from '../stores';
import { sessionScopedValue } from '../stores/session-slice';
import { gsapFetch } from '../hooks/use-gsap-fetch';
import { applyAgentIdentity, loadAvatars } from '../stores/agent-actions';
import { activateWorkspaceDesk } from '../stores/desk-actions';
import { loadMessages } from '../stores/session-actions';
import { connectWebSocket, getWebSocket } from '../services/websocket';
import { configureAppEventActions } from '../services/app-event-actions';
import { configureWsMessageHandler } from '../services/ws-message-handler';
import {
  createBrowserServerConnection,
  upsertServerConnection,
  type ServerIdentity,
} from '../services/server-connection';
import { loadModels } from '../utils/ui-helpers';
import { applySyncedAppearancePreferences, type SyncedAppearancePreferences } from '../services/appearance-sync';
import { applyEditorTypography } from '../editor/typography';
import type { ThinkingLevel } from '../stores/model-slice';
import type { Agent, Session, SessionPermissionMode } from '../types';

export interface MobilePrincipal {
  kind?: string | null;
  credentialKind?: string | null;
  connectionKind?: string | null;
  trustState?: string | null;
  serverId?: string | null;
  serverNodeId?: string | null;
  userId?: string | null;
  studioId?: string | null;
  deviceId?: string | null;
  credentialId?: string | null;
  platformAccountId?: string | null;
  officialServiceKind?: string | null;
  scopes?: string[];
}

export interface MobileAuthSession {
  authenticated: boolean;
  principal: MobilePrincipal | null;
}

export interface MobileBootstrap {
  locale?: string;
  agentName?: string;
  userName?: string;
  currentAgentId?: string | null;
  agentYuan?: string;
  homeFolder?: string | null;
  cwdHistory?: string[];
  memoryMasterEnabled?: boolean;
  memoryEnabled?: boolean;
  thinkingLevel?: ThinkingLevel;
  editor?: unknown;
  avatars?: Record<string, boolean>;
  agents?: Agent[];
  appearance?: SyncedAppearancePreferences;
}

let mobileHandlersConfigured = false;

export async function readMobileAuthSession(): Promise<MobileAuthSession> {
  return rawJson<MobileAuthSession>('/api/web-auth/session');
}

export async function initializeMobileRuntime(principal: MobilePrincipal): Promise<{
  identity: ServerIdentity;
  bootstrap: MobileBootstrap;
}> {
  configureMobileMessageHandlers();

  const identity = await rawJson<ServerIdentity>('/api/server/identity');
  const connection = createBrowserServerConnection({
    identity,
    principal,
    origin: window.location.origin,
  });

  useStore.setState({
    serverConnections: upsertServerConnection(useStore.getState().serverConnections, connection),
    activeServerConnectionId: connection.connectionId,
    activeServerConnection: connection,
    serverPort: window.location.port || null,
    serverToken: null,
    currentTab: 'chat',
    sidebarOpen: false,
    jianOpen: false,
    previewOpen: false,
    currentSessionPath: null,
    pendingSessionSwitchPath: null,
    pendingNewSession: true,
    welcomeVisible: true,
  });

  const bootstrapRes = await gsapFetch('/api/mobile/bootstrap');
  const bootstrap = await bootstrapRes.json() as MobileBootstrap;
  applySyncedAppearancePreferences(bootstrap.appearance);
  applyEditorTypography(bootstrap.editor);

  if (window.i18n?.load) {
    await window.i18n.load(bootstrap.locale || 'system');
    useStore.setState({ locale: window.i18n.locale });
  }

  await applyAgentIdentity({
    agentName: bootstrap.agentName || '助手',
    agentId: bootstrap.currentAgentId || undefined,
    userName: bootstrap.userName || window.t?.('common.user') || 'User',
    yuan: bootstrap.agentYuan,
    ui: { avatars: false, agents: false, welcome: true },
  });

  const agents = Array.isArray(bootstrap.agents) ? bootstrap.agents : [];
  const currentAgent = agents.find((agent) => agent.id === bootstrap.currentAgentId)
    || agents.find((agent) => agent.isPrimary)
    || agents[0]
    || null;
  const homeFolder = bootstrap.homeFolder || currentAgent?.homeFolder || null;

  useStore.setState({
    agents,
    currentAgentId: currentAgent?.id || bootstrap.currentAgentId || useStore.getState().currentAgentId,
    agentName: currentAgent?.name || bootstrap.agentName || '助手',
    agentYuan: currentAgent?.yuan || bootstrap.agentYuan || 'gsap',
    homeFolder,
    selectedFolder: homeFolder,
    cwdHistory: Array.isArray(bootstrap.cwdHistory) ? bootstrap.cwdHistory : [],
    memoryMasterEnabled: typeof bootstrap.memoryMasterEnabled === 'boolean'
      ? bootstrap.memoryMasterEnabled
      : currentAgent?.memoryMasterEnabled !== false,
    memoryEnabled: typeof bootstrap.memoryEnabled === 'boolean'
      ? bootstrap.memoryEnabled
      : useStore.getState().memoryEnabled,
    ...(bootstrap.thinkingLevel ? { thinkingLevel: bootstrap.thinkingLevel } : {}),
  });
  loadAvatars(bootstrap.avatars);

  await Promise.all([
    loadModels(),
    loadMobileSessions({ selectFirst: false }),
    activateMobileWelcomeDesk(),
  ]);

  connectWebSocket();
  markMobileRuntimeReady(principal);
  return { identity, bootstrap };
}

export async function loadMobileSessions({
  selectFirst = false,
}: {
  selectFirst?: boolean;
} = {}): Promise<Session[]> {
  const res = await gsapFetch('/api/sessions');
  const sessions = await res.json() as Session[];
  const next = Array.isArray(sessions) ? sessions : [];
  useStore.setState({ sessions: next });

  const state = useStore.getState();
  const currentStillExists = !!state.currentSessionPath && next.some((session) => session.path === state.currentSessionPath);
  const target = currentStillExists
    ? state.currentSessionPath
    : selectFirst
      ? next[0]?.path || null
      : null;
  const targetSession = target ? next.find((session) => session.path === target) || null : null;

  if (target && target !== state.currentSessionPath) {
    await switchMobileSession(target, targetSession);
  } else if (target) {
    const latestState = useStore.getState();
    syncMobilePermissionMode(targetSession);
    await activateMobileSessionDesk(targetSession);
    if (!sessionScopedValue(latestState, latestState.chatSessions, target)) {
      await loadMessages(target);
    }
  } else {
    useStore.setState({
      currentSessionPath: null,
      pendingSessionSwitchPath: null,
      pendingNewSession: true,
      welcomeVisible: true,
    });
  }

  return next;
}

export async function switchMobileSession(path: string, session?: Pick<Session, 'cwd' | 'permissionMode'> | null): Promise<void> {
  useStore.setState({
    currentSessionPath: path,
    pendingSessionSwitchPath: path,
    pendingNewSession: false,
    welcomeVisible: false,
  });
  syncMobilePermissionMode(session || null);
  try {
    await activateMobileSessionDesk(session || null);
    await loadMessages(path);
  } finally {
    useStore.setState((state) => (
      state.pendingSessionSwitchPath === path ? { pendingSessionSwitchPath: null } : {}
    ));
  }
  requestContextUsage(path);
}

export async function createMobileSession(): Promise<string | null> {
  const state = useStore.getState();
  const body: Record<string, unknown> = {
    memoryEnabled: state.memoryEnabled,
    currentSessionPath: state.currentSessionPath,
  };
  if (state.selectedFolder) body.cwd = state.selectedFolder;
  if (state.workspaceFolders?.length) body.workspaceFolders = state.workspaceFolders;
  if (state.pendingNewSessionThinkingLevel) body.thinkingLevel = state.pendingNewSessionThinkingLevel;
  if (state.selectedAgentId && state.selectedAgentId !== state.currentAgentId) {
    body.agentId = state.selectedAgentId;
  }

  const res = await gsapFetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json() as {
    path?: string;
    cwd?: string | null;
    workspaceFolders?: string[];
    agentId?: string | null;
    agentName?: string | null;
    permissionMode?: SessionPermissionMode | null;
  };
  if (!data.path) return null;

  const patch: Record<string, unknown> = {
    currentSessionPath: data.path,
    pendingSessionSwitchPath: null,
    pendingNewSession: false,
    welcomeVisible: false,
    pendingNewSessionThinkingLevel: null,
    workspaceFolders: Array.isArray(data.workspaceFolders) ? data.workspaceFolders : [],
    selectedAgentId: null,
  };
  if (data.agentId) {
    patch.currentAgentId = data.agentId;
    if (data.agentName) patch.agentName = data.agentName;
  }
  useStore.setState(patch);
  syncMobilePermissionMode(data);
  useStore.getState().initSession(data.path, [], false);
  await activateMobileSessionDesk({ cwd: data.cwd || null });
  await loadMobileSessions();
  void loadModels();
  return data.path;
}

export async function mobileAuthJson<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  return rawJson<T>(path, options);
}

function configureMobileMessageHandlers(): void {
  if (mobileHandlersConfigured) return;
  mobileHandlersConfigured = true;
  configureAppEventActions({ requestContextUsage });
  configureWsMessageHandler({ requestContextUsage });
}

function requestContextUsage(sessionPath: string): void {
  const ws = getWebSocket();
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'context_usage', sessionPath }));
  }
}

async function activateMobileSessionDesk(session: Pick<Session, 'cwd'> | null | undefined): Promise<void> {
  await activateWorkspaceDesk(session?.cwd || null);
}

async function activateMobileWelcomeDesk(): Promise<void> {
  const state = useStore.getState();
  await activateWorkspaceDesk(state.selectedFolder || state.homeFolder || null);
  useStore.setState({ previewOpen: false });
}

function syncMobilePermissionMode(session: Pick<Session, 'permissionMode'> | null | undefined): void {
  const mode = session?.permissionMode;
  if (!isSessionPermissionMode(mode)) return;
  window.dispatchEvent(new CustomEvent('gsap-plan-mode', {
    detail: {
      enabled: mode === 'read_only',
      mode,
    },
  }));
}

function isSessionPermissionMode(value: unknown): value is SessionPermissionMode {
  return value === 'auto' || value === 'operate' || value === 'ask' || value === 'read_only';
}

function markMobileRuntimeReady(principal: MobilePrincipal): void {
  (window as Window & {
    __GSAP_MOBILE_RUNTIME_READY__?: boolean;
    __GSAP_MOBILE_PRINCIPAL__?: MobilePrincipal;
  }).__GSAP_MOBILE_RUNTIME_READY__ = true;
  (window as Window & {
    __GSAP_MOBILE_RUNTIME_READY__?: boolean;
    __GSAP_MOBILE_PRINCIPAL__?: MobilePrincipal;
  }).__GSAP_MOBILE_PRINCIPAL__ = principal;
}

async function rawJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      detail = data.detail || data.error || detail;
    } catch {}
    throw new Error(detail);
  }
  return await res.json() as T;
}
