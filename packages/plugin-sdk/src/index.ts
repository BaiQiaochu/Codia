import {
  PLUGIN_SURFACE_SESSION_HEADER,
  PLUGIN_SURFACE_SESSION_QUERY,
  PLUGIN_UI_CAPABILITY,
  PLUGIN_UI_PROTOCOL,
  PLUGIN_UI_PROTOCOL_VERSION,
  parsePluginUiMessage,
  type PluginUiError,
  type PluginUiMessage,
} from '@g-sap/plugin-protocol';

export interface GsapPluginSize {
  width?: number;
  height?: number;
}

export interface GsapPluginThemeSnapshot {
  theme?: string;
  cssUrl?: string;
}

export interface GsapPluginRequestOptions {
  timeoutMs?: number;
}

export type GsapToastType = 'success' | 'error' | 'info' | 'warning';

export interface GsapToastShowInput {
  message: string;
  type?: GsapToastType;
  duration?: number;
}

export interface GsapToastShowResult {
  shown: boolean;
}

export type GsapExternalOpenInput = string | { url: string };

export interface GsapExternalOpenResult {
  opened: boolean;
}

export type GsapClipboardWriteTextInput = string | { text: string };

export interface GsapClipboardWriteTextResult {
  written: boolean;
}

export interface GsapPluginSdkOptions {
  parentWindow?: Window;
  targetWindow?: Window;
  targetOrigin?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  idFactory?: () => string;
}

export interface GsapPluginSdk {
  ready(payload?: unknown): void;
  assets: {
    url(path: string): string;
  };
  api: {
    url(path: string): string;
    fetch(path: string, init?: RequestInit): Promise<Response>;
  };
  ui: {
    resize(size: GsapPluginSize): void;
  };
  theme: {
    getSnapshot(): GsapPluginThemeSnapshot;
    subscribe(callback: (theme: GsapPluginThemeSnapshot) => void): () => void;
  };
  host: {
    request<T = unknown>(
      type: string,
      payload?: unknown,
      options?: GsapPluginRequestOptions,
    ): Promise<T>;
  };
  toast: {
    show(input: GsapToastShowInput, options?: GsapPluginRequestOptions): Promise<GsapToastShowResult>;
  };
  external: {
    open(input: GsapExternalOpenInput, options?: GsapPluginRequestOptions): Promise<GsapExternalOpenResult>;
  };
  clipboard: {
    writeText(
      input: GsapClipboardWriteTextInput,
      options?: GsapPluginRequestOptions,
    ): Promise<GsapClipboardWriteTextResult>;
  };
}

export class GsapPluginError extends Error {
  override name = 'GsapPluginError';
  readonly code: string;
  readonly details?: unknown;

  constructor(error: PluginUiError) {
    super(error.message);
    this.code = error.code;
    this.details = error.details;
  }
}

let fallbackIdSeq = 0;

function defaultIdFactory(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  fallbackIdSeq += 1;
  return `gsap-plugin-${Date.now()}-${fallbackIdSeq}`;
}

function getBrowserWindow(): Window {
  if (typeof window === 'undefined') {
    throw new Error('@g-sap/plugin-sdk requires a browser iframe window.');
  }
  return window;
}

function safeOriginFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function resolveTargetOrigin(targetWindow: Window, explicit?: string): string {
  if (explicit) return explicit;

  const hostOrigin = new URLSearchParams(targetWindow.location.search).get('gsap-host-origin');
  if (hostOrigin) return hostOrigin;

  return safeOriginFromUrl(targetWindow.document.referrer) ?? '*';
}

function readInitialTheme(targetWindow: Window): GsapPluginThemeSnapshot {
  const params = new URLSearchParams(targetWindow.location.search);
  return {
    theme: params.get('gsap-theme') ?? undefined,
    cssUrl: params.get('gsap-css') ?? undefined,
  };
}

function isTrustedHostEvent(event: MessageEvent, parentWindow: Window, targetOrigin: string): boolean {
  if (event.source !== parentWindow) return false;
  if (targetOrigin !== '*' && event.origin !== targetOrigin) return false;
  return true;
}

function externalOpenPayload(input: GsapExternalOpenInput): { url: string } {
  return typeof input === 'string' ? { url: input } : input;
}

function clipboardWriteTextPayload(input: GsapClipboardWriteTextInput): { text: string } {
  return typeof input === 'string' ? { text: input } : input;
}

function readPluginIdFromIframeRoute(targetWindow: Window): string {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(targetWindow.location.pathname || '');
  if (!match) {
    throw new Error('Plugin asset URL helper requires an iframe route under /api/plugins/:pluginId/.');
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new Error('Plugin asset URL helper could not decode the current plugin id.');
  }
}

function normalizeAssetPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Invalid plugin asset path.');
  }
  if (input.includes('\\') || input.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error('Invalid plugin asset path.');
  }
  const stripped = input.replace(/^\/+/, '');
  if (!stripped || stripped.startsWith('./')) {
    throw new Error('Invalid plugin asset path.');
  }
  const segments = stripped.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))) {
    throw new Error('Invalid plugin asset path.');
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function pluginAssetUrl(targetWindow: Window, input: string): string {
  const pluginId = readPluginIdFromIframeRoute(targetWindow);
  const assetPath = normalizeAssetPath(input);
  return `${targetWindow.location.origin}/api/plugins/${encodeURIComponent(pluginId)}/assets/${assetPath}`;
}

function readSurfaceSession(targetWindow: Window): string | null {
  const params = new URLSearchParams(targetWindow.location.search);
  const value = params.get(PLUGIN_SURFACE_SESSION_QUERY);
  return value && value.trim() ? value.trim() : null;
}

function normalizePluginApiPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('Invalid plugin API path.');
  }
  if (input.includes('\\') || input.includes('\0') || input.includes('#') || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error('Invalid plugin API path.');
  }
  if (input.startsWith('//')) {
    throw new Error('Invalid plugin API path.');
  }
  const stripped = input.replace(/^\/+/, '');
  if (!stripped || stripped.startsWith('./')) {
    throw new Error('Invalid plugin API path.');
  }
  const [rawPath, rawQuery = ''] = stripped.split('?', 2);
  const segments = rawPath.split('/');
  if (segments.length === 0 || segments.some((segment) => !segment)) {
    throw new Error('Invalid plugin API path.');
  }
  const decodedSegments = segments.map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new Error('Invalid plugin API path.');
    }
  });
  if (
    decodedSegments.some((segment) => segment === '.' || segment === '..')
    || decodedSegments.slice(0, 2).join('/') === 'api/plugins'
  ) {
    throw new Error('Invalid plugin API path.');
  }
  const encodedPath = decodedSegments.map((segment) => encodeURIComponent(segment)).join('/');
  return rawQuery ? `${encodedPath}?${rawQuery}` : encodedPath;
}

function pluginApiUrl(targetWindow: Window, input: string): string {
  const pluginId = readPluginIdFromIframeRoute(targetWindow);
  const apiPath = normalizePluginApiPath(input);
  return `${targetWindow.location.origin}/api/plugins/${encodeURIComponent(pluginId)}/${apiPath}`;
}

export function createGsapPluginSdk(options: GsapPluginSdkOptions = {}): GsapPluginSdk {
  const targetWindow = options.targetWindow ?? getBrowserWindow();
  const parentWindow = options.parentWindow ?? targetWindow.parent;
  const targetOrigin = resolveTargetOrigin(targetWindow, options.targetOrigin);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const idFactory = options.idFactory ?? defaultIdFactory;
  let themeSnapshot = readInitialTheme(targetWindow);
  const themeSubscribers = new Set<(theme: GsapPluginThemeSnapshot) => void>();

  function post(message: PluginUiMessage): void {
    parentWindow.postMessage(message, targetOrigin);
  }

  function postEvent(type: string, payload?: unknown): void {
    const message: PluginUiMessage = {
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      kind: 'event',
      type,
    };
    if (payload !== undefined) message.payload = payload;
    post(message);
  }

  function onThemeMessage(event: MessageEvent): void {
    if (!isTrustedHostEvent(event, parentWindow, targetOrigin)) return;
    const parsed = parsePluginUiMessage(event.data);
    if (!parsed.ok) return;

    const message = parsed.value;
    if (message.kind !== 'event' || message.type !== 'gsap.theme.changed') return;
    if (typeof message.payload !== 'object' || message.payload === null) return;

    const payload = message.payload as Record<string, unknown>;
    themeSnapshot = {
      theme: typeof payload.theme === 'string' ? payload.theme : themeSnapshot.theme,
      cssUrl: typeof payload.cssUrl === 'string' ? payload.cssUrl : themeSnapshot.cssUrl,
    };
    for (const callback of themeSubscribers) callback(themeSnapshot);
  }

  function request<T = unknown>(
    type: string,
    payload?: unknown,
    requestOptions: GsapPluginRequestOptions = {},
  ): Promise<T> {
    const id = idFactory();
    const timeoutMs = requestOptions.timeoutMs ?? requestTimeoutMs;

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        targetWindow.removeEventListener('message', onMessage);
        targetWindow.clearTimeout(timeout);
      };

      const onMessage = (event: MessageEvent) => {
        if (!isTrustedHostEvent(event, parentWindow, targetOrigin)) return;
        const parsed = parsePluginUiMessage(event.data);
        if (!parsed.ok) return;

        const message = parsed.value;
        if (message.id !== id || message.type !== type) return;

        if (message.kind === 'response') {
          cleanup();
          resolve(message.payload as T);
        }
        if (message.kind === 'error' && message.error) {
          cleanup();
          reject(new GsapPluginError(message.error));
        }
      };

      const timeout = targetWindow.setTimeout(() => {
        cleanup();
        reject(new GsapPluginError({
          code: 'TIMEOUT',
          message: `Plugin host request timed out: ${type}.`,
        }));
      }, timeoutMs);

      targetWindow.addEventListener('message', onMessage);

      const message: PluginUiMessage = {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id,
        kind: 'request',
        type,
      };
      if (payload !== undefined) message.payload = payload;
      post(message);
    });
  }

  return {
    ready(payload?: unknown) {
      postEvent('gsap.ready', payload);
    },
    assets: {
      url(path: string) {
        return pluginAssetUrl(targetWindow, path);
      },
    },
    api: {
      url(path: string) {
        return pluginApiUrl(targetWindow, path);
      },
      fetch(path: string, init: RequestInit = {}) {
        const surfaceSession = readSurfaceSession(targetWindow);
        if (!surfaceSession) {
          return Promise.reject(new Error('Plugin API fetch requires a plugin surface session.'));
        }
        if (typeof fetchImpl !== 'function') {
          return Promise.reject(new Error('Plugin API fetch is unavailable.'));
        }
        const headers = new Headers(init.headers);
        headers.set(PLUGIN_SURFACE_SESSION_HEADER, surfaceSession);
        return fetchImpl(pluginApiUrl(targetWindow, path), {
          ...init,
          headers,
        });
      },
    },
    ui: {
      resize(size: GsapPluginSize) {
        postEvent(PLUGIN_UI_CAPABILITY.UI_RESIZE, size);
      },
    },
    theme: {
      getSnapshot() {
        return { ...themeSnapshot };
      },
      subscribe(callback: (theme: GsapPluginThemeSnapshot) => void) {
        if (themeSubscribers.size === 0) {
          targetWindow.addEventListener('message', onThemeMessage);
        }
        themeSubscribers.add(callback);
        callback({ ...themeSnapshot });
        return () => {
          themeSubscribers.delete(callback);
          if (themeSubscribers.size === 0) {
            targetWindow.removeEventListener('message', onThemeMessage);
          }
        };
      },
    },
    host: {
      request,
    },
    toast: {
      show(input: GsapToastShowInput, options?: GsapPluginRequestOptions) {
        return request<GsapToastShowResult>(PLUGIN_UI_CAPABILITY.TOAST_SHOW, input, options);
      },
    },
    external: {
      open(input: GsapExternalOpenInput, options?: GsapPluginRequestOptions) {
        return request<GsapExternalOpenResult>(PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN, externalOpenPayload(input), options);
      },
    },
    clipboard: {
      writeText(input: GsapClipboardWriteTextInput, options?: GsapPluginRequestOptions) {
        return request<GsapClipboardWriteTextResult>(
          PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
          clipboardWriteTextPayload(input),
          options,
        );
      },
    },
  };
}

let singleton: GsapPluginSdk | null = null;

function getSingleton(): GsapPluginSdk {
  singleton ??= createGsapPluginSdk();
  return singleton;
}

export const gsap: GsapPluginSdk = {
  ready(payload?: unknown) {
    return getSingleton().ready(payload);
  },
  assets: {
    url(path: string) {
      return getSingleton().assets.url(path);
    },
  },
  api: {
    url(path: string) {
      return getSingleton().api.url(path);
    },
    fetch(path: string, init?: RequestInit) {
      return getSingleton().api.fetch(path, init);
    },
  },
  ui: {
    resize(size: GsapPluginSize) {
      return getSingleton().ui.resize(size);
    },
  },
  theme: {
    getSnapshot() {
      return getSingleton().theme.getSnapshot();
    },
    subscribe(callback: (theme: GsapPluginThemeSnapshot) => void) {
      return getSingleton().theme.subscribe(callback);
    },
  },
  host: {
    request<T = unknown>(
      type: string,
      payload?: unknown,
      options?: GsapPluginRequestOptions,
    ) {
      return getSingleton().host.request<T>(type, payload, options);
    },
  },
  toast: {
    show(input: GsapToastShowInput, options?: GsapPluginRequestOptions) {
      return getSingleton().toast.show(input, options);
    },
  },
  external: {
    open(input: GsapExternalOpenInput, options?: GsapPluginRequestOptions) {
      return getSingleton().external.open(input, options);
    },
  },
  clipboard: {
    writeText(input: GsapClipboardWriteTextInput, options?: GsapPluginRequestOptions) {
      return getSingleton().clipboard.writeText(input, options);
    },
  },
};
