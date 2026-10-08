import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

describe("usage ledger layout contract", () => {
  it("does not constrain usage tabs to narrow fixed-width columns", () => {
    const cssPath = path.join(process.cwd(), "desktop", "src", "react", "settings", "Settings.module.css");
    const css = fs.readFileSync(cssPath, "utf-8");
    const tabsRule = css.match(/\.usage-tabs\s*\{[^}]+\}/)?.[0] || "";
    const tabRule = css.match(/\.usage-tab\s*\{[^}]+\}/)?.[0] || "";

    expect(tabsRule).not.toContain("repeat(4, 76px)");
    expect(tabsRule).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
    expect(tabsRule).toContain("overflow: hidden");
    expect(tabRule).toContain("overflow: hidden");
    expect(tabRule).toContain("text-overflow: ellipsis");
    expect(css).toMatch(/\.usage-tab-label\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?text-overflow:\s*ellipsis;/);
  });

  it("keeps usage statistics reactive to i18n and protected from raw key leakage", () => {
    const sectionPath = path.join(
      process.cwd(),
      "desktop",
      "src",
      "react",
      "settings",
      "tabs",
      "providers",
      "UsageLedgerSection.tsx",
    );
    const sectionSource = fs.readFileSync(sectionPath, "utf-8");

    expect(sectionSource).toContain("useI18n");
    expect(sectionSource).toContain("usageT");
    expect(sectionSource).not.toContain("t('settings.usage.title')");
  });
});
