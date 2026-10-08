import type { CSSProperties } from 'react';

interface FixedDropdownPositionOptions {
  gap?: number;
  viewportPad?: number;
  width?: number;
  minWidth?: number;
  widthOffset?: number;
  preferredMaxHeight?: number;
  minHeight?: number;
  flipThreshold?: number;
  zIndex?: number;
}

const clamp = (value: number, min: number, max: number) => (
  Math.min(Math.max(value, min), max)
);

export function computeFixedDropdownStyle(
  trigger: HTMLElement,
  panel: HTMLElement | null | undefined,
  options: FixedDropdownPositionOptions = {},
): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const gap = options.gap ?? 4;
  const viewportPad = options.viewportPad ?? 8;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  const minWidth = options.minWidth ?? Math.max(rect.width, 180);
  const maxWidth = Math.max(minWidth, viewportWidth - viewportPad * 2);
  const width = clamp(options.width ?? rect.width + (options.widthOffset ?? 0), minWidth, maxWidth);
  const left = clamp(rect.left, viewportPad, Math.max(viewportPad, viewportWidth - width - viewportPad));

  const preferredMaxHeight = options.preferredMaxHeight ?? 320;
  const minHeight = Math.min(options.minHeight ?? 120, preferredMaxHeight);
  const spaceBelow = viewportHeight - rect.bottom - viewportPad - gap;
  const spaceAbove = rect.top - viewportPad - gap;
  const flipThreshold = options.flipThreshold ?? Math.min(preferredMaxHeight, 220);
  const openAbove = spaceBelow < flipThreshold && spaceAbove > spaceBelow;
  const availableHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
  const maxHeight = Math.max(
    Math.min(minHeight, preferredMaxHeight),
    Math.min(preferredMaxHeight, availableHeight || preferredMaxHeight),
  );

  const measuredHeight = panel?.getBoundingClientRect().height || 0;
  const panelHeight = measuredHeight > 0 ? Math.min(measuredHeight, maxHeight) : maxHeight;
  const top = openAbove
    ? rect.top - gap - panelHeight
    : rect.bottom + gap;
  const maxTop = Math.max(viewportPad, viewportHeight - viewportPad - panelHeight);

  return {
    position: 'fixed',
    left,
    top: clamp(top, viewportPad, maxTop),
    bottom: 'auto',
    width,
    maxHeight,
    zIndex: options.zIndex ?? 9999,
  };
}

export function addFixedDropdownPositionListeners(update: () => void): () => void {
  window.addEventListener('resize', update);
  window.addEventListener('scroll', update, true);

  const visualViewport = window.visualViewport;
  visualViewport?.addEventListener('resize', update);
  visualViewport?.addEventListener('scroll', update);

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('scroll', update, true);
    visualViewport?.removeEventListener('resize', update);
    visualViewport?.removeEventListener('scroll', update);
  };
}
