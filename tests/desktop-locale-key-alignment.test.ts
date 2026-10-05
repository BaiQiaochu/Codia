import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const LOCALES = ["zh", "zh-TW", "en", "ja", "ko"];

function collectKeys(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix].filter(Boolean);
  return Object.entries(value).flatMap(([key, nested]) => (
    collectKeys(nested, prefix ? `${prefix}.${key}` : key)
  ));
}

describe("desktop locale key alignment", () => {
  it("keeps all desktop locale files on the same key surface", () => {
    const localeKeys = Object.fromEntries(LOCALES.map((locale) => {
      const filePath = path.join(process.cwd(), "desktop", "src", "locales", `${locale}.json`);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return [locale, new Set(collectKeys(data))];
    }));
    const allKeys = new Set(Object.values(localeKeys).flatMap((keys) => [...keys]));

    for (const locale of LOCALES) {
      const missing = [...allKeys].filter((key) => !localeKeys[locale].has(key));
      expect(missing, `${locale} missing keys`).toEqual([]);
    }
  });
});
