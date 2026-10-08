import { useState, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../stores';
import { toStringArray } from '../../stores/session-selectors';
import { sessionScopedListIncludes, sessionScopedValue } from '../../stores/session-slice';
import { useI18n } from '../../hooks/use-i18n';
import { getWebSocket } from '../../services/websocket';
import { refreshSessionCapabilities } from '../../stores/session-actions';
import { AnchoredPortal, Tooltip } from '../../ui';
import { normalizeYuanKey } from '../../utils/yuan';
import { shouldShowContextRingTokenLabel } from './context-ring-visibility';
import styles from './InputArea.module.css';

export function ContextRing() {
  const { t } = useI18n();
  const agentYuan = useStore((s) => s.agentYuan);
  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const sessionModel = useStore((s) => s.currentSessionPath ? sessionScopedValue(s, s.sessionModelsByPath, s.currentSessionPath) : undefined);
  const currentModel = useStore((s) => s.models.find((m) => m.isCurrent));
  const contextEntry = useStore((s) => s.currentSessionPath ? sessionScopedValue(s, s.contextBySession, s.currentSessionPath) : undefined);
  const globalContextTokens = useStore((s) => s.contextTokens);
  const globalContextWindow = useStore((s) => s.contextWindow);
  const globalContextPercent = useStore((s) => s.contextPercent);
  const storeCompacting = useStore((s) => currentSessionPath ? sessionScopedListIncludes(s, toStringArray(s.compactingSessions), currentSessionPath) : false);
  const refreshing = useStore((s) => currentSessionPath ? sessionScopedListIncludes(s, toStringArray(s.capabilityRefreshingSessions), currentSessionPath) : false);

  const [tokens, setTokens] = useState<number | null>(null);
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [percent, setPercent] = useState<number | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [tooltipPlacement, setTooltipPlacement] = useState<'above' | 'below'>('above');
  const [tooltipStyle, setTooltipStyle] = useState<{ top: number; left: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const storeContextTokens = contextEntry?.tokens ?? globalContextTokens;
  const storeContextWindow = contextEntry?.window ?? globalContextWindow;
  const storeContextPercent = contextEntry?.percent ?? globalContextPercent;
  const fallbackContextWindow = sessionModel?.contextWindow ?? currentModel?.contextWindow ?? null;
  const busy = compacting || refreshing;

  useEffect(() => {
    setTokens(storeContextTokens ?? null);
    setContextWindow(storeContextWindow ?? fallbackContextWindow);
    setPercent(storeContextPercent ?? null);
    setCompacting(storeCompacting);
  }, [storeContextTokens, storeContextWindow, storeContextPercent, fallbackContextWindow, storeCompacting]);

  useEffect(() => {
    if (!currentSessionPath || storeContextTokens != null) return;
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'context_usage', sessionPath: currentSessionPath }));
    }
  }, [currentSessionPath, storeContextTokens]);

  useEffect(() => {
    setMenuOpen(false);
  }, [currentSessionPath]);

  const handleClick = useCallback(() => {
    if (busy || !currentSessionPath) return;
    setHovered(false);
    setMenuOpen((open) => !open);
  }, [busy, currentSessionPath]);

  const handleRefreshAndCompact = useCallback(() => {
    if (busy || !currentSessionPath) return;
    setMenuOpen(false);
    void refreshSessionCapabilities(currentSessionPath);
  }, [busy, currentSessionPath]);

  const handleCompact = useCallback(() => {
    if (busy || !currentSessionPath) return;
    setMenuOpen(false);
    const ws = getWebSocket();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'compact', sessionPath: currentSessionPath }));
    }
  }, [busy, currentSessionPath]);

  const updateTooltipPosition = useCallback(() => {
    const anchor = wrapRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const gap = 8;
    const viewportPadding = 8;

    let left = anchorRect.right - tooltipRect.width;
    left = Math.min(left, window.innerWidth - tooltipRect.width - viewportPadding);
    left = Math.max(viewportPadding, left);

    let top = anchorRect.top - tooltipRect.height - gap;
    let placement: 'above' | 'below' = 'above';

    if (top < viewportPadding) {
      top = Math.min(anchorRect.bottom + gap, window.innerHeight - tooltipRect.height - viewportPadding);
      placement = 'below';
    }

    setTooltipPlacement(placement);
    setTooltipStyle({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!hovered) return undefined;

    const raf = requestAnimationFrame(updateTooltipPosition);
    const handleReposition = () => updateTooltipPosition();
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [hovered, updateTooltipPosition, tokens, contextWindow, percent, compacting]);

  const hasData = tokens != null && contextWindow != null;
  const pct = percent ?? 0;
  const r = 6;
  const sw = 2.5;
  const size = (r + sw) * 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDashoffset = circumference * (1 - Math.min(hasData ? pct : 0, 100) / 100);
  const yuan = normalizeYuanKey(agentYuan);

  const tokensLabel: number | string = tokens != null ? Math.round(tokens / 1000) : '--';
  const windowLabel: number | string = contextWindow != null ? Math.round(contextWindow / 1000) : '--';
  const showTokenLabel = !busy && shouldShowContextRingTokenLabel(tokens);

  const tooltip = hovered && !menuOpen && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={tooltipRef}
          className={`${styles['context-ring-tooltip']}${tooltipPlacement === 'below' ? ` ${styles['below']}` : ''}`}
          style={tooltipStyle ?? undefined}
        >
          <div>{t('input.contextWindow', { windowK: windowLabel })}</div>
          <div>{t('input.tokensUsed', { tokensK: tokensLabel, pct: hasData ? Math.round(pct) : '--' })}</div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <span
        ref={wrapRef}
        className={styles['context-ring-wrap']}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button type="button"
          className={`${styles['context-ring']}${compacting ? ` ${styles.compacting}` : ''}`}
          data-yuan={yuan}
          onClick={handleClick}
          disabled={busy || !currentSessionPath}
          title={t('input.tokensUsed', { tokensK: tokensLabel, pct: hasData ? Math.round(pct) : '--' })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('input.contextActions')}
        >
          <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle cx={center} cy={center} r={r} fill="none" stroke="var(--ring-bg)" strokeWidth={sw} />
            <circle
              cx={center}
              cy={center}
              r={r}
              fill="none"
              stroke="var(--ring-fg)"
              strokeWidth={sw}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              transform={`rotate(-90 ${center} ${center})`}
              className={styles['context-ring-progress']}
            />
          </svg>
          {showTokenLabel && (
            <span className={styles['context-ring-label']}>{tokensLabel}k</span>
          )}
        </button>
        {tooltip}
      </span>
      <AnchoredPortal
        open={menuOpen}
        anchorRef={wrapRef}
        className={styles['context-ring-menu']}
        role="menu"
        align="end"
        offset={6}
        onClose={() => setMenuOpen(false)}
      >
        <Tooltip
          content={t('input.refreshAndCompactTooltip')}
          placement="left"
          align="center"
        >
          {({ ref, ...tooltipProps }) => (
            <button
              type="button"
              ref={ref}
              className={styles['context-ring-menu-item']}
              role="menuitem"
              onClick={handleRefreshAndCompact}
              disabled={busy}
              {...tooltipProps}
            >
              {t('input.refreshAndCompact')}
            </button>
          )}
        </Tooltip>
        <button
          type="button"
          className={styles['context-ring-menu-item']}
          role="menuitem"
          onClick={handleCompact}
          disabled={busy}
        >
          {t('input.compact')}
        </button>
      </AnchoredPortal>
    </>
  );
}
