import { describe, expect, it } from 'vitest';
import {
  displayPeakCountForWaveWidth,
  normalizePeaksForDisplay,
  resamplePeaksForDisplay,
} from '../../utils/audio-waveform';

describe('audio waveform display helpers', () => {
  it('compresses long persisted peaks into a bounded visible waveform', () => {
    const peaks = Array.from({ length: 96 }, (_, index) => (index % 24) / 23);

    const display = resamplePeaksForDisplay(peaks, 24);

    expect(display).toHaveLength(24);
    expect(Math.max(...display)).toBeCloseTo(1);
    expect(display.every((peak) => peak >= 0 && peak <= 1)).toBe(true);
  });

  it('interpolates short fallback peaks to the requested display length', () => {
    const display = resamplePeaksForDisplay([0.2, Number.NaN, 2, -1], 8);

    expect(display).toHaveLength(8);
    expect(display[0]).toBeCloseTo(0.2);
    expect(display[7]).toBeCloseTo(0);
    expect(Math.max(...display)).toBeGreaterThan(0.8);
  });

  it('computes display peak count from fixed bar width and fixed gap', () => {
    expect(displayPeakCountForWaveWidth(90, { barWidthPx: 3, barGapPx: 3 })).toBe(16);
    expect(displayPeakCountForWaveWidth(0, { fallback: 36 })).toBe(36);
  });

  it('normalizes quiet visible peaks so the loudest visible bar reaches full height', () => {
    const display = normalizePeaksForDisplay([0.02, 0.05, 0.1]);
    expect(display[0]).toBeCloseTo(0.2);
    expect(display[1]).toBeCloseTo(0.5);
    expect(display[2]).toBe(1);
  });
});
