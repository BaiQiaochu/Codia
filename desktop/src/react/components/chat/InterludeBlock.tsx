import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContentBlock } from '../../stores/chat-types';
import { buildAssistantBlocksFromContent } from '../../utils/assistant-block-builder';
import { MoodBlock } from './MoodBlock';
import { PluginCardBlock } from './PluginCardBlock';
import { StreamingMarkdownContent } from './StreamingMarkdownContent';
import { SubagentSessionPreview } from './SubagentSessionPreview';
import styles from './Chat.module.css';

type InterludeContentBlock = Extract<ContentBlock, { type: 'interlude' }>;

interface FloatingPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

function isPreviewEnabledViewport(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(max-width: 720px), (pointer: coarse)').matches;
}

function useInterludePreviewEnabled(): boolean {
  const [enabled, setEnabled] = useState(isPreviewEnabledViewport);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 720px), (pointer: coarse)');
    const update = () => setEnabled(!query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  return enabled;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function measurePopover(anchor: HTMLElement): FloatingPosition {
  const rect = anchor.getBoundingClientRect();
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 1024;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 768;
  const width = Math.min(Math.max(320, viewportW * 0.6), 640, Math.max(320, viewportW - 32));
  const maxHeight = Math.min(560, Math.max(220, viewportH * 0.72));
  const left = clamp(rect.left + rect.width / 2 - width / 2, 16, viewportW - width - 16);
  const belowTop = rect.bottom + 8;
  const top = belowTop + maxHeight <= viewportH - 16
    ? belowTop
    : Math.max(16, rect.top - maxHeight - 8);
  return { left, top, width, maxHeight };
}

function streamStatusFromInterlude(status: string | undefined): 'done' | 'failed' | 'aborted' {
  if (status === 'failed') return 'failed';
  if (status === 'aborted') return 'aborted';
  return 'done';
}

const InterludeDetailPreview = memo(function InterludeDetailPreview({ detailMarkdown }: { detailMarkdown: string }) {
  const blocks = useMemo(() => buildAssistantBlocksFromContent({
    content: detailMarkdown,
    includeTextSource: true,
  }), [detailMarkdown]);

  return (
    <div className={styles.interludePopoverMarkdown}>
      {blocks.map((previewBlock, index) => {
        if (previewBlock.type === 'mood') {
          return <MoodBlock key={`mood-${index}`} yuan={previewBlock.yuan} text={previewBlock.text} />;
        }
        if (previewBlock.type === 'text') {
          return <StreamingMarkdownContent key={`text-${index}`} html={previewBlock.html} source={previewBlock.source} active={false} />;
        }
        if (previewBlock.type === 'plugin_card') {
          return <PluginCardBlock key={`card-${index}`} card={previewBlock.card} />;
        }
        return null;
      })}
    </div>
  );
});

export const InterludeBlock = memo(function InterludeBlock({ block }: { block: InterludeContentBlock }) {
  const anchorRef = useRef<HTMLButtonElement | HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const previewEnabled = useInterludePreviewEnabled();
  const detailMarkdown = (block.detailMarkdown || '').trim();
  const previewSessionPath = typeof block.previewSessionPath === 'string' && block.previewSessionPath.trim()
    ? block.previewSessionPath
    : null;
  const canPreview = previewEnabled && (detailMarkdown.length > 0 || !!previewSessionPath);
  const [position, setPosition] = useState<FloatingPosition | null>(null);

  const setAnchor = useCallback((node: HTMLButtonElement | HTMLDivElement | null) => {
    anchorRef.current = node;
  }, []);

  const setPopover = useCallback((node: HTMLDivElement | null) => {
    popoverRef.current = node;
    scrollContainerRef.current = node;
  }, []);

  const close = useCallback(() => setPosition(null), []);

  const toggle = useCallback(() => {
    if (!canPreview || !anchorRef.current) return;
    setPosition(current => current ? null : measurePopover(anchorRef.current as HTMLElement));
  }, [canPreview]);

  useEffect(() => {
    if (!position) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [close, position]);

  useEffect(() => {
    if (!canPreview) setPosition(null);
  }, [canPreview]);

  const content = (
    <>
      <span className={styles.interludeLine} aria-hidden="true" />
      <span className={styles.interludeText}>{block.text}</span>
      <span className={styles.interludeLine} aria-hidden="true" />
    </>
  );

  return (
    <div className={styles.interludeRow} data-interlude-status={block.status || 'success'}>
      {canPreview ? (
        <button
          ref={setAnchor}
          type="button"
          className={`${styles.interludeTrigger} ${styles.interludeTriggerInteractive}`}
          aria-expanded={!!position}
          onClick={toggle}
        >
          {content}
        </button>
      ) : (
        <div ref={setAnchor} className={styles.interludeTrigger}>{content}</div>
      )}
      {position && createPortal(
        <div
          ref={setPopover}
          className={styles.interludePopover}
          style={{
            left: position.left,
            top: position.top,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          role="dialog"
        >
          {previewSessionPath && block.taskId ? (
            <SubagentSessionPreview
              taskId={block.taskId}
              sessionPath={previewSessionPath}
              agentId={block.previewAgentId || null}
              streamStatus={streamStatusFromInterlude(block.status)}
              summary={block.sourceLabel || null}
              scrollContainerRef={scrollContainerRef}
            />
          ) : (
            <InterludeDetailPreview detailMarkdown={detailMarkdown} />
          )}
        </div>,
        document.body,
      )}
    </div>
  );
});
