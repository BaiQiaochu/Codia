import { useEffect, useRef, type RefObject } from 'react';

interface UseQuickChatAutoScrollOptions {
  expanded: boolean;
  isStreaming: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  sessionItems: readonly unknown[];
  sessionPath: string | null;
  threshold?: number;
}

export function isQuickChatNearBottom(scroller: HTMLElement, threshold = 48): boolean {
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - threshold;
}

export function useQuickChatAutoScroll({
  expanded,
  isStreaming,
  scrollRef,
  sessionItems,
  sessionPath,
  threshold = 48,
}: UseQuickChatAutoScrollOptions): void {
  const isNearBottomRef = useRef(true);
  const lastSessionPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastSessionPathRef.current === sessionPath) return;
    lastSessionPathRef.current = sessionPath;
    isNearBottomRef.current = true;
  }, [sessionPath]);

  useEffect(() => {
    if (expanded) return;
    isNearBottomRef.current = true;
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return undefined;
    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    const handleScroll = () => {
      isNearBottomRef.current = isQuickChatNearBottom(scroller, threshold);
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => scroller.removeEventListener('scroll', handleScroll);
  }, [expanded, scrollRef, threshold]);

  useEffect(() => {
    if (!expanded) return;
    const scroller = scrollRef.current;
    if (!scroller || !isNearBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [expanded, isStreaming, scrollRef, sessionItems, sessionPath]);
}
