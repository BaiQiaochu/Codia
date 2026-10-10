import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, WheelEvent as ReactWheelEvent } from 'react';
import { TimelineRailNavigator, type TimelineRailItem } from '../shared/TimelineRailNavigator';
import type { TimelineAnchor } from './timeline-anchors';

interface MarkerLayout {
  targetTop: number;
}

function markerLayoutsEqual(
  current: Record<string, MarkerLayout>,
  next: Record<string, MarkerLayout>,
): boolean {
  const currentIds = Object.keys(current);
  const nextIds = Object.keys(next);
  if (currentIds.length !== nextIds.length) return false;
  return nextIds.every(id => current[id]?.targetTop === next[id]?.targetTop);
}

function stablePixel(value: number): number {
  return Math.round(value * 2) / 2;
}

interface Props {
  anchors: TimelineAnchor[];
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  messageElementsRef: RefObject<Map<string, HTMLDivElement>>;
  active: boolean;
  railVisible?: boolean;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizedWheelDelta(event: ReactWheelEvent<HTMLElement>, pageSize: number): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * pageSize;
  return event.deltaY;
}

export const ChatTimelineNavigator = memo(function ChatTimelineNavigator({
  anchors,
  scrollRef,
  contentRef,
  messageElementsRef,
  active,
  railVisible = true,
}: Props) {
  const [layouts, setLayouts] = useState<Record<string, MarkerLayout>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const measureRafRef = useRef<number | null>(null);
  const shouldMeasure = active && anchors.length > 0;

  const measure = useCallback(() => {
    const panel = scrollRef.current;
    if (!panel || anchors.length === 0) {
      setLayouts(current => Object.keys(current).length === 0 ? current : {});
      setActiveId(current => current === null ? current : null);
      return;
    }

    const maxScroll = Math.max(0, finiteNumber(panel.scrollHeight) - finiteNumber(panel.clientHeight));
    const panelRect = panel.getBoundingClientRect();
    const panelTop = finiteNumber(panelRect.top);
    const panelScrollTop = finiteNumber(panel.scrollTop);
    const next: Record<string, MarkerLayout> = {};

    for (const anchor of anchors) {
      const element = messageElementsRef.current?.get(anchor.messageId);
      if (!element) continue;
      const rect = element.getBoundingClientRect();
      const targetTop = stablePixel(clamp(panelScrollTop + finiteNumber(rect.top) - panelTop - 16, 0, maxScroll));
      next[anchor.messageId] = { targetTop };
    }

    setLayouts(current => markerLayoutsEqual(current, next) ? current : next);
  }, [anchors, messageElementsRef, scrollRef]);

  const updateActive = useCallback(() => {
    const panel = scrollRef.current;
    if (!panel || anchors.length === 0) {
      setActiveId(current => current === null ? current : null);
      return;
    }

    const threshold = finiteNumber(panel.scrollTop) + 96;
    let nextId = anchors[0]?.messageId ?? null;
    for (const anchor of anchors) {
      const layout = layouts[anchor.messageId];
      if (!layout) continue;
      if (layout.targetTop <= threshold) {
        nextId = anchor.messageId;
      } else {
        break;
      }
    }
    setActiveId(current => current === nextId ? current : nextId);
  }, [anchors, layouts, scrollRef]);

  useLayoutEffect(() => {
    if (!shouldMeasure) {
      setLayouts(current => Object.keys(current).length === 0 ? current : {});
      setActiveId(current => current === null ? current : null);
      return;
    }
    measure();
  }, [measure, shouldMeasure]);

  useEffect(() => {
    const panel = scrollRef.current;
    if (!panel || !shouldMeasure) return;
    const content = contentRef.current;
    const ResizeObserverCtor = typeof ResizeObserver === 'function' ? ResizeObserver : null;
    if (!ResizeObserverCtor) {
      measure();
      return;
    }
    const scheduleMeasure = () => {
      if (measureRafRef.current != null) return;
      measureRafRef.current = window.requestAnimationFrame(() => {
        measureRafRef.current = null;
        measure();
      });
    };
    const observer = new ResizeObserverCtor(scheduleMeasure);
    observer.observe(panel);
    if (content) observer.observe(content);
    return () => {
      observer.disconnect();
      if (measureRafRef.current != null) {
        window.cancelAnimationFrame(measureRafRef.current);
        measureRafRef.current = null;
      }
    };
  }, [contentRef, measure, scrollRef, shouldMeasure]);

  useEffect(() => {
    const panel = scrollRef.current;
    if (!panel || !shouldMeasure) return;

    const schedule = () => {
      if (rafRef.current != null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        updateActive();
      });
    };

    updateActive();
    panel.addEventListener('scroll', schedule, { passive: true });
    return () => {
      panel.removeEventListener('scroll', schedule);
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [scrollRef, shouldMeasure, updateActive]);

  const jumpTo = useCallback((anchor: TimelineAnchor) => {
    const panel = scrollRef.current;
    const layout = layouts[anchor.messageId];
    if (!panel || !layout) return;
    panel.scrollTo({ top: layout.targetTop, behavior: 'smooth' });
  }, [layouts, scrollRef]);

  const handleTimelineWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    const panel = scrollRef.current;
    if (!panel) return;

    const maxScroll = Math.max(0, finiteNumber(panel.scrollHeight) - finiteNumber(panel.clientHeight));
    const deltaY = normalizedWheelDelta(event, finiteNumber(panel.clientHeight));
    if (deltaY === 0) return;

    event.preventDefault();
    event.stopPropagation();
    panel.scrollTop = clamp(panel.scrollTop + deltaY, 0, maxScroll);
  }, [scrollRef]);

  const renderedAnchors = useMemo(
    () => anchors.filter(anchor => layouts[anchor.messageId]),
    [anchors, layouts],
  );

  if (!active || anchors.length === 0) return null;

  const railItems: Array<TimelineRailItem<TimelineAnchor>> = renderedAnchors.map(anchor => ({
    id: anchor.messageId,
    label: anchor.label,
    markerWidthEm: anchor.markerWidthEm,
    payload: anchor,
  }));

  return (
    <TimelineRailNavigator
      items={railItems}
      active={active}
      activeId={activeId}
      railVisible={railVisible}
      ariaLabel={window.t?.('chat.timeline.navAriaLabel') || 'Turn navigation'}
      jumpLabel={item => (window.t?.('chat.timeline.jumpTo') || 'Jump to {label}').replace('{label}', item.label)}
      onJump={item => jumpTo(item.payload)}
      onWheel={handleTimelineWheel}
    />
  );
});
