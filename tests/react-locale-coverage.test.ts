import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const localeDir = path.join(process.cwd(), "desktop", "src", "locales");
const workbenchDir = path.join(process.cwd(), "desktop", "src", "react", "workbench");
const workbenchLocaleCallFiles = [
  "PreviewTabsButton.tsx",
  "WorkbenchChatSurface.tsx",
];

const sharedKeys = [
  "common.close",
  "common.loading",
  "input.removeRecentWorkspace",
  "onboarding.error",
];

const workbenchKeys = [
  "workbench.previewTabs.close",
  "workbench.chatTitleStatus.memoryOn",
  "workbench.chatTitleStatus.memoryOff",
];

function readLocale(fileName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(localeDir, fileName), "utf-8"));
}

function hasNestedKey(source: Record<string, unknown>, dottedKey: string): boolean {
  let current: unknown = source;
  for (const part of dottedKey.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== undefined;
}

describe("React locale coverage", () => {
  it("defines static UI keys that are called from React surfaces", () => {
    const hasWorkbenchLocaleCallers = workbenchLocaleCallFiles
      .some((fileName) => fs.existsSync(path.join(workbenchDir, fileName)));
    const requiredKeys = hasWorkbenchLocaleCallers
      ? [...sharedKeys, ...workbenchKeys]
      : sharedKeys;

    const missing = fs.readdirSync(localeDir)
      .filter((fileName) => fileName.endsWith(".json"))
      .sort()
      .flatMap((fileName) => {
        const locale = readLocale(fileName);
        return requiredKeys
          .filter((key) => !hasNestedKey(locale, key))
          .map((key) => `${fileName}:${key}`);
      });

    expect(missing).toEqual([]);
  });
});
