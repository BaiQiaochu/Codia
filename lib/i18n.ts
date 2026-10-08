import fs from "fs";
import path from "path";
import { fromRoot } from "../shared/app-root.ts";
import { createModuleLogger } from "./debug-log.ts";

const log = createModuleLogger("i18n");
const localesDir = fromRoot("desktop", "src", "locales");

let data: Record<string, any> = {};
let fallbackData: Record<string, any> = {};
let currentLocale = "zh";
let loaded = false;

function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "zh";
  } catch {
    return "zh";
  }
}

function resolveKey(locale?: string | null) {
  if (!locale) return "zh";
  if (locale === "system") return resolveKey(systemLocale());
  if (locale === "zh-TW" || locale === "zh-Hant") return "zh-TW";
  if (locale.startsWith("zh")) return "zh";
  if (locale.startsWith("ja")) return "ja";
  if (locale.startsWith("ko")) return "ko";
  return "en";
}

function readLocaleFile(key: string) {
  return JSON.parse(fs.readFileSync(path.join(localesDir, `${key}.json`), "utf-8"));
}

export function loadLocale(locale?: string | null) {
  const key = resolveKey(locale);
  currentLocale = key;
  loaded = true;

  try {
    fallbackData = readLocaleFile("en");
  } catch (err) {
    log.error(`Failed to load fallback locale "en": ${err.message}`);
    fallbackData = {};
  }

  if (key === "en") {
    data = fallbackData;
    return;
  }

  try {
    data = readLocaleFile(key);
  } catch (err) {
    log.error(`Failed to load locale "${key}": ${err.message}`);
    data = fallbackData;
  }
}

function getFrom(source: Record<string, any> | null | undefined, keyPath: string) {
  const exact = source?.[keyPath];
  if (exact !== undefined && exact !== null) return exact;
  return keyPath.split(".").reduce((obj, key) => obj?.[key], source);
}

function get(keyPath: string) {
  if (!loaded) loadLocale(currentLocale);
  const val = getFrom(data, keyPath);
  if (val !== undefined && val !== null) return val;
  return getFrom(fallbackData, keyPath);
}

export function t(keyPath: string, vars?: Record<string, unknown>) {
  let val = get(keyPath);
  if (val === undefined || val === null) return keyPath;
  if (typeof val !== "string") return val;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      val = val.replaceAll(`{${key}}`, String(value));
    }
  }
  return val;
}

export function getLocale() {
  return currentLocale;
}
