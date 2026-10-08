import type { CubismModel } from '@cubism/model/cubismmodel';

export type BindingStatus = 'responsive' | 'no-change-detected' | 'missing';
export interface ParameterValidation {
  id: string;
  status: BindingStatus;
  range?: { minimum: number; default: number; maximum: number };
  samples: number[];
  changedDrawables: string[];
  changedOffscreens?: string[];
  changes: string[];
  responsiveContexts: string[];
}
export interface BindingValidation {
  schemaVersion: 1;
  state: 'not-loaded' | 'checking' | 'checked' | 'error';
  method: 'drawable-output-at-min-default-max';
  contexts: string[];
  parameters: ParameterValidation[];
  summary: { responsive: number; noChangeDetected: number; missing: number };
  error?: string;
}
export const emptyValidation = (state: BindingValidation['state'] = 'not-loaded'): BindingValidation => ({
  schemaVersion: 1, state, method: 'drawable-output-at-min-default-max',
  contexts: [], parameters: [], summary: { responsive: 0, noChangeDetected: 0, missing: 0 },
});

const epsilon = 0.00001;
type DrawableState = {
  vertices: Float32Array; opacity: number; visible: boolean; color: number[]; order: number;
};
type OffscreenState = {
  owner: string; opacity: number; color: number[]; order: number; masks: number[];
};
function captureOffscreens(model: CubismModel): OffscreenState[] {
  // Legacy model fixtures do not expose offscreen methods; SDK 5-r.5 does.
  const count = model.getOffscreenCount?.() ?? 0;
  if (!count) return [];
  const orders = model.getRenderOrders();
  const owners = model.getOffscreenOwnerIndices();
  const masks = model.getOffscreenMasks(), maskCounts = model.getOffscreenMaskCounts();
  return Array.from({ length: count }, (_, index) => {
    const multiply = model.getOffscreenMultiplyColor(index);
    const screen = model.getOffscreenScreenColor(index);
    return {
      owner: model.getPartId(owners[index]).getString(),
      opacity: model.getOffscreenOpacity(index),
      color: [multiply.r, multiply.g, multiply.b, multiply.a, screen.r, screen.g, screen.b],
      order: orders[model.getDrawableCount() + index],
      masks: Array.from(masks[index] ?? []).slice(0, maskCounts[index]),
    };
  });
}
function capture(model: CubismModel): DrawableState[] {
  const orders = model.getRenderOrders();
  return Array.from({ length: model.getDrawableCount() }, (_, index) => {
    const multiply = model.getDrawableMultiplyColor(index);
    const screen = model.getDrawableScreenColor(index);
    return {
      // Core returns mutable views; each sample must own its vertex data.
      vertices: model.getDrawableVertexPositions(index).slice(),
      opacity: model.getDrawableOpacity(index),
      visible: model.getDrawableDynamicFlagIsVisible(index),
      color: [multiply.r, multiply.g, multiply.b, multiply.a, screen.r, screen.g, screen.b],
      order: orders[index],
    };
  });
}
const differs = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length !== b.length || Array.from(a).some((value, index) => Math.abs(value - b[index]) > epsilon);

/** Probe only once after loading the real model, before starting animation. */
export function validateBindings(
  model: CubismModel,
  requiredIds: readonly string[],
  staticPose: Record<string, number>,
): BindingValidation {
  const report = emptyValidation('checking');
  const count = model.getParameterCount();
  const indices = new Map(Array.from({ length: count }, (_, index) => [model.getParameterId(index).getString(), index]));
  const original = Array.from({ length: count }, (_, index) => model.getParameterValueByIndex(index));
  const defaults = Array.from({ length: count }, (_, index) => model.getParameterDefaultValue(index));
  const partOpacities = Array.from({ length: model.getPartCount() }, (_, index) => model.getPartOpacityByIndex(index));
  const restoreValues = (values: number[]) => {
    values.forEach((value, index) => model.setParameterValueByIndex(index, value));
    partOpacities.forEach((value, index) => model.setPartOpacityByIndex(index, value));
  };
  // A default hidden body can conceal correctly bound face parameters. Also probe
  // the same neutral, raised pose used by the reduced-motion presentation.
  const raised = defaults.slice();
  for (const [id, value] of Object.entries(staticPose)) {
    const index = indices.get(id);
    if (index !== undefined) raised[index] = value;
  }
  const contexts = [{ name: 'model-default', values: defaults }, { name: 'static-visible-pose', values: raised }];
  report.contexts = contexts.map(context => context.name);
  try {
    for (const id of requiredIds) {
      const index = indices.get(id);
      const result: ParameterValidation = {
        id, status: 'missing', samples: [], changedDrawables: [], changedOffscreens: [], changes: [], responsiveContexts: [],
      };
      report.parameters.push(result);
      if (index === undefined) continue; // Never call getParameterIndex: it creates absent IDs.
      result.range = {
        minimum: model.getParameterMinimumValue(index),
        default: model.getParameterDefaultValue(index),
        maximum: model.getParameterMaximumValue(index),
      };
      result.samples = [...new Set(Object.values(result.range))];
      if (!result.samples.every(Number.isFinite)) throw new Error(`参数 ${id} 的范围含非有限数值。`);
      result.status = 'no-change-detected';
      const changed = new Set<string>();
      const changedOffscreens = new Set<string>();
      const changes = new Set<string>();
      for (const context of contexts) {
        let baseline: DrawableState[] | undefined;
        let baselineOffscreens: OffscreenState[] = [];
        let contextChanged = false;
        for (const value of result.samples) {
          restoreValues(context.values);
          model.setParameterValueByIndex(index, value);
          model.update();
          const current = capture(model);
          const offscreens = captureOffscreens(model);
          if (!baseline) { baseline = current; baselineOffscreens = offscreens; continue; }
          const isVisible = (state: DrawableState) => state.visible && state.opacity > epsilon;
          const masks = model.getDrawableMasks();
          const maskCounts = model.getDrawableMaskCounts();
          const activeMasks = new Set<number>();
          current.forEach((state, target) => {
            if (isVisible(state) || isVisible(baseline![target])) {
              Array.from(masks[target] ?? []).slice(0, maskCounts[target]).forEach(mask => activeMasks.add(mask));
            }
          });
          // A mask used solely by HeadGroup Offscreen is not present in any
          // drawable's mask list. Include it while either group pose is visible.
          offscreens.forEach((state, target) => {
            const before = baselineOffscreens[target];
            if (state.opacity > epsilon || before.opacity > epsilon) {
              [...state.masks, ...before.masks].forEach(mask => activeMasks.add(mask));
            }
          });
          for (let drawable = 0; drawable < current.length; drawable++) {
            const a = baseline[drawable];
            const b = current[drawable];
            // Ignore fully invisible meshes, except masks used by visible meshes.
            if (!isVisible(a) && !isVisible(b) && !activeMasks.has(drawable)) continue;
            const effects = [
              differs(a.vertices, b.vertices) && 'vertices',
              Math.abs(a.opacity - b.opacity) > epsilon && 'opacity',
              a.visible !== b.visible && 'visibility',
              differs(a.color, b.color) && 'color',
              a.order !== b.order && 'draw-order',
            ].filter(Boolean) as string[];
            if (!effects.length) continue;
            changed.add(model.getDrawableId(drawable).getString());
            effects.forEach(effect => changes.add(effect));
            contextChanged = true;
          }
          offscreens.forEach((b, target) => {
            const a = baselineOffscreens[target];
            if (a.opacity <= epsilon && b.opacity <= epsilon) return;
            const effects = [
              Math.abs(a.opacity - b.opacity) > epsilon && 'offscreen-opacity',
              differs(a.color, b.color) && 'offscreen-color',
              a.order !== b.order && 'offscreen-order',
            ].filter(Boolean) as string[];
            if (!effects.length) return;
            changedOffscreens.add(b.owner);
            effects.forEach(effect => changes.add(effect));
            contextChanged = true;
          });
        }
        if (contextChanged) result.responsiveContexts.push(context.name);
      }
      result.changedDrawables = [...changed];
      result.changedOffscreens = [...changedOffscreens];
      result.changes = [...changes];
      if (changed.size || changedOffscreens.size) result.status = 'responsive';
    }
    report.state = 'checked';
    report.summary = {
      responsive: report.parameters.filter(item => item.status === 'responsive').length,
      noChangeDetected: report.parameters.filter(item => item.status === 'no-change-detected').length,
      missing: report.parameters.filter(item => item.status === 'missing').length,
    };
    return report;
  } finally {
    // Leave savedParameters untouched; restore all actual values, part opacities,
    // and recompute drawables even if a sample fails. No animation clock is advanced.
    restoreValues(original);
    model.update();
  }
}
