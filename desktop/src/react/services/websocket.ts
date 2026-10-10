/**
 * WebSocket connection lifecycle manager.
 */
import { handleServerMessage, applyStreamingStatus } from './ws-message-handler';
import { configureActiveWebSocketResolver } from './websocket-state';
import { requestStreamResume, injectHandlers, injectWebSocketGetter } from './stream-resume';
import { useStore } from '../stores';
import { setStatus } from '../utils/ui-helpers';
import { readPwaAccessToken } from '../pwa-runtime';
import {
  buildConnectionWsUrl,
  createLocalServerConnection,
  resolveServerConnection,
} from './server-connection';
import {
  bindResourceEventForegroundCatchUp,
  catchUpResourceEventsAfterReconnect,
  recordResourceEventCursor,
} from './resource-events';
import { AppError } from '../../../../shared/errors.ts';
import { errorBus } from '../../../../shared/error-bus.ts';

let _ws: WebSocket | null = null;
let _wsRetryDelay = 1000;
const WS_RETRY_MAX = 30000;
let _wsRetryTimer: ReturnType<typeof setTimeout> | null = null;
let _wsResumeVersion = 0;
const WS_MAX_RETRIES = 20;
let _wsRetryCount = 0;
let _resourceForegroundCatchUpCleanup: (() => void) | null = null;

type PwaBridge = { wsUrl?: (token?: string | null) => string };

function pwaBridge(): PwaBridge | undefined {
  return typeof window !== 'undefined'
    ? (window as Window & { __CODIA_PWA__?: PwaBridge }).__CODIA_PWA__
    : undefined;
}

function isPwaRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as Window & { __CODIA_PWA__?: unknown }).__CODIA_PWA__);
}

function buildPwaWebSocketUrl(token?: string | null): string | null {
  const bridge = pwaBridge();
  if (!bridge && !isPwaRuntime()) return null;
  if (bridge?.wsUrl) return bridge.wsUrl(token ?? null);
  if (typeof window !== 'undefined' && /^https?:$/.test(window.location.protocol)) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    return `${protocol}//${window.location.host}/__codia_backend__/ws${tokenParam}`;
  }
  return null;
}

injectHandlers(handleServerMessage, applyStreamingStatus);
injectWebSocketGetter(getWebSocket);

export function resolveStreamingSessionResumeTargets(state: {
  streamingSessions?: string[];
  sessionLocatorsById?: Record<string, { path?: string | null }>;
}): string[] {
  const locators = state.sessionLocatorsById || {};
  const targets = new Set<string>();
  for (const key of state.streamingSessions || []) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(locators, key)) {
      const path = locators[key]?.path;
      if (typeof path === 'string' && path.trim()) targets.add(path);
      continue;
    }
    targets.add(key);
  }
  return Array.from(targets);
}

export function getWebSocket(): WebSocket | null {
  return _ws;
}

configureActiveWebSocketResolver(getWebSocket);

export function connectWebSocket(port?: string, token?: string): void {
  const storeState = useStore.getState();
  const pwaToken = token || storeState.serverToken || readPwaAccessToken();
  const pwaUrl = buildPwaWebSocketUrl(pwaToken);
  const connection = pwaUrl
    ? null
    : port !== undefined || token !== undefined
      ? createLocalServerConnection({
          serverPort: port || storeState.serverPort,
          serverToken: token ?? storeState.serverToken,
        })
      : resolveServerConnection(storeState);

  const url = pwaUrl || (connection ? buildConnectionWsUrl(connection, '/ws') : null);
  if (!url) return;
  ensureResourceForegroundCatchUp();

  if (_wsRetryTimer) {
    clearTimeout(_wsRetryTimer);
    _wsRetryTimer = null;
  }
  if (_ws) {
    try {
      _ws.onclose = null;
      _ws.close();
    } catch {
      // silent
    }
  }

  _ws = new WebSocket(url);

  _ws.onopen = () => {
    _wsRetryDelay = 1000;
    _wsRetryCount = 0;
    setStatus('status.connected', true);
    useStore.setState({ wsState: 'connected', wsReconnectAttempt: 0, compactingSessions: [] });

    const s = useStore.getState();
    const streamingPaths = resolveStreamingSessionResumeTargets(s);
    if (streamingPaths.length > 0) {
      const myVersion = ++_wsResumeVersion;
      Promise.resolve().then(async () => {
        if (myVersion !== _wsResumeVersion) return;
        for (const targetPath of streamingPaths) {
          requestStreamResume(targetPath);
        }
      }).catch((err) => {
        console.error('[ws] reconnect resume failed:', err);
      });
    }

    if (s.currentSessionPath && _ws?.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({
        type: 'context_usage',
        sessionPath: s.currentSessionPath,
        ...((s as { currentSessionId?: string | null }).currentSessionId
          ? { sessionId: (s as { currentSessionId?: string }).currentSessionId }
        : {}),
      }));
    }

    void catchUpResourceEventsAfterReconnect(handleServerMessage).catch((err) => {
      console.warn('[ws] resource event catch-up failed:', err);
    });
  };

  _ws.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      recordResourceEventCursor(msg);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[ws] message parse error:', err);
    }
  };

  _ws.onclose = () => {
    setStatus('status.disconnected', false);
    _wsRetryCount++;

    if (_wsRetryCount <= WS_MAX_RETRIES) {
      useStore.setState({ wsState: 'reconnecting', wsReconnectAttempt: _wsRetryCount });
      _wsRetryTimer = setTimeout(() => connectWebSocket(), _wsRetryDelay);
      _wsRetryDelay = Math.min(_wsRetryDelay * 2, WS_RETRY_MAX);
    } else {
      useStore.setState({ wsState: 'disconnected' });
    }
  };

  _ws.onerror = () => {
    errorBus.report(new AppError('WS_DISCONNECTED'));
  };
}

export function manualReconnect(): void {
  _wsRetryCount = 0;
  connectWebSocket();
}

function ensureResourceForegroundCatchUp(): void {
  if (_resourceForegroundCatchUpCleanup) return;
  _resourceForegroundCatchUpCleanup = bindResourceEventForegroundCatchUp(handleServerMessage);
}
