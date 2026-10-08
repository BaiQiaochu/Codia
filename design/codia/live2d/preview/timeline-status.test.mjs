import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const { outputFiles } = await build({
  stdin: {
    contents: "export * from './timeline'; export * from './binding-status'; export { emptyValidation } from './validate-bindings';",
    resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts',
  },
  write: false, bundle: true, platform: 'node', format: 'esm', target: 'es2022',
});
const {
  sampleTimeline, parameterIds, coreParameterIds, extraParameterIds,
  coreBindingStatus, bindingStatusText, bindingSummaryText, emptyValidation,
} = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);

function report() {
  return {
    ...emptyValidation('checked'),
    parameters: parameterIds.map(id => ({
      id, status: coreParameterIds.includes(id) ? 'responsive' : 'no-change-detected',
      samples: [-1, 0, 1], changedDrawables: [], changedOffscreens: [], changes: [], responsiveContexts: [],
    })),
    summary: { responsive: 9, noChangeDetected: 4, missing: 0 },
  };
}

test('keeps thirteen debug parameters while automatically driving only nine', () => {
  assert.equal(parameterIds.length, 13);
  assert.equal(coreParameterIds.length, 9);
  assert.equal(extraParameterIds.length, 4);
  for (const time of [0, 1, 2, 3.5, 4.5, 5.5, 6.5, 8, 9]) {
    assert.deepEqual(Object.keys(sampleTimeline(time)), [...coreParameterIds]);
    for (const id of extraParameterIds) assert.equal(sampleTimeline(time)[id], undefined);
  }
  assert.deepEqual([3.5, 4.5, 5.5, 6.5].map(t => sampleTimeline(t).ParamAngleX), [-24, 24, -24, 24]);
  assert.equal(sampleTimeline(3.5).ParamAngleY, 18);
  assert.equal(sampleTimeline(3.5).ParamEyeBallX, -.65);
  assert.equal(sampleTimeline(4.5).ParamEyeBallX, .65);
  assert.equal(sampleTimeline(3.5).ParamEyeBallY, .5);
  assert.equal(sampleTimeline(4, true).ParamAngleX, 0);
  assert.equal(sampleTimeline(4, true).ParamAngleY, 0);
});

test('four unbound or missing extras do not block the nine-core response status', () => {
  const value = report();
  assert.equal(coreBindingStatus(value).ready, true);
  assert.match(bindingStatusText(value), /9 个核心动作参数有响应.*待视觉验收/);
  assert.doesNotMatch(bindingStatusText(value), /需补齐/);
  assert.match(bindingSummaryText(value), /核心动作参数：9\/9/);
  assert.match(bindingSummaryText(value), /扩展调试参数：0\/4.*不参与自动循环/);
  value.parameters = value.parameters.filter(item => coreParameterIds.includes(item.id));
  assert.equal(coreBindingStatus(value).ready, true);
});

test('a missing or inactive core parameter still blocks the core response status', () => {
  const value = report();
  value.parameters[0].status = 'no-change-detected';
  assert.equal(coreBindingStatus(value).ready, false);
  assert.deepEqual(coreBindingStatus(value).inactive, ['ParamBodyRise']);
  assert.match(bindingStatusText(value), /核心动作参数响应仍需补齐/);
  value.parameters.shift();
  assert.deepEqual(coreBindingStatus(value).missing, ['ParamBodyRise']);
  value.parameters = report().parameters;
  value.state = 'checking';
  assert.equal(coreBindingStatus(value).ready, false);
});
