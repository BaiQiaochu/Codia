import { useRef, useState, useCallback, useMemo, useLayoutEffect } from 'react';
import { switchTab } from '../components/channels/tab-router';
import { DEFAULT_PLUGIN_UI_CAPABILITIES } from '../plugin-ui/capabilities';
import {
  clampPluginIframeSize,
  getPluginIframeOrigin,
  handlePluginUiRequest,
  isTrustedPluginIframeMessage,
  parsePluginIframeHostMessage,
  type PluginIframeSize,
  type PluginIframeStatus,
  type PluginUiCapability,
  type PluginUiSlot,
} from '../plugin-ui/plugin-ui-host-controller';
import type { TabType } from '../types';

const HANDSHAKE_TIMEOUT_MS = 5000;
const EMPTY_CAPABILITY_GRANTS: readonly string[] = [];

interface UsePluginIframeOptions {
  pluginId?: string;
  agentId?: string | null;
  slot?: PluginUiSlot;
  initialSize?: PluginIframeSize;
  readyOnTimeout?: boolean;
  capabilities?: readonly PluginUiCapability[];
  capabilityGrants?: readonly string[];
}

function isAllowedPluginNavigationTab(tab: string): tab is TabType {
  return tab === 'chat' || tab === 'channels' || tab.startsWith('plugin:');
}

export function usePluginIframe(routeUrl: string | null, options: UsePluginIframeOptions = {}) {
  const {
    pluginId = 'unknown-plugin',
    agentId = null,
    slot = 'page',
    initialSize,
    readyOnTimeout = false,
    capabilities = DEFAULT_PLUGIN_UI_CAPABILITIES,
    capabilityGrants = EMPTY_CAPABILITY_GRANTS,
  } = options;

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seqRef = useRef(0);
  const expectedOrigin = useMemo(() => getPluginIframeOrigin(routeUrl), [routeUrl]);
  const initialWidth = initialSize?.width;
  const initialHeight = initialSize?.height;
  const initialSizeSnapshot = useMemo<PluginIframeSize>(
    () => {
      const next: PluginIframeSize = {};
      if (typeof initialWidth === 'number') next.width = initialWidth;
      if (typeof initialHeight === 'number') next.height = initialHeight;
      return next;
    },
    [initialWidth, initialHeight],
  );
  const [status, setStatus] = useState<PluginIframeStatus>('loading');
  const [size, setSize] = useState<PluginIframeSize>(() => initialSizeSnapshot);

  const resetHandshakeTimeout = useCallback(() => {
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setStatus(readyOnTimeout ? 'ready' : 'error');
    }, HANDSHAKE_TIMEOUT_MS);
  }, [readyOnTimeout]);

  useLayoutEffect(() => {
    const iframe = iframeRef.current;
    if (!routeUrl) {
      iframe?.removeAttribute('src');
      return;
    }

    setStatus('loading');
    setSize(initialSizeSnapshot);

    const markReady = () => {
      clearTimeout(timeoutRef.current);
      setStatus('ready');
    };

    const onMessage = (event: MessageEvent) => {
      if (!isTrustedPluginIframeMessage(event, iframeRef.current?.contentWindow, expectedOrigin)) return;
      const message = parsePluginIframeHostMessage(event.data);
      if (!message) return;

      if (message.kind === 'ready') {
        markReady();
      }
      if (message.kind === 'navigate-tab' && isAllowedPluginNavigationTab(message.tab)) {
        switchTab(message.tab);
      }
      if (message.kind === 'resize') {
        const iframeElement = iframeRef.current;
        setSize((current) => {
          const next = clampPluginIframeSize(slot, message.size, current, window.innerHeight);
          if (slot !== 'card' && iframeElement && typeof next.height === 'number') {
            iframeElement.style.height = `${next.height}px`;
          }
          return next;
        });
      }
      if (message.kind === 'request') {
        const iframeElement = iframeRef.current;
        if (!iframeElement?.contentWindow || !expectedOrigin) return;
        const iframeWindow = iframeElement.contentWindow;
        void handlePluginUiRequest({
          message: message.message,
          context: {
            pluginId,
            slot,
            routeUrl,
            origin: expectedOrigin,
            iframeWindow,
            agentId,
            grantedCapabilities: new Set(capabilityGrants),
          },
          capabilities,
        }).then((response) => {
          iframeWindow.postMessage(response, expectedOrigin);
        });
      }
    };

    window.addEventListener('message', onMessage);
    iframe?.addEventListener('load', markReady);
    resetHandshakeTimeout();
    if (iframe) iframe.src = routeUrl;

    return () => {
      window.removeEventListener('message', onMessage);
      iframe?.removeEventListener('load', markReady);
      clearTimeout(timeoutRef.current);
    };
  }, [
    routeUrl,
    expectedOrigin,
    slot,
    pluginId,
    agentId,
    capabilities,
    capabilityGrants,
    initialSizeSnapshot,
    resetHandshakeTimeout,
  ]);

  const postToIframe = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;
    if (!expectedOrigin) return;
    seqRef.current += 1;
    iframe.contentWindow.postMessage({ type, payload, seq: seqRef.current }, expectedOrigin);
  }, [expectedOrigin]);

  const retry = useCallback(() => {
    setStatus('loading');
    setSize(initialSizeSnapshot);
    clearTimeout(timeoutRef.current);
    const iframe = iframeRef.current;
    if (iframe && routeUrl) {
      iframe.src = routeUrl;
    }
    resetHandshakeTimeout();
  }, [routeUrl, initialSizeSnapshot, resetHandshakeTimeout]);

  return { iframeRef, status, size, postToIframe, retry };
}
