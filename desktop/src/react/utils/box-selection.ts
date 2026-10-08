export interface SelectionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): SelectionRect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

export function rectsIntersect(a: SelectionRect, b: SelectionRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function hitTestMessages(
  box: SelectionRect,
  elements: ReadonlyArray<{ id: string; rect: SelectionRect }>,
): string[] {
  return elements.filter(element => rectsIntersect(box, element.rect)).map(element => element.id);
}

export function rangeIds(orderedIds: readonly string[], anchorId: string, targetId: string): string[] {
  const anchorIndex = orderedIds.indexOf(anchorId);
  const targetIndex = orderedIds.indexOf(targetId);
  if (anchorIndex < 0 || targetIndex < 0) return [];
  const [start, end] = anchorIndex <= targetIndex
    ? [anchorIndex, targetIndex]
    : [targetIndex, anchorIndex];
  return orderedIds.slice(start, end + 1);
}
