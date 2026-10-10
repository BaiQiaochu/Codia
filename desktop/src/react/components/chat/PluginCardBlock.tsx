import { lazy, Suspense, useRef, useEffect, useState, useMemo } from 'react';
import { usePluginSurfaceUrl } from '../../hooks/use-plugin-surface-url';
import { DEFAULT_PLUGIN_UI_CAPABILITIES } from '../../plugin-ui/capabilities';
import {
  getPluginIframeOrigin,
  handlePluginUiRequest,
  isTrustedPluginIframeMessage,
  parsePluginIframeHostMessage,
} from '../../plugin-ui/plugin-ui-host-controller';
import { useStore } from '../../stores';
import { loadMessages } from '../../stores/session-actions';
import { sessionScopedValue } from '../../stores/session-slice';
import type { PluginCardDetails } from '../../types';
import type { FileKind, FileRef } from '../../types/file-ref';
import s from './PluginCardBlock.module.css';
import { openMediaViewerForRef } from '../../utils/open-media-viewer';

const LazyChatMessageSurface = lazy(() => import('./ChatMessageSurface').then(module => ({
  default: module.ChatMessageSurface,
})));

interface Props {
  card: PluginCardDetails;
  agentId?: string | null;
}

const MAX_W = 400;
const MAX_H = 600;
const MIN_W = 320;
const WIDE_CARD_PLUGIN_IDS = new Set(['knowledge-graph', 'mind-map']);
const WIDE_CARD_W = 960;
const WIDE_CARD_MAX_H = 760;
const WIDE_CARD_H = 680;
const OPENABLE_MEDIA_KINDS = new Set<FileKind>(['image', 'svg', 'video', 'audio']);
const EMPTY_CAPABILITY_GRANTS: readonly string[] = [];

function parseRatio(raw?: string): number {
  if (!raw) return 0;
  const [w, h] = raw.split(':').map(Number);
  return (w && h) ? w / h : 0;
}

function toMediaKind(value: unknown): FileKind {
  const kind = typeof value === 'string' ? value : 'image';
  return OPENABLE_MEDIA_KINDS.has(kind as FileKind) ? kind as FileKind : 'image';
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isIframeCard(card: PluginCardDetails): boolean {
  return !card.type || card.type === 'iframe' || card.type === 'webview';
}

function chatSurfaceSession(card: PluginCardDetails): { sessionId: string | null; sessionPath: string | null } {
  const sessionRef = card.sessionRef || null;
  const sessionId = card.sessionId || sessionRef?.sessionId || null;
  const sessionPath = card.sessionPath
    || sessionRef?.sessionPath
    || sessionRef?.path
    || sessionRef?.legacySessionPath
    || null;
  return { sessionId, sessionPath };
}

function PluginCardFallback({ card }: { card: PluginCardDetails }) {
  if (!card.description) return null;
  return (
    <div className={s.container}>
      {card.title && <div className={s.title}>{card.title}</div>}
      <div className={s.description}>{card.description}</div>
    </div>
  );
}

function PluginChatSurfaceCard({ card }: { card: PluginCardDetails }) {
  const { sessionId, sessionPath } = chatSurfaceSession(card);
  const hasTitle = Boolean(card.title);
  const loaded = useStore(st => sessionPath
    ? Boolean(sessionScopedValue(st, st.chatSessions, sessionPath))
    : false);

  useEffect(() => {
    if (!sessionPath || loaded) return;
    void loadMessages(sessionPath);
  }, [loaded, sessionPath]);

  if (!sessionId || !sessionPath) {
    return <PluginCardFallback card={card} />;
  }

  return (
    <div className={`${s.container} ${s.chatSurface}`}>
      {hasTitle && (
        <div className={s.chatSurfaceHeader}>
          <div className={s.chatSurfaceTitle}>{card.title}</div>
        </div>
      )}
      <div className={`${s.chatSurfaceBody}${hasTitle ? '' : ` ${s.chatSurfaceBodyFull}`}`}>
        <Suspense fallback={null}>
          <LazyChatMessageSurface sessionPath={sessionPath} active variant="card" />
        </Suspense>
      </div>
    </div>
  );
}

function PluginWebViewCard({ card, agentId }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const capabilityGrants = useStore(st => st.pluginUiHostCapabilities[card.pluginId] ?? EMPTY_CAPABILITY_GRANTS);
  const isWideCard = WIDE_CARD_PLUGIN_IDS.has(card.pluginId);
  const maxHeight = isWideCard ? WIDE_CARD_MAX_H : MAX_H;

  const ratio = parseRatio(card.aspectRatio);
  const defaultW = isWideCard ? WIDE_CARD_W : MAX_W;
  const defaultH = isWideCard
    ? WIDE_CARD_H
    : ratio > 0
    ? Math.min(Math.round(defaultW / ratio), maxHeight)
    : Math.round(defaultW * 0.75);

  const [size, setSize] = useState({ w: defaultW, h: defaultH });

  const isIframe = isIframeCard(card);
  const routeUrl = isIframe && card.route ? `/api/plugins/${card.pluginId}${card.route}` : null;
  const surfaceUrl = usePluginSurfaceUrl(routeUrl, agentId);
  const src = surfaceUrl.iframeSrc || '';
  const sandboxPermissions = isWideCard
    ? 'allow-scripts allow-same-origin allow-downloads allow-modals'
    : 'allow-scripts allow-same-origin allow-downloads';
  const expectedOrigin = useMemo(() => getPluginIframeOrigin(src), [src]);

  useEffect(() => {
    if (!isIframe) return;
    setReady(false);
    setError(false);
    const onMessage = (e: MessageEvent) => {
      if (!isTrustedPluginIframeMessage(e, iframeRef.current?.contentWindow, expectedOrigin)) return;
      const hostMessage = parsePluginIframeHostMessage(e.data);

      if (hostMessage?.kind === 'ready') setReady(true);
      if (hostMessage?.kind === 'resize') {
        if (isWideCard) {
          setSize(prev => (
            prev.w === WIDE_CARD_W && prev.h === WIDE_CARD_H
              ? prev
              : { w: WIDE_CARD_W, h: WIDE_CARD_H }
          ));
          return;
        }
        const { width, height } = hostMessage.size;
        const nextHeight = typeof height === 'number' && height >= 30
          ? Math.min(Math.ceil(height), maxHeight)
          : null;
        setSize(prev => ({
          w: typeof width === 'number' && width >= 50 ? Math.min(Math.max(width, MIN_W), MAX_W) : prev.w,
          h: nextHeight == null ? prev.h : Math.max(defaultH, nextHeight),
        }));
      }
      if (hostMessage?.kind === 'request') {
        const iframe = iframeRef.current;
        if (!iframe?.contentWindow || !expectedOrigin) return;
        const iframeWindow = iframe.contentWindow;
        void handlePluginUiRequest({
          message: hostMessage.message,
          context: {
            pluginId: card.pluginId,
            slot: 'card',
            routeUrl: src,
            origin: expectedOrigin,
            iframeWindow,
            agentId,
            grantedCapabilities: new Set(capabilityGrants),
          },
          capabilities: DEFAULT_PLUGIN_UI_CAPABILITIES,
        }).then((response) => {
          iframeWindow.postMessage(response, expectedOrigin);
        });
      }
      if (e.data?.type === 'media-open-request') {
        const payload = e.data.payload || {};
        const path = toStringOrEmpty(payload.path);
        const name = toStringOrEmpty(payload.name || payload.fileName || path.split(/[\\/]/).pop());
        if (!path || !name) return;

        const ref: FileRef = {
          id: `plugin:${card.pluginId}:${path}`,
          kind: toMediaKind(payload.kind),
          source: 'session-block-file',
          name,
          path,
          ext: toStringOrEmpty(payload.ext) || undefined,
          mime: toStringOrEmpty(payload.mime) || undefined,
        };
        openMediaViewerForRef(ref, { origin: 'session' });
      }
    };
    window.addEventListener('message', onMessage);
    const timeout = setTimeout(() => setReady(true), 5000);
    return () => { window.removeEventListener('message', onMessage); clearTimeout(timeout); };
  }, [isIframe, expectedOrigin, src, isWideCard, maxHeight, defaultH, card.pluginId, agentId, capabilityGrants]);

  if (!isIframe || !routeUrl || error || surfaceUrl.status === 'error') {
    return <PluginCardFallback card={card} />;
  }

  return (
    <div className={`${s.container} ${isWideCard ? s.stableContainer : ''}`}>
      <iframe
        ref={iframeRef}
        className={`${s.iframe} ${isWideCard ? s.stableIframe : ''}`}
        src={src || undefined}
        sandbox={sandboxPermissions}
        style={{ width: isWideCard ? '100%' : size.w, height: size.h, opacity: ready && surfaceUrl.status === 'ready' ? 1 : 0.3 }}
        onError={() => setError(true)}
      />
    </div>
  );
}

export function PluginCardBlock({ card, agentId }: Props) {
  if (card.type === 'chat.surface') {
    return <PluginChatSurfaceCard card={card} />;
  }
  return <PluginWebViewCard card={card} agentId={agentId} />;
}
