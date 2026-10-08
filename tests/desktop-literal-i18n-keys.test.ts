import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const REACT_ROOT = path.join(process.cwd(), "desktop", "src", "react");
const ZH_LOCALE = JSON.parse(fs.readFileSync(path.join(process.cwd(), "desktop", "src", "locales", "zh.json"), "utf-8"));

function hasLocaleKey(key) {
  if (ZH_LOCALE[key] !== undefined) return true;
  return key.split(".").reduce((current, part) => current?.[part], ZH_LOCALE) !== undefined;
}

function scanFiles(dir, output = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) scanFiles(fullPath, output);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) output.push(fullPath);
  }
  return output;
}

describe("desktop literal i18n keys", () => {
  it("has zh translations for direct t('...') calls in React source", () => {
    const missing = [];
    const directTranslationCall = /\bt\(\s*['"]([^'"`$]+)['"]/g;

    for (const filePath of scanFiles(REACT_ROOT)) {
      const source = fs.readFileSync(filePath, "utf-8");
      for (const match of source.matchAll(directTranslationCall)) {
        const key = match[1];
        if (!key.includes(".")) continue;
        if (!hasLocaleKey(key)) {
          missing.push(`${key} :: ${path.relative(process.cwd(), filePath)}`);
        }
      }
    }

    expect(missing.sort()).toEqual([]);
  });
});
