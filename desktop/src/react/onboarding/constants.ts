/**
 * constants.ts — Onboarding wizard constants
 */

import registry from '../../shared/theme-registry';
import { API_PROVIDER_PRESETS } from '../utils/provider-presets';
import type { ProviderPreset } from '../utils/provider-presets';

export type { ProviderPreset } from '../utils/provider-presets';

export const AGENT_ID = 'codia';
export const TOTAL_STEPS = 7;

export const LOCALES = [
  { value: 'zh-CN', label: '\u7b80\u4f53\u4e2d\u6587' },
  { value: 'zh-TW', label: '\u7e41\u9ad4\u4e2d\u6587' },
  { value: 'ja',    label: '\u65e5\u672c\u8a9e' },
  { value: 'ko',    label: '\ud55c\uad6d\uc5b4' },
  { value: 'en',    label: 'English' },
] as const;

export const PROVIDER_PRESETS: ProviderPreset[] = [
  ...API_PROVIDER_PRESETS,
  { value: '_custom',     label: '',                     url: '',  api: 'openai-completions', custom: true },
];

export const OB_THEMES = registry.getThemeIds();

export function themeKey(id: string): string {
  return id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}
