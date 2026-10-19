/**
 * Settings window API utilities.
 */
import { useSettingsStore } from './store';
import { appendPwaAccessTokenQuery, readPwaAccessToken } from '../pwa-runtime';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  requireServerConnection,
} from '../services/server-connection';
export { yuanFallbackAvatar } from '../utils/yuan-avatar';

const DEFAULT_TIMEOUT = 30_000;
const ERROR_BODY_LIMIT = 500;
type PwaBridge = { serverUrl?: (path: string) => string };
type CodiaUrlOptions = { includeTokenQuery?: boolean };

function pwaBridge(): PwaBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as typeof window & { __CODIA_PWA__?: PwaBridge }).__CODIA_PWA__;
}

export class CodiaFetchError extends Error {
  constructor(message: string, public readonly status: number, public readonly payload: Record<string, unknown> | null) {
    super(message);
    this.name = 'CodiaFetchError';
  }
}

async function buildFetchError(path: string, res: Response): Promise<Error> {
  let payload: Record<string, unknown> | null = null;
  let detail = res.statusText || 'Request failed';
  try {
    const text = await res.text();
    if (text) {
      const trimmed = text.trim();
      try {
        const parsed: unknown = JSON.parse(trimmed);
        payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        const message = payload?.error || payload?.message;
        detail = typeof message === 'string' && message.trim()
          ? message.trim()
          : trimmed.slice(0, ERROR_BODY_LIMIT);
      } catch {
        detail = trimmed.slice(0, ERROR_BODY_LIMIT);
      }
    }
  } catch {
    // Keep the status text if the response body cannot be read.
  }
  return new CodiaFetchError(`codiaFetch ${path}: ${res.status} ${detail}`, res.status, payload);
}

export function codiaUrl(path: string, opts: CodiaUrlOptions = {}): string {
  const pwa = pwaBridge();
  if (pwa?.serverUrl) {
    const url = pwa.serverUrl(path);
    return opts.includeTokenQuery ? appendPwaAccessTokenQuery(url) : url;
  }

  const connection = requireServerConnection(
    useSettingsStore.getState(),
    `codiaUrl ${path}: server connection not ready`,
  );
  return buildConnectionUrl(connection, path, { includeTokenQuery: opts.includeTokenQuery === true });
}

export async function codiaFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const storeState = useSettingsStore.getState();
  const pwa = pwaBridge();
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string>) };
  let url: string;

  if (pwa?.serverUrl) {
    url = pwa.serverUrl(path);
    const authToken = storeState.serverToken || readPwaAccessToken();
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
  } else {
    const connection = requireServerConnection(
      storeState,
      `codiaFetch ${path}: server connection not ready`,
    );
    url = buildConnectionUrl(connection, path);
    Object.assign(headers, appendConnectionAuth(connection, headers));
    if (!headers.Authorization && connection.kind === 'local') {
      const pwaToken = readPwaAccessToken();
      if (pwaToken) headers.Authorization = `Bearer ${pwaToken}`;
    }
  }

  const { timeout = DEFAULT_TIMEOUT, signal: callerSignal, ...fetchOpts } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, {
      ...fetchOpts,
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      throw await buildFetchError(path, res);
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}
