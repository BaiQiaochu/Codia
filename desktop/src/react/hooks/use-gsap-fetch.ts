import { useStore } from '../stores';
import { appendPwaAccessTokenQuery, readPwaAccessToken } from '../pwa-runtime';
import {
  appendConnectionAuth,
  buildConnectionUrl,
  requireServerConnection,
} from '../services/server-connection';

const DEFAULT_TIMEOUT = 30_000;
const ERROR_BODY_LIMIT = 500;
type PwaBridge = { serverUrl?: (path: string) => string };
type GsapUrlOptions = { includeTokenQuery?: boolean };

function pwaBridge(): PwaBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as typeof window & { __GSAP_PWA__?: PwaBridge }).__GSAP_PWA__;
}

async function buildFetchError(path: string, res: Response): Promise<Error> {
  let detail = res.statusText || 'Request failed';
  try {
    const text = await res.text();
    if (text) {
      const trimmed = text.trim();
      try {
        const payload = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
        const message = payload.error || payload.message;
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
  return new Error(`gsapFetch ${path}: ${res.status} ${detail}`);
}

export function gsapUrl(path: string, opts: GsapUrlOptions = {}): string {
  const pwa = pwaBridge();
  if (pwa?.serverUrl) {
    const url = pwa.serverUrl(path);
    return opts.includeTokenQuery ? appendPwaAccessTokenQuery(url) : url;
  }

  const connection = requireServerConnection(
    useStore.getState(),
    `gsapUrl ${path}: server connection not ready`,
  );
  return buildConnectionUrl(connection, path, { includeTokenQuery: opts.includeTokenQuery === true });
}

export async function gsapFetch(
  path: string,
  opts: RequestInit & { timeout?: number } = {},
): Promise<Response> {
  const storeState = useStore.getState();
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
      `gsapFetch ${path}: server connection not ready`,
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
