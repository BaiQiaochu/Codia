// The preview and main renderer share one authored nine-parameter loop.
import {
  CODIA_LOOP_SECONDS, CODIA_PARAMETER_IDS, sampleCodiaTimeline,
} from '../../../../desktop/src/react/live2d/timeline';

export const duration = CODIA_LOOP_SECONDS;
export const coreParameterIds = CODIA_PARAMETER_IDS;
export const sampleTimeline = sampleCodiaTimeline;
export const extraParameterIds = ['ParamAngleZ', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamHairSwing'] as const;
// Keep all thirteen controls and binding probes available for future authoring.
export const parameterIds = [...coreParameterIds, ...extraParameterIds] as const;
export type ParameterId = typeof parameterIds[number];
export function describePhase(seconds: number): string {
  const t = ((seconds % duration) + duration) % duration;
  if (t < 0.8 || t >= 8.8) return '藏在圆框下方';
  if (t < 1.4) return '左手抓框（画面右侧）';
  if (t < 2) return '右手抓框（画面左侧）';
  if (t < 2.8) return '双手固定，探头抬起';
  if (t < 6.8) return '左上、右上巡视两轮';
  if (t < 7.4) return '回到中间';
  return '下沉，右手、左手依次松开';
}
