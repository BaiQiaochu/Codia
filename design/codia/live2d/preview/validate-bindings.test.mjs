import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const source = await readFile(new URL('./validate-bindings.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
const { validateBindings } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function fixture() {
  const ids = ['rise', 'move', 'unused', 'alpha', 'hidden', 'mask'];
  const values = [0.6, 0.25, 0.4, 0.75, -0.3, 0.2];
  const initial = values.slice();
  const defaults = [0, 0, 0, 1, 0, 0];
  const parts = [0.5];
  const vertices = [new Float32Array(6), new Float32Array(6), new Float32Array(6)];
  let opacity = 0;
  let updates = 0;
  let failAt = -1;
  const model = {
    getParameterCount: () => ids.length,
    getParameterId: index => ({ getString: () => ids[index] }),
    getParameterIndex: () => { throw new Error('Absent IDs must never be registered.'); },
    getParameterValueByIndex: index => values[index],
    getParameterMinimumValue: index => index === 0 || index === 3 ? 0 : -1,
    getParameterDefaultValue: index => defaults[index],
    getParameterMaximumValue: () => 1,
    setParameterValueByIndex: (index, value) => { values[index] = value; },
    getPartCount: () => 1,
    getPartOpacityByIndex: index => parts[index],
    setPartOpacityByIndex: (index, value) => { parts[index] = value; },
    getDrawableCount: () => 3,
    getDrawableId: index => ({ getString: () => `Mesh${index}` }),
    getDrawableVertexPositions: index => vertices[index],
    getDrawableOpacity: index => index === 0 ? opacity : 0,
    getDrawableDynamicFlagIsVisible: index => index === 0 && opacity > 0,
    getDrawableMultiplyColor: () => ({ r: 1, g: 1, b: 1, a: 1 }),
    getDrawableScreenColor: () => ({ r: 0, g: 0, b: 0, a: 0 }),
    getRenderOrders: () => new Int32Array([0, 1, 2]),
    getDrawableMasks: () => [new Int32Array([2]), new Int32Array(), new Int32Array()],
    getDrawableMaskCounts: () => new Int32Array([1, 0, 0]),
    update: () => {
      updates++;
      if (updates === failAt) throw new Error('sample failure');
      opacity = values[0] * values[3];
      vertices[0][0] = values[0] > 0.5 ? values[1] : 0;
      vertices[1][0] = values[4];
      vertices[2][0] = values[5];
    },
  };
  model.update();
  return { model, ids, values, initial, parts, vertices, get opacity() { return opacity; },
    failNextSample: () => { failAt = updates + 2; } };
}

test('distinguishes actual responses, unbound IDs, hidden meshes and missing parameters', () => {
  const f = fixture();
  const report = validateBindings(f.model, [...f.ids, 'missing'], { rise: 1 });
  assert.equal(report.state, 'checked');
  const results = Object.fromEntries(report.parameters.map(value => [value.id, value]));
  for (const id of ['rise', 'move', 'alpha', 'mask']) assert.equal(results[id].status, 'responsive', id);
  for (const id of ['unused', 'hidden']) assert.equal(results[id].status, 'no-change-detected', id);
  assert.equal(results.missing.status, 'missing');
  assert.deepEqual(results.move.responsiveContexts, ['static-visible-pose']);
  assert.deepEqual(results.move.changedDrawables, ['Mesh0']);
  assert.ok(results.alpha.changes.includes('opacity'));
  assert.deepEqual(results.mask.changedDrawables, ['Mesh2']);
  assert.deepEqual(report.summary, { responsive: 4, noChangeDetected: 2, missing: 1 });
  assert.deepEqual(f.values, f.initial);
  assert.deepEqual(f.parts, [0.5]);
  assert.equal(f.opacity, f.initial[0] * f.initial[3]);
  assert.equal(f.vertices[0][0], f.initial[1]);
});

test('restores actual parameters and computed drawables if a sample throws', () => {
  const f = fixture();
  f.failNextSample();
  assert.throws(() => validateBindings(f.model, f.ids, { rise: 1 }), /sample failure/);
  assert.deepEqual(f.values, f.initial);
  assert.deepEqual(f.parts, [0.5]);
  assert.equal(f.opacity, f.initial[0] * f.initial[3]);
  assert.equal(f.vertices[0][0], f.initial[1]);
});

test('an exported but unused parameter does not become responsive merely by existing', () => {
  const f = fixture();
  const report = validateBindings(f.model, ['unused'], { rise: 1 });
  assert.deepEqual(report.summary, { responsive: 0, noChangeDetected: 1, missing: 0 });
  assert.deepEqual(report.parameters[0].samples, [-1, 0, 1]);
  assert.deepEqual(report.parameters[0].changedDrawables, []);
});
