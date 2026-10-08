type LocaleData = Record<string, unknown>;
type I18nVars = Record<string, string | number>;

interface BrowserI18n {
  _data: LocaleData;
  _fallbackData: LocaleData;
  _agentOverrides: LocaleData;
  locale: string;
  defaultName: string;
  load(locale: string): Promise<void>;
  _resolveKey(locale?: string): string;
  setAgentOverrides(overrides: LocaleData | null): void;
  _get(path: string): unknown;
  t(path: string, vars?: I18nVars): string;
}

async function fetchLocaleData(key: string): Promise<LocaleData> {
  const res = await fetch(`./locales/${key}.json`);
  if (!res.ok) throw new Error(res.statusText);
  return await res.json();
}

function getLocaleValue(data: LocaleData | null | undefined, path: string): unknown {
  const directValue = data?.[path];
  if (directValue !== undefined && directValue !== null) return directValue;

  return path.split(".").reduce<unknown>((obj, key) => {
    if (!obj || typeof obj !== "object") return undefined;
    return (obj as LocaleData)[key];
  }, data);
}

const i18n: BrowserI18n = {
  _data: {},
  _fallbackData: {},
  _agentOverrides: {},
  locale: "zh",
  defaultName: "助手",

  async load(locale: string) {
    const key = this._resolveKey(locale);
    this.locale = key;
    try {
      this._fallbackData = await fetchLocaleData("en");
    } catch (err) {
      console.error('[i18n] Failed to load fallback locale "en":', err);
      this._fallbackData = {};
    }

    try {
      this._data = key === "en" ? this._fallbackData : await fetchLocaleData(key);
    } catch (err) {
      console.error(`[i18n] Failed to load locale "${key}":`, err);
      this._data = this._fallbackData;
    }
  },

  _resolveKey(locale?: string) {
    if (locale === 'system') {
      locale = navigator.language || "zh";
    }
    if (!locale) return this._resolveKey('system');
    if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
    if (locale.startsWith("zh")) return "zh";
    if (locale.startsWith("ja")) return "ja";
    if (locale.startsWith("ko")) return "ko";
    return "en";
  },

  setAgentOverrides(overrides: LocaleData | null) {
    this._agentOverrides = overrides || {};
  },

  _get(path: string) {
    const override = getLocaleValue(this._agentOverrides, path);
    if (override !== undefined && override !== null) return override;

    const value = getLocaleValue(this._data, path);
    if (value !== undefined && value !== null) return value;

    return getLocaleValue(this._fallbackData, path);
  },

  t(path: string, vars?: I18nVars): string {
    const val = this._get(path);
    if (val === undefined || val === null) return path;
    if (typeof val !== "string") return val as string;

    let text = val;
    if (vars) {
      for (const [key, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${key}}`, String(value));
      }
    }
    text = text.replaceAll("{name}", this.defaultName);

    return text;
  },
};

function t(path: string, vars?: I18nVars): string {
  return i18n.t(path, vars);
}

window.i18n = i18n;
window.t = t;

export {};
