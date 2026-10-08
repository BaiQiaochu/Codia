import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const LOCALES = ["zh", "zh-TW", "en", "ja", "ko"];
const LOCALE_DIR = path.join(process.cwd(), "desktop", "src", "locales");

const REQUIRED_RUNTIME_KEYS = [
  "activity.title",
  "activity.empty",
  "activity.heartbeat",
  "activity.subagent",
  "activity.cron",
  "activity.patrolDone",
  "activity.cronDone",
  "activity.error",
  "activity.viewSession",
  "activity.promote",
  "activity.duration",
  "chat.messageUnavailable",
  "error.channelsDisabled",
  "error.noOtherAgents",
  "error.subagentParentSessionRequired",
  "error.subagentStopError",
  "error.subagentStopLength",
  "error.subagentStopReason",
  "input.compact",
];

const ORIGINAL_COMPACT_LABELS = {
  zh: "压缩",
  "zh-TW": "壓縮",
  en: "Compact",
  ja: "圧縮",
  ko: "압축",
};

function readLocale(locale) {
  return JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${locale}.json`), "utf-8"));
}

function lookup(data, keyPath) {
  if (data[keyPath] !== undefined) return data[keyPath];
  return keyPath.split(".").reduce((current, key) => current?.[key], data);
}

describe("runtime i18n compatibility", () => {
  it("ships translations for activity, chat fallback, and tool error keys", () => {
    for (const locale of LOCALES) {
      const data = readLocale(locale);
      for (const key of REQUIRED_RUNTIME_KEYS) {
        const value = lookup(data, key);
        expect(value, `${locale}.${key}`).toBeTruthy();
        expect(value, `${locale}.${key}`).not.toBe(key);
      }
    }
  });

  it("keeps the context ring compact action label aligned with upstream", () => {
    for (const locale of LOCALES) {
      const data = readLocale(locale);
      expect(lookup(data, "input.compact"), `${locale}.input.compact`).toBe(ORIGINAL_COMPACT_LABELS[locale]);
    }
  });
});
