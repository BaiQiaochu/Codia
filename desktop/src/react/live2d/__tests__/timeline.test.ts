import { describe, expect, it } from 'vitest';
import { CODIA_PARAMETER_IDS, sampleCodiaTimeline } from '../timeline';

describe('Codia authored parameter loop', () => {
  it('only drives the nine core parameters and holds a neutral raised reduced-motion pose', () => {
    expect(Object.keys(sampleCodiaTimeline(4))).toEqual([...CODIA_PARAMETER_IDS]);
    for (const time of [0, 1, 3, 6, 9]) {
      expect(sampleCodiaTimeline(time, true)).toEqual({
        ParamBodyRise: 1, ParamHandLReach: 1, ParamHandRReach: 1, ParamHandLGrip: 1, ParamHandRGrip: 1,
        ParamAngleX: 0, ParamAngleY: 0, ParamEyeBallX: 0, ParamEyeBallY: 0,
      });
    }
  });
  it('reaches left hand then right before body rise, looks left/right twice, then hides', () => {
    expect(sampleCodiaTimeline(1.4)).toMatchObject({ ParamHandLReach: 1, ParamBodyRise: 0 });
    expect(sampleCodiaTimeline(1.4).ParamHandRReach).toBeCloseTo(0);
    expect(sampleCodiaTimeline(2)).toMatchObject({ ParamHandLReach: 1, ParamHandRReach: 1, ParamBodyRise: 0 });
    expect([3.5, 4.5, 5.5, 6.5].map(time => sampleCodiaTimeline(time).ParamAngleX)).toEqual([-24, 24, -24, 24]);
    expect(sampleCodiaTimeline(3.5).ParamAngleY).toBe(18);
    expect(sampleCodiaTimeline(9)).toMatchObject({ ParamHandLReach: 0, ParamHandRReach: 0, ParamBodyRise: 0 });
    expect(sampleCodiaTimeline(11)).toEqual(sampleCodiaTimeline(1));
  });
  it('keeps the validated gaze range at ±.65 horizontally and 0…+.5 upward', () => {
    for (let time = 0; time < 10; time += .01) {
      const pose = sampleCodiaTimeline(time);
      expect(Math.abs(pose.ParamEyeBallX)).toBeLessThanOrEqual(.650001);
      expect(pose.ParamEyeBallY).toBeGreaterThanOrEqual(0);
      expect(pose.ParamEyeBallY).toBeLessThanOrEqual(.500001);
    }
  });
});
