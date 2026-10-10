import registry from "./theme-registry";

import {
  loadPaperTexturePreference,
  setPaperTexturePreference,
} from "./appearance-preferences";

const themeSheet = document.getElementById("themeSheet") as HTMLLinkElement | null;
const THEME_OVERRIDES_KEY = "codia-theme-overrides";
const THEME_OVERRIDE_PROPS = ["--accent", "--accent-hover", "--accent-light", "--radius-input", "--radius-chat-card"] as const;

function systemIsDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyConcreteTheme(concrete: string): void {
  const entry = registry.THEMES[concrete as keyof typeof registry.THEMES];
  if (!entry) return;
  document.documentElement.setAttribute("data-theme", concrete);
  if (themeSheet) themeSheet.href = entry.cssPath;
  loadPaperTexturePreference();
  applyThemeOverrides();
}

let systemThemeListener: ((event: MediaQueryListEvent) => void) | null = null;

function readSavedTheme(): string | null {
  return localStorage.getItem(registry.STORAGE_KEY)
    || localStorage.getItem(registry.LEGACY_STORAGE_KEY);
}

function writeSavedTheme(value: string): void {
  localStorage.setItem(registry.STORAGE_KEY, value);
  localStorage.setItem(registry.LEGACY_STORAGE_KEY, value);
}

function setTheme(name: string): void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  if (systemThemeListener) {
    media.removeEventListener("change", systemThemeListener);
    systemThemeListener = null;
  }

  const { stored, concrete } = registry.resolveSavedTheme(name, systemIsDark());
  applyConcreteTheme(concrete);

  if (stored === "auto") {
    systemThemeListener = () => {
      applyConcreteTheme(registry.resolveSavedTheme("auto", systemIsDark()).concrete);
    };
    media.addEventListener("change", systemThemeListener);
  }

  writeSavedTheme(stored);
}

function loadSavedTheme(): void {
  setTheme(registry.migrateSavedTheme(readSavedTheme()));
}

function normalizeHexColor(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toUpperCase();
  return "";
}

function normalizeRadius(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(16, Math.round(n)));
}

function normalizeThemeOverrides(value: unknown): { accent?: string; radius?: number } {
  if (!value || typeof value !== "object") return {};
  const raw = value as { accent?: unknown; radius?: unknown };
  const accent = normalizeHexColor(raw.accent);
  const radius = normalizeRadius(raw.radius);
  return {
    ...(accent ? { accent } : {}),
    ...(radius !== undefined ? { radius } : {}),
  };
}

function readThemeOverrides(): { accent?: string; radius?: number } {
  try {
    return normalizeThemeOverrides(JSON.parse(localStorage.getItem(THEME_OVERRIDES_KEY) || "{}"));
  } catch {
    return {};
  }
}

function clearThemeOverrideProps(): void {
  for (const prop of THEME_OVERRIDE_PROPS) {
    document.documentElement.style.removeProperty(prop);
  }
}

function applyThemeOverrides(overrides: unknown = readThemeOverrides()): { accent?: string; radius?: number } {
  clearThemeOverrideProps();
  localStorage.setItem(THEME_OVERRIDES_KEY, "{}");
  void overrides;
  return {};
}

function resetThemeOverrides(): void {
  localStorage.removeItem(THEME_OVERRIDES_KEY);
  clearThemeOverrideProps();
}

function setPaperTexture(enabled: boolean): void {
  setPaperTexturePreference(enabled);
}

function loadSavedPaperTexture(): void {
  loadPaperTexturePreference();
}

window.setTheme = setTheme;
window.applyTheme = setTheme;
window.loadSavedTheme = loadSavedTheme;
window.applyThemeOverrides = applyThemeOverrides;
window.resetThemeOverrides = resetThemeOverrides;
window.setPaperTexture = setPaperTexture;
window.loadSavedPaperTexture = loadSavedPaperTexture;

loadSavedTheme();
loadSavedPaperTexture();
