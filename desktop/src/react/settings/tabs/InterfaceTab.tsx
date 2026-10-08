import React, { useMemo } from 'react';
import { useSettingsStore } from '../store';
import { t, VALID_THEMES, autoSaveConfig } from '../helpers';
import { gsapFetch } from '../api';
import { SelectWidget } from '../widgets/SelectWidget';
import { Toggle } from '../widgets/Toggle';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { NumberInput } from '../components/NumberInput';
import { SettingsButton } from '../components/SettingsButton';
import { StepSlider, type StepSliderOption } from '../components/StepSlider';
import {
  applyChatLayout,
  mergeChatLayout,
  normalizeChatLayout,
  type ChatBodyFontSizeOffset,
  type ChatLayoutContentWidth,
  type ChatLayoutPreferences,
} from '../../chat/layout';
import {
  applyEditorTypography,
  mergeEditorTypography,
  normalizeEditorTypography,
  type EditorMarkdownContentWidth,
  type EditorMarkdownTypography,
} from '../../editor/typography';
import { persistAppearancePreferences, type SyncedAppearancePreferences } from '../../services/appearance-sync';
import {
  FOLLOW_READING_FONT_ID,
  READING_FONT_PRESETS,
  normalizeFontSelectionId,
} from '../../utils/font-presets';
import styles from '../Settings.module.css';
import registry from '../../../shared/theme-registry';
import {
  normalizeSidebarUiPrefs,
  type SidebarSessionListRowMode,
  type SidebarUiPrefs,
} from '../../../../../shared/sidebar-ui-state.ts';

const i18n = window.i18n;

function tx(key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

const THEME_NAME_KEYS: Record<string, string> = Object.fromEntries([
  ...Object.entries(registry.THEMES).map(([id, theme]) => [id, theme.i18nName]),
  [registry.AUTO_OPTION.id, registry.AUTO_OPTION.i18nName],
]);

const THEME_MODE_KEYS: Record<string, string> = Object.fromEntries([
  ...Object.entries(registry.THEMES).map(([id, theme]) => [id, theme.i18nMode]),
  [registry.AUTO_OPTION.id, registry.AUTO_OPTION.i18nMode],
]);

const THEME_OVERRIDES_KEY = 'gsap-theme-overrides';
const VOICE_RECORD_SHORTCUT_MAC = ['⌘', '⇧', 'M'];
const VOICE_RECORD_SHORTCUT_DEFAULT = ['Ctrl', 'Shift', 'M'];

type ThemeOverrides = {
  accent?: string;
  radius?: number;
};

type Rgb = { r: number; g: number; b: number };
type ThemePreviewPalette = {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
};

function fallbackThemeName(themeId: string): string {
  return themeId
    .split('-')
    .map((part) => {
      if (part.toLowerCase() === 'ide') return 'IDE';
      return part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part;
    })
    .join(' ');
}

const THEME_FALLBACK_NAMES: Record<string, string> = Object.fromEntries([
  ...registry.getThemeIds().map((themeId) => [
    themeId,
    fallbackThemeName(themeId),
  ]),
  [registry.AUTO_OPTION.id, 'Auto'],
]);

const THEME_PREVIEW_SURFACES = [
  {
    id: 'desktop',
    labelKey: 'settings.appearance.themePreview.surface.desktop.label',
    label: '桌面端',
    titleKey: 'settings.appearance.themePreview.surface.desktop.title',
    title: '聊天与工作台',
    metaKey: 'settings.appearance.themePreview.surface.desktop.meta',
    meta: '侧栏、编辑器、预览',
  },
  {
    id: 'pwa',
    labelKey: 'settings.appearance.themePreview.surface.pwa.label',
    label: 'PWA',
    titleKey: 'settings.appearance.themePreview.surface.pwa.title',
    title: '移动聊天',
    metaKey: 'settings.appearance.themePreview.surface.pwa.meta',
    meta: '抽屉、输入框、状态',
  },
  {
    id: 'settings',
    labelKey: 'settings.appearance.themePreview.surface.settings.label',
    label: '设置页',
    titleKey: 'settings.appearance.themePreview.surface.settings.title',
    title: '控件',
    metaKey: 'settings.appearance.themePreview.surface.settings.meta',
    meta: '输入、开关、面板',
  },
  {
    id: 'modal',
    labelKey: 'settings.appearance.themePreview.surface.modal.label',
    label: '弹窗',
    titleKey: 'settings.appearance.themePreview.surface.modal.title',
    title: '对话框',
    metaKey: 'settings.appearance.themePreview.surface.modal.meta',
    meta: '遮罩、操作、焦点',
  },
];

function normalizeThemeAccent(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!/^#[0-9a-f]{6}$/i.test(text)) return '';
  return text.toUpperCase();
}

function normalizeThemeRadius(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(16, Math.round(n)));
}

function normalizeThemeOverrides(value: unknown): ThemeOverrides {
  if (!value || typeof value !== 'object') return {};
  const raw = value as ThemeOverrides;
  const accent = normalizeThemeAccent(raw.accent);
  const radius = normalizeThemeRadius(raw.radius);
  return {
    ...(accent ? { accent } : {}),
    ...(radius !== undefined ? { radius } : {}),
  };
}

function hexToRgb(value: string): Rgb | null {
  const hex = normalizeThemeAccent(value);
  if (!hex) return null;
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function relativeLuminance(rgb: Rgb): number {
  const channel = (value: number) => {
    const n = value / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

function contrastRatio(foreground: string, background: string): number {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return 0;
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function readThemeOverrides(): ThemeOverrides {
  try {
    return normalizeThemeOverrides(JSON.parse(localStorage.getItem(THEME_OVERRIDES_KEY) || '{}'));
  } catch {
    return {};
  }
}

function readCurrentThemeSelection(): string {
  return registry.migrateSavedTheme(
    localStorage.getItem(registry.STORAGE_KEY) || localStorage.getItem(registry.LEGACY_STORAGE_KEY)
  );
}

function themeDisplayName(themeId: string): string {
  return tx(THEME_NAME_KEYS[themeId] || themeId, THEME_FALLBACK_NAMES[themeId] || themeId);
}

function defaultComparisonTheme(currentTheme: string): string {
  const themes = registry.getThemeIds();
  return themes.find((theme: string) => theme !== currentTheme) || themes[0] || registry.DEFAULT_THEME;
}

function previewPalette(themeId: string): ThemePreviewPalette {
  const entry = registry.THEMES[themeId as keyof typeof registry.THEMES]
    || registry.THEMES[registry.DEFAULT_THEME as keyof typeof registry.THEMES];
  return {
    bg: entry.backgroundColor,
    surface: entry.preview.surface,
    text: entry.preview.text,
    muted: entry.preview.muted,
    accent: entry.preview.accent,
  };
}

function previewStyle(themeId: string): React.CSSProperties {
  const palette = previewPalette(themeId);
  return {
    '--theme-preview-bg': palette.bg,
    '--theme-preview-surface': palette.surface,
    '--theme-preview-text': palette.text,
    '--theme-preview-muted': palette.muted,
    '--theme-preview-accent': palette.accent,
  } as React.CSSProperties;
}

function ThemePreviewColumn({
  role,
  themeId,
  heading,
}: {
  role: 'current' | 'compare';
  themeId: string;
  heading: string;
}) {
  return (
    <div
      className={styles['theme-preview-column']}
      data-theme-preview={themeId}
      style={previewStyle(themeId)}
    >
      <div className={styles['theme-preview-column-head']}>
        <span>{heading}</span>
        <strong>{themeDisplayName(themeId)}</strong>
      </div>
      <div className={styles['theme-preview-surface-grid']}>
        {THEME_PREVIEW_SURFACES.map(surface => (
          <div
            key={`${role}-${surface.id}`}
            className={styles['theme-preview-surface']}
            data-testid={`theme-preview-surface-${surface.id}-${role}`}
          >
            <div className={styles['theme-preview-surface-topline']}>
              <span>{tx(surface.labelKey, surface.label)}</span>
              <i />
            </div>
            <strong>{tx(surface.titleKey, surface.title)}</strong>
            <small>{tx(surface.metaKey, surface.meta)}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

type MarkdownTypographyKey = Exclude<keyof EditorMarkdownTypography, 'fontPreset'>;
type MarkdownNumericTypographyKey = Exclude<MarkdownTypographyKey, 'contentWidth' | 'bodyFontSize'>;
type ReadingContentWidth = EditorMarkdownContentWidth | ChatLayoutContentWidth;

const EDITOR_FONT_SIZE_ROWS: Array<{
  key: MarkdownNumericTypographyKey;
  label: string;
  hint: string;
  min: number;
  max: number;
}> = [
  { key: 'heading1FontSize', label: 'settings.editor.markdownHeading1FontSize', hint: 'settings.editor.markdownHeading1FontSizeHint', min: 16, max: 40 },
  { key: 'heading2FontSize', label: 'settings.editor.markdownHeading2FontSize', hint: 'settings.editor.markdownHeading2FontSizeHint', min: 15, max: 34 },
  { key: 'heading3FontSize', label: 'settings.editor.markdownHeading3FontSize', hint: 'settings.editor.markdownHeading3FontSizeHint', min: 14, max: 30 },
  { key: 'heading4FontSize', label: 'settings.editor.markdownHeading4FontSize', hint: 'settings.editor.markdownHeading4FontSizeHint', min: 13, max: 28 },
  { key: 'heading5FontSize', label: 'settings.editor.markdownHeading5FontSize', hint: 'settings.editor.markdownHeading5FontSizeHint', min: 12, max: 26 },
  { key: 'heading6FontSize', label: 'settings.editor.markdownHeading6FontSize', hint: 'settings.editor.markdownHeading6FontSizeHint', min: 12, max: 24 },
];

const BODY_FONT_SIZE_OFFSETS = [-2, -1, 0, 1, 2] as const;

const CONTENT_WIDTH_STEPS: Array<{
  value: string;
  width: ReadingContentWidth;
  labelKey?: string;
}> = [
  { value: '640', width: 640 },
  { value: '720', width: 720 },
  { value: '800', width: 800 },
  { value: 'unlimited', width: 'unlimited', labelKey: 'settings.appearance.readingWidthUnlimited' },
];

function formatBodyFontSizeOffset(offset: number): string {
  return offset > 0 ? `+${offset}` : String(offset);
}

// These legacy controls stay hidden while the unified appearance editor owns
// theme selection. Keep the feature gate named instead of a constant JSX guard.
const LEGACY_APPEARANCE_SECTIONS_ENABLED = false;

export function InterfaceTab({ embedded = false }: { embedded?: boolean } = {}) {
  return (
    <div
      className={embedded ? styles['settings-embedded-tab-content'] : `${styles['settings-tab-content']} ${styles.active}`}
      data-tab="interface"
    >
      <InterfaceSettingsSections />
    </div>
  );
}

export function InterfaceSettingsSections() {
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const platformName = useSettingsStore(s => s.platformName);
  const [themeOverrides, setThemeOverrides] = React.useState<ThemeOverrides>(() => readThemeOverrides());
  const [currentTheme, setCurrentTheme] = React.useState<string>(() => readCurrentThemeSelection());
  const activeConcreteTheme = currentTheme === registry.AUTO_OPTION.id
    ? document.documentElement.getAttribute('data-theme') || registry.AUTO_LIGHT_DEFAULT
    : currentTheme;
  const [comparisonTheme, setComparisonTheme] = React.useState<string>(() => defaultComparisonTheme(currentTheme));
  const [sidebarUiPrefs, setSidebarUiPrefs] = React.useState<SidebarUiPrefs>(() => normalizeSidebarUiPrefs({}));
  const hardwareAccelerationEnabled = settingsConfig?.hardware_acceleration !== false;
  const editorTypography = useMemo(
    () => normalizeEditorTypography(settingsConfig?.editor),
    [settingsConfig?.editor],
  );
  const chatLayout = useMemo(
    () => normalizeChatLayout(settingsConfig?.chat),
    [settingsConfig?.chat],
  );
  const contentWidthOptions: Array<StepSliderOption & { width: ReadingContentWidth }> = CONTENT_WIDTH_STEPS.map(option => {
    const label = option.labelKey ? t(option.labelKey) : option.value;
    const valueLabel = option.width === 'unlimited' ? t('settings.appearance.readingWidthUnlimited') : option.value;
    return {
      value: option.value,
      width: option.width,
      label,
      valueLabel,
    };
  });
  const bodyFontSizeOptions: Array<StepSliderOption & { offset: ChatBodyFontSizeOffset }> = BODY_FONT_SIZE_OFFSETS.map(offset => {
    const label = formatBodyFontSizeOffset(offset);
    return {
      value: String(offset),
      offset,
      label,
      valueLabel: label,
    };
  });
  const fontSelectOptions = [
    { value: FOLLOW_READING_FONT_ID, label: t('settings.fonts.followReading') },
    ...READING_FONT_PRESETS.map(preset => ({
      value: preset.id,
      label: t(preset.labelKey),
    })),
  ];

  const saveEditorTypography = async (patch: Partial<EditorMarkdownTypography>) => {
    const previousConfig = useSettingsStore.getState().settingsConfig || {};
    const previousEditor = previousConfig.editor;
    const next = mergeEditorTypography(previousEditor, { markdown: patch });
    useSettingsStore.setState({ settingsConfig: { ...previousConfig, editor: next } });
    applyEditorTypography(next);
    window.platform?.settingsChanged?.('editor-typography-changed', { editor: next });

    const saved = await autoSaveConfig({ editor: next }, { silent: true });
    if (saved) {
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
      return;
    }

    const restored = normalizeEditorTypography(previousEditor);
    useSettingsStore.setState({ settingsConfig: previousConfig });
    applyEditorTypography(restored);
    window.platform?.settingsChanged?.('editor-typography-changed', { editor: restored });
  };

  const saveChatLayout = async (patch: Partial<ChatLayoutPreferences>) => {
    const previousConfig = useSettingsStore.getState().settingsConfig || {};
    const previousChat = previousConfig.chat;
    const next = mergeChatLayout(previousChat, patch);
    useSettingsStore.setState({ settingsConfig: { ...previousConfig, chat: next } });
    applyChatLayout(next);
    window.platform?.settingsChanged?.('chat-layout-changed', { chat: next });

    const saved = await autoSaveConfig({ chat: next }, { silent: true });
    if (saved) {
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
      return;
    }

    const restored = normalizeChatLayout(previousChat);
    useSettingsStore.setState({ settingsConfig: previousConfig });
    applyChatLayout(restored);
    window.platform?.settingsChanged?.('chat-layout-changed', { chat: restored });
  };

  const saveHardwareAcceleration = async (enabled: boolean) => {
    const previousConfig = useSettingsStore.getState().settingsConfig || {};
    useSettingsStore.setState({
      settingsConfig: { ...previousConfig, hardware_acceleration: enabled },
    });
    const saved = await autoSaveConfig({ hardware_acceleration: enabled }, { silent: true });
    if (saved) {
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
      return;
    }
    useSettingsStore.setState({ settingsConfig: previousConfig });
  };

  React.useEffect(() => {
    let cancelled = false;
    gsapFetch('/api/preferences/sidebar-ui')
      .then(res => res.json())
      .then(data => {
        if (cancelled) return;
        setSidebarUiPrefs(normalizeSidebarUiPrefs((data as { sidebarUi?: unknown })?.sidebarUi || data));
      })
      .catch(err => console.warn('[settings] load sidebar UI prefs failed:', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const saveSidebarSessionRowMode = async (rowMode: SidebarSessionListRowMode) => {
    const previous = sidebarUiPrefs;
    const optimistic = normalizeSidebarUiPrefs({
      ...previous,
      sessionList: { rowMode },
    });
    setSidebarUiPrefs(optimistic);
    try {
      const res = await gsapFetch('/api/preferences/sidebar-ui', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionList: { rowMode } }),
      });
      const data = await res.json();
      const saved = normalizeSidebarUiPrefs((data as { sidebarUi?: unknown })?.sidebarUi || optimistic);
      setSidebarUiPrefs(saved);
      window.dispatchEvent(new CustomEvent('hana-settings', {
        detail: { type: 'sidebar-ui-changed', sidebarUi: saved },
      }));
      window.platform?.settingsChanged?.('sidebar-ui-changed', { sidebarUi: saved });
      useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
    } catch (err) {
      setSidebarUiPrefs(previous);
      console.warn('[settings] save sidebar UI prefs failed:', err);
      useSettingsStore.getState().showToast(tx('settings.saveFailed', '保存失败'), 'error');
    }
  };

  const syncAppearancePrefs = (patch: SyncedAppearancePreferences) => {
    persistAppearancePreferences(patch).catch(() => {});
  };

  const saveThemeOverrides = (patch: ThemeOverrides) => {
    const next = normalizeThemeOverrides({ ...themeOverrides, ...patch });
    localStorage.setItem(THEME_OVERRIDES_KEY, JSON.stringify(next));
    window.applyThemeOverrides?.(next);
    setThemeOverrides(next);
  };

  const resetThemeOverrides = () => {
    localStorage.removeItem(THEME_OVERRIDES_KEY);
    window.resetThemeOverrides?.();
    setThemeOverrides({});
  };

  const importThemePreset = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const raw = parsed && typeof parsed === 'object' && 'overrides' in parsed
        ? (parsed as { overrides?: unknown }).overrides
        : parsed;
      saveThemeOverrides(normalizeThemeOverrides(raw));
    } catch {
      useSettingsStore.getState().showToast(tx('settings.appearance.invalidThemePresetJson', '主题预设 JSON 无效'), 'error');
    }
  };

  const exportThemePreset = () => {
    const payload = {
      version: 1,
      theme: currentTheme,
      overrides: normalizeThemeOverrides(themeOverrides),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    // eslint-disable-next-line no-restricted-syntax -- settings export uses a one-shot download anchor
    const link = document.createElement('a');
    link.href = url;
    link.download = `gsap-theme-preset-${currentTheme || 'custom'}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const locale = settingsConfig?.locale || 'system';
  const localeVal = ['system', 'zh-CN', 'zh-TW', 'ja', 'ko', 'en'].includes(locale) ? locale
    : locale.startsWith('zh') ? 'zh-CN'
    : locale.startsWith('ja') ? 'ja'
    : locale.startsWith('ko') ? 'ko'
    : 'en';

  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const commonTz = [
    'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore',
    'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Kolkata',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin',
    'America/New_York', 'America/Chicago', 'America/Denver',
    'America/Los_Angeles', 'Pacific/Auckland', 'Australia/Sydney',
  ];
  const tzSet = new Set(commonTz);
  if (browserTz && !tzSet.has(browserTz)) commonTz.unshift(browserTz);
  const currentTz = settingsConfig?.timezone || browserTz || 'Asia/Shanghai';
  if (!tzSet.has(currentTz) && currentTz !== browserTz) commonTz.unshift(currentTz);
  const tzOptions = commonTz.map(tz => {
    try {
      const offset = new Intl.DateTimeFormat('en', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date()).find((p: Intl.DateTimeFormatPart) => p.type === 'timeZoneName')?.value || '';
      return { value: tz, label: `${tz.replace(/_/g, ' ')}  (${offset})` };
    } catch { return { value: tz, label: tz.replace(/_/g, ' ') }; }
  });
  const concreteTheme = activeConcreteTheme;
  const effectiveComparisonTheme = comparisonTheme === concreteTheme
    ? defaultComparisonTheme(concreteTheme)
    : comparisonTheme;
  const themeCompareOptions = useMemo(
    () => registry.getThemeIds().map((theme: string) => ({ value: theme, label: themeDisplayName(theme) })),
    [],
  );
  const activeThemeEntry = registry.THEMES[concreteTheme as keyof typeof registry.THEMES]
    || registry.THEMES[registry.DEFAULT_THEME];
  const themeBackground = activeThemeEntry.backgroundColor;
  const themeAccent = activeThemeEntry.preview.accent;
  const accentContrast = contrastRatio(themeOverrides.accent || themeAccent, themeBackground);
  const contrastMessage = accentContrast > 0 && accentContrast < 3
    ? `${tx('settings.appearance.contrastWarning', '对比度警告')}: ${accentContrast.toFixed(2)} / ${themeBackground}`
    : `${tx('settings.appearance.contrastOk', '对比度正常')}: ${accentContrast.toFixed(2)} / ${themeBackground}`;
  const voiceShortcutKeys = platformName === 'darwin'
    ? VOICE_RECORD_SHORTCUT_MAC
    : VOICE_RECORD_SHORTCUT_DEFAULT;

  return (
    <>
      {LEGACY_APPEARANCE_SECTIONS_ENABLED && <SettingsSection title={t('settings.appearance.theme')} variant="flush">
        <div className={styles['theme-options']}>
          {VALID_THEMES.map(theme => {
            return (
              <button
                key={theme}
                type="button"
                className={`${styles['theme-card']}${currentTheme === theme  ? ' ' + styles['active'] : ''}`}
                data-theme={theme}
                onClick={() => {
                  setTheme?.(theme);
                  localStorage.setItem(registry.STORAGE_KEY, theme);
                  localStorage.setItem(registry.LEGACY_STORAGE_KEY, theme);
                  setCurrentTheme(registry.migrateSavedTheme(theme));
                  window.platform?.settingsChanged?.('theme-changed', { theme });
                  syncAppearancePrefs({ theme });
                }}
              >
                <div className={styles['theme-card-name']}>{t(THEME_NAME_KEYS[theme] || theme)}</div>
                <div className={styles['theme-card-mode']}>{t(THEME_MODE_KEYS[theme] || '')}</div>
              </button>
            );
          })}
        </div>
      </SettingsSection>}

      <SettingsSection title={t('settings.appearance.chatLayout')}>
        <SettingsSection.Card>
          <SettingsRow
            label={t('settings.appearance.bodyFontSizeOffset')}
            hint={t('settings.appearance.bodyFontSizeOffsetHint')}
            control={
              <StepSlider
                ariaLabel={t('settings.appearance.bodyFontSizeOffset')}
                options={bodyFontSizeOptions}
                value={String(chatLayout.bodyFontSizeOffset)}
                onChange={(value) => {
                  const option = bodyFontSizeOptions.find(item => item.value === value);
                  if (option) void saveChatLayout({ bodyFontSizeOffset: option.offset });
                }}
              />
            }
          />
          <SettingsRow
            label={t('settings.appearance.chatWidth')}
            hint={t('settings.appearance.chatWidthHint')}
            control={
              <StepSlider
                ariaLabel={t('settings.appearance.chatWidth')}
                options={contentWidthOptions}
                value={String(chatLayout.contentWidth)}
                onChange={(value) => {
                  const option = contentWidthOptions.find(item => item.value === value);
                  if (option) void saveChatLayout({ contentWidth: option.width as ChatLayoutContentWidth });
                }}
              />
            }
          />
        </SettingsSection.Card>
      </SettingsSection>

      {LEGACY_APPEARANCE_SECTIONS_ENABLED && <SettingsSection title={t('settings.appearance.title')}>
        <div className={styles['theme-advanced-settings']} data-testid="theme-advanced-settings">
        <div className={styles['theme-preview-comparator']} data-testid="theme-preview-comparator">
          <div className={styles['theme-preview-header']}>
            <div>
              <h3>{tx('settings.appearance.themePreviewComparator', '主题预览对比器')}</h3>
              <p>{tx('settings.appearance.themePreviewComparatorHint', '在选择主题前预览桌面端、PWA、设置页和弹窗效果。')}</p>
            </div>
            <div className={styles['theme-preview-select']}>
              <span>{tx('settings.appearance.compareTheme', '对比主题')}</span>
              <SelectWidget
                options={themeCompareOptions}
                value={effectiveComparisonTheme}
                onChange={setComparisonTheme}
              />
            </div>
          </div>
          <div className={styles['theme-preview-summary']}>
            <span>{tx('settings.appearance.currentTheme', '当前')}: {themeDisplayName(concreteTheme)}</span>
            <span>{tx('settings.appearance.compareThemeShort', '对比')}: {themeDisplayName(effectiveComparisonTheme)}</span>
          </div>
          <div className={styles['theme-preview-grid']}>
            <ThemePreviewColumn
              role="current"
              themeId={concreteTheme}
              heading={tx('settings.appearance.currentTheme', '当前')}
            />
            <ThemePreviewColumn
              role="compare"
              themeId={effectiveComparisonTheme}
              heading={tx('settings.appearance.compareThemeShort', '对比')}
            />
          </div>
        </div>

        <div className={styles['settings-row-2col']}>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']} htmlFor="theme-accent-input">主题强调色</label>
            <input
              id="theme-accent-input"
              className={styles['settings-input']}
              type="color"
              value={themeOverrides.accent || themeAccent}
              onChange={(event) => saveThemeOverrides({ accent: event.currentTarget.value })}
            />
            <span className={styles['settings-field-hint']}>只调整安全 CSS 变量，不改写主题文件。</span>
          </div>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']} htmlFor="theme-radius-input">圆角</label>
            <input
              id="theme-radius-input"
              className={styles['settings-input']}
              type="number"
              min={0}
              max={16}
              value={themeOverrides.radius ?? 6}
              onChange={(event) => saveThemeOverrides({ radius: normalizeThemeRadius(event.currentTarget.value) })}
            />
            <span className={styles['settings-field-hint']}>范围 0-16px，影响输入框与消息卡片。</span>
          </div>
        </div>
        <SettingsButton variant="secondary" onClick={resetThemeOverrides}>
          重置主题微调
        </SettingsButton>
        <div className={styles['settings-row-2col']}>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']} htmlFor="theme-preset-import">
              {tx('settings.appearance.importThemePreset', '导入主题预设')}
            </label>
            <input
              id="theme-preset-import"
              className={styles['settings-input']}
              type="file"
              accept="application/json,.json"
              onChange={(event) => { void importThemePreset(event); }}
            />
            <span className={styles['settings-field-hint']}>{contrastMessage}</span>
          </div>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{tx('settings.appearance.exportThemePreset', '导出主题预设')}</label>
            <SettingsButton variant="secondary" onClick={exportThemePreset}>
              {tx('settings.appearance.exportThemePreset', '导出主题预设')}
            </SettingsButton>
            <span className={styles['settings-field-hint']}>
              {tx('settings.appearance.themePresetHint', '预设 JSON 只包含安全的主题微调项。')}
            </span>
          </div>
        </div>
        </div>
      </SettingsSection>}
      <SettingsSection title={t('settings.editor.title')}>
        <SettingsRow
          label={t('settings.editor.markdownFont')}
          hint={t('settings.editor.markdownFontHint')}
          control={
            <SelectWidget
              options={fontSelectOptions}
              value={editorTypography.markdown.fontPreset}
              onChange={(value) => saveEditorTypography({
                fontPreset: normalizeFontSelectionId(value, {
                  allowFollow: true,
                  fallback: FOLLOW_READING_FONT_ID,
                }),
              })}
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.markdownBodyFontSize')}
          hint={t('settings.editor.markdownBodyFontSizeHint')}
          control={
            <NumberInput
              value={editorTypography.markdown.bodyFontSize}
              onChange={(value) => saveEditorTypography({ bodyFontSize: value })}
              unit="px"
              min={12}
              max={24}
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.markdownContentWidth')}
          hint={t('settings.editor.markdownContentWidthHint')}
          control={
            <StepSlider
              ariaLabel={t('settings.editor.markdownContentWidth')}
              options={contentWidthOptions}
              value={String(editorTypography.markdown.contentWidth)}
              onChange={(value) => {
                const option = contentWidthOptions.find(item => item.value === value);
                if (option) void saveEditorTypography({ contentWidth: option.width as EditorMarkdownContentWidth });
              }}
            />
          }
        />
        {EDITOR_FONT_SIZE_ROWS.map(row => (
          <SettingsRow
            key={row.key}
            label={t(row.label)}
            hint={t(row.hint)}
            control={
              <NumberInput
                value={editorTypography.markdown[row.key]}
                onChange={(value) => saveEditorTypography({ [row.key]: value })}
                unit="px"
                min={row.min}
                max={row.max}
              />
            }
          />
        ))}
        <SettingsRow
          label={t('settings.editor.markdownLineHeight')}
          hint={t('settings.editor.markdownLineHeightHint')}
          control={
            <NumberInput
              value={editorTypography.markdown.lineHeight}
              onChange={(value) => saveEditorTypography({ lineHeight: value })}
              min={1.2}
              max={2.2}
              step={0.05}
              precision="float"
            />
          }
        />
        <SettingsRow
          label={t('settings.editor.markdownContentPadding')}
          hint={t('settings.editor.markdownContentPaddingHint')}
          control={
            <NumberInput
              value={editorTypography.markdown.contentPadding}
              onChange={(value) => saveEditorTypography({ contentPadding: value })}
              unit="px"
              min={0}
              max={64}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t('settings.interface.sidebar')}>
        <SettingsSection.Card>
          <SettingsRow
            label={t('settings.interface.sessionListSingleLine')}
            hint={t('settings.interface.sessionListSingleLineHint')}
            control={
              <Toggle
                on={sidebarUiPrefs.sessionList.rowMode === 'single-line'}
                ariaLabel={t('settings.interface.sessionListSingleLine')}
                onChange={(enabled) => {
                  void saveSidebarSessionRowMode(enabled ? 'single-line' : 'two-line');
                }}
              />
            }
          />
        </SettingsSection.Card>
      </SettingsSection>

      <SettingsSection title={t('settings.interface.system')}>
        <SettingsRow
          label={t('settings.interface.hardwareAcceleration')}
          hint={t('settings.interface.hardwareAccelerationHint')}
          control={
            <Toggle
              on={hardwareAccelerationEnabled}
              ariaLabel={t('settings.interface.hardwareAcceleration')}
              onChange={saveHardwareAcceleration}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={t('settings.interface.shortcuts')}>
        <SettingsRow
          label={t('settings.interface.voiceRecordingShortcut')}
          hint={t('settings.interface.voiceRecordingShortcutHint')}
          control={
            <div
              className={styles['shortcut-keycaps']}
              aria-label={voiceShortcutKeys.join(' + ')}
            >
              {voiceShortcutKeys.map(key => (
                <kbd key={key} className={styles['shortcut-keycap']}>{key}</kbd>
              ))}
            </div>
          }
        />
      </SettingsSection>
      <section className={styles['settings-section']}>
        <h2 className={styles['settings-section-title']}>{t('settings.locale.title')}</h2>

        <div className={styles['settings-row-2col']}>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{t('settings.locale.language')}</label>
            <SelectWidget
              className={styles['settings-locale-select']}
              options={[
                { value: 'system', label: t('settings.locale.system') },
                { value: 'zh-CN', label: '\u7b80\u4f53\u4e2d\u6587' },
                { value: 'zh-TW', label: '\u7e41\u9ad4\u4e2d\u6587' },
                { value: 'ja',    label: '\u65e5\u672c\u8a9e' },
                { value: 'ko',    label: '\ud55c\uad6d\uc5b4' },
                { value: 'en', label: 'English' },
              ]}
              value={localeVal}
              onChange={async (val) => {
                await autoSaveConfig({ locale: val }, { silent: true });
                await i18n?.load(val);
                if (i18n) i18n.defaultName = useSettingsStore.getState().agentName;
                useSettingsStore.getState().showToast(t('settings.autoSaved'), 'success');
                window.platform?.settingsChanged?.('locale-changed', { locale: val });
                useSettingsStore.setState({});
              }}
            />
            <span className={styles['settings-field-hint']}>{t('settings.locale.languageHint')}</span>
          </div>
          <div className={styles['settings-field']}>
            <label className={styles['settings-field-label']}>{t('settings.locale.timezone')}</label>
            <SelectWidget
              className={styles['settings-locale-select']}
              options={tzOptions}
              value={currentTz}
              onChange={(val) => autoSaveConfig({ timezone: val })}
            />
            <span className={styles['settings-field-hint']}>{t('settings.locale.timezoneHint')}</span>
          </div>
        </div>
      </section>
    </>
  );
}
