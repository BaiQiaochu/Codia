const data = require("./theme-registry-data.json");

const STORAGE_KEY = data.storageKey;
const LEGACY_STORAGE_KEY = data.legacyStorageKey || data.storageKey;
const DEFAULT_THEME = data.defaultTheme;
const AUTO_LIGHT_DEFAULT = data.autoLightDefault;
const AUTO_DARK_DEFAULT = data.autoDarkDefault;
const PAPER_TEXTURE_BLOCKED_THEME_IDS = Object.freeze([...data.paperTextureBlockedThemeIds]);
const LEGACY_THEME_ALIASES = Object.freeze({ ...data.legacyThemeAliases });

const AUTO_OPTION = Object.freeze({
  ...data.autoOption,
});

const THEMES = Object.freeze(Object.fromEntries(
  Object.entries(data.themes).map(([id, entry]) => [id, Object.freeze({
    ...entry,
    preview: Object.freeze({ ...entry.preview }),
  })])
));

for (const [id, entry] of Object.entries(THEMES)) {
  if (!entry.cssPath || !entry.backgroundColor || !entry.preview || !entry.i18nName || !entry.i18nMode) {
    throw new Error(`theme-registry: theme "${id}" is missing required fields`);
  }
  if (!/^#[0-9A-F]{6}$/i.test(entry.backgroundColor)) {
    throw new Error(`theme-registry: theme "${id}" has invalid backgroundColor "${entry.backgroundColor}"`);
  }
  for (const key of ["surface", "text", "muted", "accent"]) {
    if (!/^#[0-9A-F]{6}$/i.test(entry.preview[key])) {
      throw new Error(`theme-registry: theme "${id}" has invalid preview.${key} "${entry.preview[key]}"`);
    }
  }
}

function migrateSavedTheme(raw) {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_THEME;
  if (LEGACY_THEME_ALIASES[raw]) return LEGACY_THEME_ALIASES[raw];
  return THEMES[raw] ? raw : DEFAULT_THEME;
}

function resolveSavedTheme(raw, isDark) {
  const stored = migrateSavedTheme(raw);
  if (stored === AUTO_OPTION.id) {
    return { stored, concrete: isDark ? AUTO_DARK_DEFAULT : AUTO_LIGHT_DEFAULT };
  }
  return { stored, concrete: stored };
}

function getThemeIds() {
  return Object.keys(THEMES);
}

function getAllUIOptions() {
  const themeOptions = getThemeIds().map((id) => ({
    id,
    i18nName: THEMES[id].i18nName,
    i18nMode: THEMES[id].i18nMode,
  }));
  return themeOptions;
}

function isPaperTextureBlockedTheme(themeId) {
  return PAPER_TEXTURE_BLOCKED_THEME_IDS.includes(themeId);
}

module.exports = {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  DEFAULT_THEME,
  AUTO_LIGHT_DEFAULT,
  AUTO_DARK_DEFAULT,
  PAPER_TEXTURE_BLOCKED_THEME_IDS,
  AUTO_OPTION,
  LEGACY_THEME_ALIASES,
  THEMES,
  migrateSavedTheme,
  resolveSavedTheme,
  getThemeIds,
  getAllUIOptions,
  isPaperTextureBlockedTheme,
};
