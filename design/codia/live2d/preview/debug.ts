import type { CubismModel } from '@cubism/model/cubismmodel';

export type Point = { x: number; y: number };
export function transformPoint(point: Point, matrix: ArrayLike<number>): Point {
  const w = matrix[3] * point.x + matrix[7] * point.y + matrix[15];
  return {
    x: (matrix[0] * point.x + matrix[4] * point.y + matrix[12]) / w,
    y: (matrix[1] * point.x + matrix[5] * point.y + matrix[13]) / w,
  };
}
export function modelToViewport(point: Point, matrix: ArrayLike<number>): Point {
  const projected = transformPoint(point, matrix);
  return { x: (projected.x + 1) / 2, y: (1 - projected.y) / 2 };
}
export function viewportToModel(point: Point, inverseMatrix: ArrayLike<number>): Point {
  return transformPoint({ x: point.x * 2 - 1, y: 1 - point.y * 2 }, inverseMatrix);
}
/** Snapshot actual IDs only. Overrides never create Cubism's virtual parameters. */
export function manualPose(model: CubismModel, defaults = false, overrides: Record<string, number> = {}): Map<string, number> {
  return new Map(Array.from({ length: model.getParameterCount() }, (_, index) => {
    const id = model.getParameterId(index).getString();
    const value = overrides[id] ?? (defaults ? model.getParameterDefaultValue(index) : model.getParameterValueByIndex(index));
    return [id, Math.min(model.getParameterMaximumValue(index), Math.max(model.getParameterMinimumValue(index), value))];
  }));
}
