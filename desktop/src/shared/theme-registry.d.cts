interface ThemeEntry {
  cssPath: string;
  backgroundColor: string;
  preview: {
    surface: string;
    text: string;
    muted: string;
    accent: string;
  };
  i18nName: string;
  i18nMode: string;
}

type ThemeId =
  | "studio-light"
  | "nocturne"
  | "midnight"
  | "midnight-contrast"
  | "workbench"
  | "precision-ide"
  | "coral";

type StoredThemeSelection = ThemeId | "auto";

interface ThemeUIOption {
  id: StoredThemeSelection;
  i18nName: string;
  i18nMode: string;
}

interface ResolvedTheme {
  stored: StoredThemeSelection;
  concrete: ThemeId;
}

declare const registry: {
  STORAGE_KEY: "gsap-theme";
  LEGACY_STORAGE_KEY: "gsap-theme";
  DEFAULT_THEME: "studio-light";
  AUTO_LIGHT_DEFAULT: "studio-light";
  AUTO_DARK_DEFAULT: "nocturne";
  PAPER_TEXTURE_BLOCKED_THEME_IDS: ReadonlyArray<"midnight" | "midnight-contrast" | "nocturne" | "precision-ide">;
  AUTO_OPTION: ThemeUIOption;
  LEGACY_THEME_ALIASES: Readonly<Record<string, ThemeId>>;
  THEMES: Readonly<Record<ThemeId, ThemeEntry>>;
  migrateSavedTheme(raw: unknown): StoredThemeSelection;
  resolveSavedTheme(raw: unknown, isDark: boolean): ResolvedTheme;
  getThemeIds(): ThemeId[];
  getAllUIOptions(): ThemeUIOption[];
  isPaperTextureBlockedTheme(themeId: unknown): boolean;
};

export = registry;
