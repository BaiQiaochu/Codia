import { describe, expect, it } from 'vitest';
import {
  hitTestMessages,
  rangeIds,
  rectFromPoints,
  rectsIntersect,
  type SelectionRect,
} from '../desktop/src/react/utils/box-selection';

describe('box selection geometry', () => {
  it('normalizes drag points regardless of direction', () => {
    expect(rectFromPoints(30, 40, 10, 20)).toEqual({ left: 10, top: 20, right: 30, bottom: 40 });
  });

  it('treats overlapping rectangles as hits and edge-only contact as a miss', () => {
    const rect: SelectionRect = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(rectsIntersect(rect, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(true);
    expect(rectsIntersect(rect, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(false);
  });

  it('returns message ids in input order when hit by the selection box', () => {
    const box: SelectionRect = { left: 0, top: 0, right: 100, bottom: 50 };
    expect(hitTestMessages(box, [
      { id: 'a', rect: { left: 10, top: 10, right: 90, bottom: 40 } },
      { id: 'b', rect: { left: 10, top: 60, right: 90, bottom: 80 } },
      { id: 'c', rect: { left: 10, top: 45, right: 90, bottom: 70 } },
    ])).toEqual(['a', 'c']);
  });

  it('builds inclusive shift ranges in either direction', () => {
    const ordered = ['m1', 'm2', 'm3', 'm4'];
    expect(rangeIds(ordered, 'm2', 'm4')).toEqual(['m2', 'm3', 'm4']);
    expect(rangeIds(ordered, 'm4', 'm2')).toEqual(['m2', 'm3', 'm4']);
    expect(rangeIds(ordered, 'missing', 'm2')).toEqual([]);
  });
});
