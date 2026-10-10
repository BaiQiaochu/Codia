import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { cx } from './classnames';

export type CodiaThemeMode = 'inherit' | 'codia' | 'custom';

export const CODIA_THEME_IDS = [
  'codia-lilac',
  'warm-paper',
  'contemplation',
  'grass-aroma',
  'high-contrast',
  'midnight',
  'midnight-contrast',
  'absolutely',
  'delve',
  'deep-think',
  'new-warm-paper',
] as const;

export type CodiaThemeId = (typeof CODIA_THEME_IDS)[number];

export interface CodiaThemeTokens {
  bg?: string;
  bgCard?: string;
  accent?: string;
  accentHover?: string;
  accentLight?: string;
  text?: string;
  textLight?: string;
  textMuted?: string;
  border?: string;
  danger?: string;
  radiusInput?: string;
  radiusCard?: string;
  fontUi?: string;
  fontSerif?: string;
  fontMono?: string;
}

export const CODIA_BUILT_IN_THEMES: Record<CodiaThemeId, CodiaThemeTokens> = {
  'codia-lilac': {
    bg: '#F8F4FF',
    bgCard: '#FFFFFF',
    accent: '#A984E8',
    accentHover: '#8E6BD0',
    accentLight: 'rgba(169, 132, 232, 0.12)',
    text: '#342A45',
    textLight: '#655A76',
    textMuted: '#81768C',
    border: 'rgba(169, 132, 232, 0.25)',
    danger: '#A34F63',
  },
  'warm-paper': {
    bg: '#F8F5ED',
    bgCard: '#FCFAF5',
    accent: '#537D96',
    accentHover: '#456A80',
    accentLight: 'rgba(83, 125, 150, 0.08)',
    text: '#3B3D3F',
    textLight: '#6B6F73',
    textMuted: '#8E9196',
    border: 'rgba(83, 125, 150, 0.22)',
    danger: '#8B3A3A',
  },
  contemplation: {
    bg: '#F3F5F7',
    bgCard: '#F8F9FB',
    accent: '#7E99A8',
    accentHover: '#6B8594',
    accentLight: 'rgba(126, 153, 168, 0.08)',
    text: '#2C3238',
    textLight: '#5A6570',
    textMuted: '#869098',
    border: 'rgba(126, 153, 168, 0.22)',
    danger: '#8B4040',
  },
  'grass-aroma': {
    bg: '#F5F8F3',
    bgCard: '#F9FBF7',
    accent: '#5BA88C',
    accentHover: '#4D9179',
    accentLight: 'rgba(91, 168, 140, 0.08)',
    text: '#2E3832',
    textLight: '#5E6B63',
    textMuted: '#8A9490',
    border: 'rgba(91, 168, 140, 0.22)',
    danger: '#8B4A3A',
  },
  'high-contrast': {
    bg: '#FAF9F6',
    bgCard: '#FDFCFA',
    accent: '#3A6B85',
    accentHover: '#2E5870',
    accentLight: 'rgba(58, 107, 133, 0.08)',
    text: '#1A1C1E',
    textLight: '#4A4E52',
    textMuted: '#6B6F73',
    border: 'rgba(58, 107, 133, 0.28)',
    danger: '#7A3030',
  },
  midnight: {
    bg: '#3B4A54',
    bgCard: '#445560',
    accent: '#C99AAF',
    accentHover: '#D8AFC0',
    accentLight: 'rgba(201, 154, 175, 0.11)',
    text: '#E1EAF0',
    textLight: '#B7C5CE',
    textMuted: '#A3B5C0',
    border: 'rgba(170, 121, 141, 0.16)',
    danger: '#C77070',
  },
  'midnight-contrast': {
    bg: '#26343D',
    bgCard: '#30414B',
    accent: '#E6B1C4',
    accentHover: '#F0C4D3',
    accentLight: 'rgba(230, 177, 196, 0.14)',
    text: '#F0F6FA',
    textLight: '#D3E0E8',
    textMuted: '#B7C8D3',
    border: 'rgba(230, 177, 196, 0.26)',
    danger: '#E28B8B',
  },
  absolutely: {
    bg: '#F4F3EE',
    bgCard: '#FAF9F5',
    accent: '#B5846E',
    accentHover: '#A27460',
    accentLight: 'rgba(181, 132, 110, 0.08)',
    text: '#2D2B28',
    textLight: '#6B6864',
    textMuted: '#9B9793',
    border: 'rgba(177, 173, 161, 0.28)',
    danger: '#8B3A3A',
  },
  delve: {
    bg: '#FFFFFF',
    bgCard: '#F7F7F8',
    accent: '#1A1A1A',
    accentHover: '#000000',
    accentLight: 'rgba(0, 0, 0, 0.05)',
    text: '#1A1A1A',
    textLight: '#6E6E6E',
    textMuted: '#999999',
    border: 'rgba(0, 0, 0, 0.10)',
    danger: '#8B3A3A',
  },
  'deep-think': {
    bg: '#FCFCFD',
    bgCard: '#F8F8FA',
    accent: '#636AE8',
    accentHover: '#5158D4',
    accentLight: 'rgba(99, 106, 232, 0.06)',
    text: '#1D1D1F',
    textLight: '#65656B',
    textMuted: '#95959C',
    border: 'rgba(0, 0, 0, 0.09)',
    danger: '#8B3A3A',
  },
  'new-warm-paper': {
    bg: '#F5EFE4',
    bgCard: '#FBF7EE',
    accent: '#537D96',
    accentHover: '#3F6179',
    accentLight: 'rgba(83, 125, 150, 0.08)',
    text: '#2A2622',
    textLight: '#4A433C',
    textMuted: '#6B6158',
    border: '#D8CFBE',
    danger: '#8B2C1F',
  },
};

const TOKEN_TO_CSS_VAR: Record<keyof CodiaThemeTokens, string> = {
  bg: '--codia-plugin-bg',
  bgCard: '--codia-plugin-bg-card',
  accent: '--codia-plugin-accent',
  accentHover: '--codia-plugin-accent-hover',
  accentLight: '--codia-plugin-accent-light',
  text: '--codia-plugin-text',
  textLight: '--codia-plugin-text-light',
  textMuted: '--codia-plugin-text-muted',
  border: '--codia-plugin-border',
  danger: '--codia-plugin-danger',
  radiusInput: '--codia-plugin-radius-input',
  radiusCard: '--codia-plugin-radius-card',
  fontUi: '--codia-plugin-font-ui',
  fontSerif: '--codia-plugin-font-serif',
  fontMono: '--codia-plugin-font-mono',
};

type ThemeStyle = CSSProperties & Record<string, string>;

export interface CodiaThemeProviderProps extends HTMLAttributes<HTMLDivElement> {
  mode?: CodiaThemeMode;
  theme?: CodiaThemeId | CodiaThemeTokens;
  children?: ReactNode;
  'data-testid'?: string;
}

export function CodiaThemeProvider({
  mode = 'inherit',
  theme,
  className,
  style,
  children,
  'data-testid': dataTestId = 'codia-plugin-theme',
  ...rootProps
}: CodiaThemeProviderProps) {
  const themeId = typeof theme === 'string' ? theme : undefined;
  const tokenStyle = themeStyleFor(mode, theme);

  return (
    <div
      {...rootProps}
      data-testid={dataTestId}
      className={cx('codia-plugin-theme', className)}
      data-codia-theme-mode={mode}
      data-codia-theme={mode === 'codia' ? themeId : undefined}
      style={{ ...tokenStyle, ...style }}
    >
      {children}
    </div>
  );
}

export function themeStyleFor(mode: CodiaThemeMode, theme?: CodiaThemeId | CodiaThemeTokens): ThemeStyle {
  if (mode === 'inherit') return {};
  const tokens = resolveThemeTokens(mode, theme);
  const css: ThemeStyle = {};

  for (const [key, cssVar] of Object.entries(TOKEN_TO_CSS_VAR) as Array<[keyof CodiaThemeTokens, string]>) {
    const value = tokens?.[key];
    if (value) css[cssVar] = value;
  }

  return css;
}

function resolveThemeTokens(
  mode: CodiaThemeMode,
  theme?: CodiaThemeId | CodiaThemeTokens,
): CodiaThemeTokens | undefined {
  if (typeof theme === 'string') return CODIA_BUILT_IN_THEMES[theme];
  if (theme) return theme;
  if (mode === 'codia') return CODIA_BUILT_IN_THEMES['codia-lilac'];
  return undefined;
}
