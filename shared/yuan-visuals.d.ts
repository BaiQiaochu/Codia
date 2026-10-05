export interface YuanVisual {
  yuan: string;
  symbol: string;
  moodLabel: string;
  accent: string;
  avatar: string;
}

export const YUAN_VISUALS: Readonly<Record<string, Readonly<YuanVisual>>>;
export function normalizeYuan(yuan?: string | null): string;
export function getYuanVisual(yuan?: string | null): Readonly<YuanVisual>;
export function moodLabelForYuan(yuan?: string | null): string;
