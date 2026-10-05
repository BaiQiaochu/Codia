const EDGE_WIDTH = 28;
const MIN_DISTANCE = 56;
const MAX_VERTICAL_DRIFT = 80;
const DOMINANCE = 1.25;

export type MobileEdge = 'left' | 'right';

export interface MobileEdgeGesture {
  edge: MobileEdge;
  startX: number;
  startY: number;
  cancelled: boolean;
}

export interface MobileEdgeGestureStartInput {
  clientX: number;
  clientY: number;
  viewportWidth: number;
  isNarrow: boolean;
  drawerOpen: boolean;
  targetIgnored: boolean;
}

export function startMobileEdgeGesture(input: MobileEdgeGestureStartInput): MobileEdgeGesture | null {
  if (!input.isNarrow || input.drawerOpen || input.targetIgnored || input.viewportWidth <= 0) return null;
  if (input.clientX <= EDGE_WIDTH) {
    return { edge: 'left', startX: input.clientX, startY: input.clientY, cancelled: false };
  }
  if (input.clientX >= input.viewportWidth - EDGE_WIDTH) {
    return { edge: 'right', startX: input.clientX, startY: input.clientY, cancelled: false };
  }
  return null;
}

export function updateMobileEdgeGesture(
  gesture: MobileEdgeGesture,
  clientX: number,
  clientY: number,
): { gesture: MobileEdgeGesture; shouldPreventDefault: boolean } {
  const dx = clientX - gesture.startX;
  const dy = clientY - gesture.startY;
  const horizontalDistance = gesture.edge === 'left' ? dx : -dx;
  const verticalDistance = Math.abs(dy);

  if (verticalDistance > 18 && verticalDistance > Math.abs(dx)) {
    return { gesture: { ...gesture, cancelled: true }, shouldPreventDefault: false };
  }

  return {
    gesture,
    shouldPreventDefault: horizontalDistance > 12 && horizontalDistance > verticalDistance * DOMINANCE,
  };
}

export function finishMobileEdgeGesture(
  gesture: MobileEdgeGesture,
  clientX: number,
  clientY: number,
): MobileEdge | null {
  if (gesture.cancelled) return null;
  const dx = clientX - gesture.startX;
  const dy = clientY - gesture.startY;
  const horizontalDistance = gesture.edge === 'left' ? dx : -dx;
  const verticalDistance = Math.abs(dy);
  const isDrawerSwipe = horizontalDistance >= MIN_DISTANCE
    && verticalDistance <= MAX_VERTICAL_DRIFT
    && horizontalDistance > verticalDistance * DOMINANCE;

  return isDrawerSwipe ? gesture.edge : null;
}
