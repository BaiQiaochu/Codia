import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('./debug.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { manualPose, modelToViewport, viewportToModel } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const matrix = (sx, sy, tx, ty) => [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1];

test('contact coordinates round-trip through the actual model scale and translation', () => {
  const transform = matrix(2, 2, 0.2, -0.4);
  const inverse = matrix(0.5, 0.5, -0.1, 0.2);
  const point = { x: 0.25, y: -0.1 };
  const projected = modelToViewport(point, transform);
  assert.deepEqual(projected, { x: 0.85, y: 0.8 });
  const restored = viewportToModel(projected, inverse);
  assert.ok(Math.abs(restored.x - point.x) < 1e-10);
  assert.ok(Math.abs(restored.y - point.y) < 1e-10);
});

test('viewport conversion respects the top-left screen origin without relying on source pixel size', () => {
  const identity = matrix(1, 1, 0, 0);
  assert.deepEqual(modelToViewport({ x: -1, y: 1 }, identity), { x: 0, y: 0 });
  assert.deepEqual(viewportToModel({ x: 1, y: 1 }, identity), { x: 1, y: -1 });
});

test('manual poses retain actual IDs, current values and clamped defaults without mutation', () => {
  const ids = ['body', 'hand'];
  const values = [0.25, 0.75];
  const model = {
    getParameterCount: () => 2,
    getParameterId: index => ({ getString: () => ids[index] }),
    getParameterValueByIndex: index => values[index],
    getParameterDefaultValue: () => 0,
    getParameterMinimumValue: () => 0,
    getParameterMaximumValue: () => 1,
  };
  assert.deepEqual(Object.fromEntries(manualPose(model)), { body: 0.25, hand: 0.75 });
  assert.deepEqual(Object.fromEntries(manualPose(model, true)), { body: 0, hand: 0 });
  assert.deepEqual(Object.fromEntries(manualPose(model, true, { hand: 3, absent: 1 })), { body: 0, hand: 1 });
  assert.deepEqual(values, [0.25, 0.75]);
});
