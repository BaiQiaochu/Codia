export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface SessionConfirmationMenuPositionInput {
  anchorRect: RectLike;
  panelRect?: Partial<RectLike> | null;
  boundsRect?: RectLike | null;
  viewportWidth: number;
  viewportHeight: number;
  viewportPadding?: number;
  gap?: number;
}

export interface SessionConfirmationMenuPosition {
  top: number;
  left: number;
  maxWidth: number;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

export function calculateSessionConfirmationMenuPosition({
  anchorRect,
  panelRect,
  boundsRect = null,
  viewportWidth,
  viewportHeight,
  viewportPadding = 8,
  gap = 6,
}: SessionConfirmationMenuPositionInput): SessionConfirmationMenuPosition {
  const panelWidth = finitePositive(panelRect?.width, 160);
  const panelHeight = finitePositive(panelRect?.height, 36);
  const boundsLeft = boundsRect ? Math.max(viewportPadding, boundsRect.left + viewportPadding) : viewportPadding;
  const boundsRight = boundsRect
    ? Math.min(viewportWidth - viewportPadding, boundsRect.right - viewportPadding)
    : viewportWidth - viewportPadding;
  const availableWidth = Math.max(64, boundsRight - boundsLeft);
  const maxWidth = Math.min(panelWidth, availableWidth);
  const left = clamp(anchorRect.right - maxWidth, boundsLeft, boundsRight - maxWidth);

  const preferredTop = anchorRect.top - panelHeight - gap;
  const fallbackTop = Math.min(
    viewportHeight - panelHeight - viewportPadding,
    anchorRect.bottom + gap,
  );
  const top = Math.max(viewportPadding, preferredTop < viewportPadding ? fallbackTop : preferredTop);

  return { top, left, maxWidth };
}

export function getSessionConfirmationBoundsRect(anchor: HTMLElement): DOMRect | null {
  const boundary = anchor.closest('.codia-reader-chat, .input-area, .main-content, .channel-view');
  if (!(boundary instanceof HTMLElement)) return null;
  const rect = boundary.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}
