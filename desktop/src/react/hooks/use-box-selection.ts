import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { useStore } from '../stores';
import { selectSelectedIdsBySession } from '../stores/session-selectors';
import { hitTestMessages, rangeIds, rectFromPoints, type SelectionRect } from '../utils/box-selection';

interface Params {
  messageElementsRef: RefObject<Map<string, HTMLDivElement>>;
  orderedIds: string[];
  sessionPath: string;
  active: boolean;
}

const DRAG_THRESHOLD = 3;

export function useBoxSelection({ messageElementsRef, orderedIds, sessionPath, active }: Params) {
  const setMessageSelection = useStore(s => s.setMessageSelection);
  const addMessagesToSelection = useStore(s => s.addMessagesToSelection);
  const toggleMessageSelection = useStore(s => s.toggleMessageSelection);
  const clearSelection = useStore(s => s.clearSelection);
  const selectionActive = useStore(s => selectSelectedIdsBySession(s, sessionPath).length > 0);

  const enabled = useMemo(
    () => typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: fine)').matches,
    [],
  );

  const [box, setBox] = useState<SelectionRect | null>(null);
  const dragRef = useRef<{ x0: number; y0: number; base: string[]; moved: boolean } | null>(null);
  const rafRef = useRef<number | null>(null);
  const justDraggedRef = useRef(false);
  const anchorRef = useRef<string | null>(null);

  const computeHit = useCallback((rect: SelectionRect): string[] => {
    const elements: Array<{ id: string; rect: SelectionRect }> = [];
    messageElementsRef.current?.forEach((element, id) => {
      elements.push({ id, rect: element.getBoundingClientRect() });
    });
    return hitTestMessages(rect, elements);
  }, [messageElementsRef]);

  useEffect(() => {
    if (!enabled) return undefined;
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (
        !drag.moved
        && (Math.abs(event.clientX - drag.x0) > DRAG_THRESHOLD
          || Math.abs(event.clientY - drag.y0) > DRAG_THRESHOLD)
      ) {
        drag.moved = true;
      }
      if (!drag.moved) return;

      const rect = rectFromPoints(drag.x0, drag.y0, event.clientX, event.clientY);
      setBox(rect);
      if (rafRef.current !== null) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const hit = computeHit(rect);
        setMessageSelection(sessionPath, Array.from(new Set([...drag.base, ...hit])));
        if (hit.length > 0) anchorRef.current = hit[hit.length - 1];
      });
    };

    const onUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setBox(null);
      if (!drag?.moved) return;
      const finalRect = rectFromPoints(drag.x0, drag.y0, event.clientX, event.clientY);
      const hit = computeHit(finalRect);
      setMessageSelection(sessionPath, Array.from(new Set([...drag.base, ...hit])));
      if (hit.length > 0) anchorRef.current = hit[hit.length - 1];
      justDraggedRef.current = true;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [computeHit, enabled, sessionPath, setMessageSelection]);

  useEffect(() => {
    if (!enabled || !active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (selectSelectedIdsBySession(useStore.getState(), sessionPath).length > 0) {
        clearSelection(sessionPath);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, clearSelection, enabled, sessionPath]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-message-id]')) return;
    const current = selectSelectedIdsBySession(useStore.getState(), sessionPath);
    dragRef.current = {
      x0: event.clientX,
      y0: event.clientY,
      base: event.shiftKey ? [...current] : [],
      moved: false,
    };
  }, [enabled, sessionPath]);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!enabled) return;
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    const hasSelection = selectSelectedIdsBySession(useStore.getState(), sessionPath).length > 0;
    if (!hasSelection) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-message-actions]')) return;
    const group = target.closest('[data-message-id]') as HTMLElement | null;
    if (!group) return;
    const id = group.getAttribute('data-message-id');
    if (!id) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey && anchorRef.current) {
      addMessagesToSelection(sessionPath, rangeIds(orderedIds, anchorRef.current, id));
    } else {
      toggleMessageSelection(sessionPath, id);
      anchorRef.current = id;
    }
  }, [addMessagesToSelection, enabled, orderedIds, sessionPath, toggleMessageSelection]);

  return {
    box: enabled ? box : null,
    selectionModeActive: enabled && (selectionActive || box !== null),
    onPointerDown,
    onClickCapture,
  };
}
