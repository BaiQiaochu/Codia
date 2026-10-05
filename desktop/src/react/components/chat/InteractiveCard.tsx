import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../stores';
import { gsapFetch, gsapUrl } from '../../hooks/use-gsap-fetch';
import styles from './InteractiveCard.module.css';

const THEME_VARS = [
  '--bg',
  '--bg-card',
  '--sidebar-bg',
  '--text',
  '--text-light',
  '--text-muted',
  '--border',
  '--accent',
  '--accent-hover',
  '--accent-light',
  '--accent-rgb',
  '--green',
  '--danger',
  '--radius-chat-card',
  '--radius-chat-card-inner',
  '--space-xs',
  '--space-sm',
  '--space-md',
  '--space-lg',
] as const;

const HEIGHT_CAP = 900;
const RESIZE_EVENT = 'gsap.card-resize';
const PING_EVENT = 'gsap.card-ping';

function collectThemeVars(): string {
  const root = getComputedStyle(document.documentElement);
  return THEME_VARS
    .map((name) => {
      const value = root.getPropertyValue(name).trim();
      return value ? `  ${name}: ${value};` : '';
    })
    .filter(Boolean)
    .join('\n');
}

interface InteractiveCardProps {
  block: {
    type: 'interactive_card';
    cardId: string;
    title: string;
    code: string;
  };
}

export const InteractiveCard = memo(function InteractiveCard({ block }: InteractiveCardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const versionRef = useRef(0);
  const connection = useStore(s => s.activeServerConnection);
  const [explicitHeight, setExplicitHeight] = useState<number | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cardId = block.cardId;
    if (!cardId || !connection) {
      setSrc(null);
      return;
    }

    const varsCss = collectThemeVars();
    (async () => {
      try {
        await gsapFetch(`/api/cards/${encodeURIComponent(cardId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: block.code, title: block.title, varsCss }),
        });
        if (cancelled) return;
        const base = gsapUrl(`/api/cards/${encodeURIComponent(cardId)}`, { includeTokenQuery: true });
        versionRef.current += 1;
        const sep = base.includes('?') ? '&' : '?';
        setSrc(`${base}${sep}v=${versionRef.current}`);
      } catch (err) {
        if (!cancelled) {
          console.error('[InteractiveCard] register failed:', err);
          setSrc(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [block.cardId, block.code, block.title, connection]);

  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.source !== iframeRef.current?.contentWindow) return;
    if (event.data?.type !== RESIZE_EVENT) return;
    const height = Number(event.data.height);
    if (height > 0) setExplicitHeight(Math.min(height, HEIGHT_CAP));
  }, []);

  useEffect(() => {
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleMessage]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => {
      iframe.contentWindow?.postMessage(PING_EVENT, '*');
    };
    iframe.addEventListener('load', onLoad);
    return () => iframe.removeEventListener('load', onLoad);
  }, [src]);

  const frameStyle: CSSProperties = explicitHeight != null ? { height: explicitHeight } : {};
  const frameClassName = [
    styles.interactiveCardFrame,
    explicitHeight !== null && explicitHeight >= HEIGHT_CAP ? styles.interactiveCardFrameScrollable : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={styles.interactiveCard}>
      <div className={frameClassName} style={frameStyle}>
        {src && (
          <iframe
            ref={iframeRef}
            src={src}
            sandbox="allow-scripts"
            title={block.title || 'Interactive card'}
          />
        )}
      </div>
    </div>
  );
});
