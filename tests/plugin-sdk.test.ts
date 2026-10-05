// @ts-nocheck
/**
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_SURFACE_SESSION_HEADER,
  PLUGIN_UI_CAPABILITY,
  PLUGIN_UI_PROTOCOL,
  PLUGIN_UI_PROTOCOL_VERSION,
} from '@g-sap/plugin-protocol';
import { createGsapPluginSdk, GsapPluginError } from '@g-sap/plugin-sdk';

function makeParentWindow() {
  return { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
}

function makeTargetWindow(href: string) {
  const location = new URL(href);
  return {
    parent: makeParentWindow(),
    location,
    document: { referrer: '' },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  } as unknown as Window;
}

describe('plugin SDK', () => {
  it('posts ready and resize as versioned plugin UI events', () => {
    const parentWindow = makeParentWindow();
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'id-1',
    });

    sdk.ready();
    sdk.ui.resize({ width: 260, height: 210 });

    expect(parentWindow.postMessage).toHaveBeenNthCalledWith(1, {
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      kind: 'event',
      type: 'gsap.ready',
    }, 'http://127.0.0.1:3210');
    expect(parentWindow.postMessage).toHaveBeenNthCalledWith(2, {
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      kind: 'event',
      type: PLUGIN_UI_CAPABILITY.UI_RESIZE,
      payload: { width: 260, height: 210 },
    }, 'http://127.0.0.1:3210');
  });

  it('resolves host requests only from the configured parent window and origin', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'request-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.host.request('toast.show', { message: 'hello' });
    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'request-1',
      kind: 'request',
      type: 'toast.show',
      payload: { message: 'hello' },
    }, 'http://127.0.0.1:3210');

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-1',
        kind: 'response',
        type: 'toast.show',
        payload: { ignored: true },
      },
      origin: 'http://evil.test',
      source: parentWindow,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-1',
        kind: 'response',
        type: 'toast.show',
        payload: { ignored: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: window,
    }));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-1',
        kind: 'response',
        type: 'toast.show',
        payload: { ok: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rejects host request errors with a typed GsapPluginError', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'request-2',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.host.request('external.open', { url: 'https://example.com' });
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'request-2',
        kind: 'error',
        type: 'external.open',
        error: {
          code: 'CAPABILITY_DENIED',
          message: 'Capability denied.',
          details: { capability: 'external.open' },
        },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).rejects.toMatchObject({
      name: 'GsapPluginError',
      code: 'CAPABILITY_DENIED',
      message: 'Capability denied.',
      details: { capability: 'external.open' },
    } satisfies Partial<GsapPluginError>);
  });

  it('wraps toast.show as a typed host request helper', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'toast-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.toast.show({ message: 'Saved', type: 'success', duration: 3000 });

    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'toast-1',
      kind: 'request',
      type: PLUGIN_UI_CAPABILITY.TOAST_SHOW,
      payload: { message: 'Saved', type: 'success', duration: 3000 },
    }, 'http://127.0.0.1:3210');
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'toast-1',
        kind: 'response',
        type: PLUGIN_UI_CAPABILITY.TOAST_SHOW,
        payload: { shown: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ shown: true });
  });

  it('wraps external.open string input as a typed host request helper', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'external-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.external.open('https://example.com/docs');

    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'external-1',
      kind: 'request',
      type: PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN,
      payload: { url: 'https://example.com/docs' },
    }, 'http://127.0.0.1:3210');
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'external-1',
        kind: 'response',
        type: PLUGIN_UI_CAPABILITY.EXTERNAL_OPEN,
        payload: { opened: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ opened: true });
  });

  it('wraps clipboard.writeText string input as a typed host request helper', async () => {
    const parentWindow = makeParentWindow();
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow: window,
      targetOrigin: 'http://127.0.0.1:3210',
      idFactory: () => 'clipboard-1',
      requestTimeoutMs: 1000,
    });

    const pending = sdk.clipboard.writeText('copy me');

    expect(parentWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'clipboard-1',
      kind: 'request',
      type: PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
      payload: { text: 'copy me' },
    }, 'http://127.0.0.1:3210');
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        protocol: PLUGIN_UI_PROTOCOL,
        version: PLUGIN_UI_PROTOCOL_VERSION,
        id: 'clipboard-1',
        kind: 'response',
        type: PLUGIN_UI_CAPABILITY.CLIPBOARD_WRITE_TEXT,
        payload: { written: true },
      },
      origin: 'http://127.0.0.1:3210',
      source: parentWindow,
    }));

    await expect(pending).resolves.toEqual({ written: true });
  });

  it('resolves plugin asset URLs from the current iframe route', () => {
    const parentWindow = makeParentWindow();
    const targetWindow = makeTargetWindow('https://gsap.example/api/plugins/demo-plugin/page?gsap-host-origin=https%3A%2F%2Fgsap.example');
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow,
      targetOrigin: 'https://gsap.example',
    });

    expect(sdk.assets.url('dist/app.js')).toBe('https://gsap.example/api/plugins/demo-plugin/assets/dist/app.js');
    expect(sdk.assets.url('/images/logo.svg')).toBe('https://gsap.example/api/plugins/demo-plugin/assets/images/logo.svg');
  });

  it('rejects unsafe plugin asset URL inputs', () => {
    const sdk = createGsapPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow: makeTargetWindow('https://gsap.example/api/plugins/demo/page'),
      targetOrigin: 'https://gsap.example',
    });

    for (const unsafePath of ['../secret.js', 'dist\\app.js', 'https://evil.test/app.js', '', './app.js']) {
      expect(() => sdk.assets.url(unsafePath)).toThrow(/asset path/i);
    }
  });

  it('resolves same-origin plugin API URLs from the current iframe route', () => {
    const sdk = createGsapPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow: makeTargetWindow('https://gsap.example/api/plugins/demo-plugin/page?gsap-host-origin=https%3A%2F%2Fgsap.example'),
      targetOrigin: 'https://gsap.example',
    });

    expect(sdk.api.url('api/translate')).toBe('https://gsap.example/api/plugins/demo-plugin/api/translate');
    expect(sdk.api.url('/api/translate?mode=fast')).toBe('https://gsap.example/api/plugins/demo-plugin/api/translate?mode=fast');
  });

  it('attaches the plugin surface session header for plugin API fetches', async () => {
    const parentWindow = makeParentWindow();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const sdk = createGsapPluginSdk({
      parentWindow,
      targetWindow: makeTargetWindow('https://gsap.example/api/plugins/demo-plugin/page?pluginSurfaceSession=session-1'),
      targetOrigin: 'https://gsap.example',
      fetchImpl,
    });

    const response = await sdk.api.fetch('api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://gsap.example/api/plugins/demo-plugin/api/translate');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(new Headers(init.headers).get(PLUGIN_SURFACE_SESSION_HEADER)).toBe('session-1');
  });

  it('rejects unsafe plugin API paths and missing surface sessions before fetch', async () => {
    const sdk = createGsapPluginSdk({
      parentWindow: makeParentWindow(),
      targetWindow: makeTargetWindow('https://gsap.example/api/plugins/demo/page'),
      targetOrigin: 'https://gsap.example',
      fetchImpl: vi.fn(),
    });

    for (const unsafePath of ['', '../admin', 'api/../admin', 'https://evil.test/api', '//evil.test/api', 'api\\translate']) {
      expect(() => sdk.api.url(unsafePath)).toThrow(/api path/i);
    }
    await expect(sdk.api.fetch('api/translate')).rejects.toThrow(/surface session/i);
  });
});
