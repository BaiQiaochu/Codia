// Drive only the nine parameters verified in the Codia rig. In particular there
// is no blink, hair or Z-axis driver until those keyforms are actually authored.
export const CODIA_LOOP_SECONDS = 10;
export const CODIA_PARAMETER_IDS = [
  'ParamBodyRise', 'ParamHandLReach', 'ParamHandRReach', 'ParamHandLGrip', 'ParamHandRGrip',
  'ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY',
] as const;
export type CodiaParameter = typeof CODIA_PARAMETER_IDS[number];
type Key = readonly [number, number];
function curve(time: number, keys: readonly Key[]): number {
  for (let index = 1; index < keys.length; index++) {
    if (time > keys[index][0]) continue;
    const [start, from] = keys[index - 1];
    const [end, to] = keys[index];
    const t = Math.max(0, (time - start) / (end - start));
    return from + (to - from) * t * t * (3 - 2 * t);
  }
  return keys[keys.length - 1][1];
}
const head: readonly Key[] = [
  [0, 0], [2.8, 0], [3.25, -24], [3.6, -24], [4.25, 24], [4.6, 24],
  [5.25, -24], [5.6, -24], [6.25, 24], [6.5, 24], [6.8, 0], [10, 0],
];
export function sampleCodiaTimeline(seconds: number, reducedMotion = false): Record<CodiaParameter, number> {
  const time = reducedMotion ? 7 : ((seconds % CODIA_LOOP_SECONDS) + CODIA_LOOP_SECONDS) % CODIA_LOOP_SECONDS;
  const up = curve(time, [[0, 0], [2.8, 0], [3.2, 18], [6.5, 18], [6.8, 0], [10, 0]]);
  return {
    ParamBodyRise: curve(time, [[0, 0], [2, 0], [2.8, 1], [7.4, 1], [8.3, 0], [10, 0]]),
    ParamHandLReach: curve(time, [[0, 0], [.8, 0], [1.4, 1], [8.45, 1], [8.8, 0], [10, 0]]),
    ParamHandRReach: curve(time, [[0, 0], [1.4, 0], [2, 1], [8.1, 1], [8.5, 0], [10, 0]]),
    ParamHandLGrip: curve(time, [[0, 0], [1.1, 0], [1.4, 1], [8.3, 1], [8.55, 0], [10, 0]]),
    ParamHandRGrip: curve(time, [[0, 0], [1.7, 0], [2, 1], [8, 1], [8.25, 0], [10, 0]]),
    ParamAngleX: curve(time, head), ParamAngleY: up,
    ParamEyeBallX: curve(Math.min(time + .09, CODIA_LOOP_SECONDS), head) / 24 * .65,
    ParamEyeBallY: up / 36,
  };
}
