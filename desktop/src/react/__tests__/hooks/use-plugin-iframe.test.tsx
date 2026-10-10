/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  PLUGIN_UI_CAPABILITY,
  PLUGIN_UI_ERROR_CODE,
  PLUGIN_UI_PROTOCOL,
  PLUGIN_UI_PROTOCOL_VERSION,
} from '@codia/plugin-protocol';
import { usePluginIframe } from '../../hooks/use-plugin-iframe';

vi.mock('../../components/channels/tab-router', () => ({
  switchTab: (...args: unknown[]) => switchTab(...args),
}));

const switchTab = vi.fn();

function attachIframeWindow(iframe: HTMLIFrameElement, contentWindow: Window & { postMessage: ReturnType<typeof vi.fn> }) {
  Object.defineProperty(iframe, 'contentWindow', {
    configurable: true,
    value: contentWindow,
  });
}

function Harness({ routeUrl }: { routeUrl: string | null }) {
  const { iframeRef, status, postToIframe } = usePluginIframe(routeUrl);
  return (
    <div>
      <div data-testid="status">{status}</div>
      <iframe ref={iframeRef} data-testid="iframe" />
      <button onClick={() => postToIframe('visibility-changed', { visible: true })}>post</button>
    </div>
  );
}

describe('usePluginIframe', () => {
  afterEach(() => {
    cleanup();
    switchTab.mockReset();
  });

  it('only accepts ready messages from the expected iframe window and origin', () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/page?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;
    const trustedWindow = { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
    attachIframeWindow(iframe, trustedWindow);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'ready' },
        origin: 'http://evil.test',
        source: trustedWindow,
      }));
    });
    expect(screen.getByTestId('status').textContent).toBe('loading');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'ready' },
        origin: 'http://127.0.0.1:3210',
        source: { postMessage: vi.fn() } as unknown as Window,
      }));
    });
    expect(screen.getByTestId('status').textContent).toBe('loading');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'ready' },
        origin: 'http://127.0.0.1:3210',
        source: trustedWindow,
      }));
    });
    expect(screen.getByTestId('status').textContent).toBe('ready');
  });

  it('handles same-origin relative plugin URLs used by the PWA backend proxy', () => {
    render(<Harness routeUrl="/__codia_backend__/api/plugins/demo/page?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;
    const trustedWindow = { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
    attachIframeWindow(iframe, trustedWindow);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'ready' },
        origin: window.location.origin,
        source: trustedWindow,
      }));
    });

    expect(screen.getByTestId('status').textContent).toBe('ready');
  });

  it('sets iframe src from the hook after the message listener is installed', () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/page?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;

    expect(iframe.getAttribute('src')).toBe('http://127.0.0.1:3210/api/plugins/demo/page?token=abc');
  });

  it('treats iframe load as ready so plugin configuration screens can render', () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/page?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;

    act(() => {
      fireEvent.load(iframe);
    });

    expect(screen.getByTestId('status').textContent).toBe('ready');
  });

  it('accepts navigate-tab only from trusted messages and posts to the exact target origin', async () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/widget?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;
    const trustedWindow = { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
    attachIframeWindow(iframe, trustedWindow);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'navigate-tab', payload: { tab: 'channels' } },
        origin: 'http://evil.test',
        source: trustedWindow,
      }));
    });
    await Promise.resolve();
    expect(switchTab).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'navigate-tab', payload: { tab: 'channels' } },
        origin: 'http://127.0.0.1:3210',
        source: trustedWindow,
      }));
    });
    await waitFor(() => expect(switchTab).toHaveBeenCalledWith('channels'));

    fireEvent.click(screen.getByText('post'));
    expect(trustedWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'visibility-changed',
        payload: { visible: true },
        seq: 1,
      }),
      'http://127.0.0.1:3210',
    );
  });

  it('accepts protocol ready and resize events from the plugin SDK', () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/page?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;
    const trustedWindow = { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
    attachIframeWindow(iframe, trustedWindow);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          kind: 'event',
          type: 'codia.ready',
        },
        origin: 'http://127.0.0.1:3210',
        source: trustedWindow,
      }));
    });
    expect(screen.getByTestId('status').textContent).toBe('ready');

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          kind: 'event',
          type: PLUGIN_UI_CAPABILITY.UI_RESIZE,
          payload: { height: 240 },
        },
        origin: 'http://127.0.0.1:3210',
        source: trustedWindow,
      }));
    });
    expect(iframe.style.height).toBe('240px');
  });

  it('responds to unsupported plugin SDK host requests with protocol errors', async () => {
    render(<Harness routeUrl="http://127.0.0.1:3210/api/plugins/demo/page?token=abc" />);
    const iframe = screen.getByTestId('iframe') as HTMLIFrameElement;
    const trustedWindow = { postMessage: vi.fn() } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
    attachIframeWindow(iframe, trustedWindow);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          protocol: PLUGIN_UI_PROTOCOL,
          version: PLUGIN_UI_PROTOCOL_VERSION,
          id: 'req-1',
          kind: 'request',
          type: 'unknown.capability',
          payload: {},
        },
        origin: 'http://127.0.0.1:3210',
        source: trustedWindow,
      }));
    });

    await waitFor(() => expect(trustedWindow.postMessage).toHaveBeenCalledWith({
      protocol: PLUGIN_UI_PROTOCOL,
      version: PLUGIN_UI_PROTOCOL_VERSION,
      id: 'req-1',
      kind: 'error',
      type: 'unknown.capability',
      error: {
        code: PLUGIN_UI_ERROR_CODE.UNKNOWN_TYPE,
        message: 'Unknown Plugin UI capability: unknown.capability.',
      },
    }, 'http://127.0.0.1:3210'));
  });
});
