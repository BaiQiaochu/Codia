import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const LOCALE_DIR = path.join(ROOT, "desktop", "src", "locales");
const BASE_LOCALE = "en.json";
const USER_VISIBLE_LOCALES = ["zh.json", "zh-TW.json", "ja.json", "ko.json"];

const allowedEmptyKeys = new Set([
  "automation.newPrompt",
  "cron.weekPrefix",
]);

const technicalSameValueKeys = new Set([
  "settings.api.baseUrl",
  "settings.providers.baseUrl",
  "settings.media.baseUrl",
  "rightWorkspace.workflow.agents",
]);

const technicalValuePatterns = [
  /^[A-Z0-9._/-]+$/,
  /^#[0-9A-Fa-f]{3,8}$/,
  /^https?:\/\//,
  /^[a-z]+:[a-z0-9._-]+$/i,
  /^[A-Za-z0-9._-]+\.(json|md|txt|csv|xlsx|docx|pdf)$/i,
];

function readLocale(file) {
  const fullPath = path.join(LOCALE_DIR, file);
  try {
    return JSON.parse(fs.readFileSync(fullPath, "utf8"));
  } catch (error) {
    throw new Error(`${file}: JSON parse failed: ${error.message}`);
  }
}

function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function flatten(value, prefix = "", output = new Map()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    output.set(prefix, { type: valueType(value), value });
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    const childKey = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      flatten(child, childKey, output);
    } else {
      output.set(childKey, { type: valueType(child), value: child });
    }
  }
  return output;
}

function isTechnicalSameValue(key, value) {
  if (technicalSameValueKeys.has(key)) return true;
  if (typeof value !== "string") return true;
  if (!value.trim()) return false;
  return technicalValuePatterns.some((pattern) => pattern.test(value.trim()));
}

function isRawKeyLike(value) {
  if (typeof value !== "string") return false;
  return /^[a-z][a-z0-9_-]*(?:\.[a-z0-9_-]+){1,}$/i.test(value.trim());
}

function sample(list, count = 12) {
  return list.slice(0, count);
}

const errors = [];
const warnings = [];
const localeFiles = fs.readdirSync(LOCALE_DIR).filter((file) => file.endsWith(".json")).sort();

if (!localeFiles.includes(BASE_LOCALE)) {
  errors.push(`Missing base locale ${BASE_LOCALE}`);
}

const localeData = new Map();
for (const file of localeFiles) {
  try {
    localeData.set(file, readLocale(file));
  } catch (error) {
    errors.push(error.message);
  }
}

const base = localeData.get(BASE_LOCALE);
const baseFlat = base ? flatten(base) : new Map();

for (const [file, data] of localeData.entries()) {
  const flat = flatten(data);
  const missing = [];
  const extra = [];
  const typeMismatch = [];
  const emptyStrings = [];
  const rawKeyValues = [];
  const sameAsEnglish = [];

  for (const [key, baseEntry] of baseFlat.entries()) {
    const entry = flat.get(key);
    if (!entry) {
      missing.push(key);
      continue;
    }
    if (entry.type !== baseEntry.type) {
      typeMismatch.push(`${key}: ${entry.type} != ${baseEntry.type}`);
    }
  }

  for (const key of flat.keys()) {
    if (!baseFlat.has(key)) extra.push(key);
  }

  for (const [key, entry] of flat.entries()) {
    if (entry.type === "string") {
      const text = String(entry.value);
      if (text.trim() === "" && !allowedEmptyKeys.has(key)) emptyStrings.push(key);
      if (isRawKeyLike(text) && text === key) rawKeyValues.push(key);
      const baseValue = baseFlat.get(key)?.value;
      if (
        file !== BASE_LOCALE
        && USER_VISIBLE_LOCALES.includes(file)
        && typeof baseValue === "string"
        && text === baseValue
        && !isTechnicalSameValue(key, text)
      ) {
        sameAsEnglish.push(key);
      }
    }
  }

  if (missing.length) errors.push(`${file}: missing keys: ${sample(missing).join(", ")}${missing.length > 12 ? ` (+${missing.length - 12})` : ""}`);
  if (extra.length) errors.push(`${file}: extra keys: ${sample(extra).join(", ")}${extra.length > 12 ? ` (+${extra.length - 12})` : ""}`);
  if (typeMismatch.length) errors.push(`${file}: type mismatch: ${sample(typeMismatch).join(", ")}${typeMismatch.length > 12 ? ` (+${typeMismatch.length - 12})` : ""}`);
  if (emptyStrings.length) errors.push(`${file}: empty strings: ${sample(emptyStrings).join(", ")}${emptyStrings.length > 12 ? ` (+${emptyStrings.length - 12})` : ""}`);
  if (rawKeyValues.length) errors.push(`${file}: raw key values: ${sample(rawKeyValues).join(", ")}${rawKeyValues.length > 12 ? ` (+${rawKeyValues.length - 12})` : ""}`);
  if (sameAsEnglish.length) warnings.push(`${file}: ${sameAsEnglish.length} values match English: ${sample(sameAsEnglish).join(", ")}${sameAsEnglish.length > 12 ? ` (+${sameAsEnglish.length - 12})` : ""}`);
}

console.log(`[check:locales] scanned ${localeFiles.length} locale files, ${baseFlat.size} base keys`);
for (const warning of warnings) console.warn(`[check:locales] warning: ${warning}`);

if (errors.length) {
  for (const error of errors) console.error(`[check:locales] error: ${error}`);
  process.exit(1);
}

console.log("[check:locales] ok");
