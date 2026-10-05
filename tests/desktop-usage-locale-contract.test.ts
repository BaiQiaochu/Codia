import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const LOCALES = ["zh", "zh-TW", "en", "ja", "ko"];

const REQUIRED_USAGE_KEYS = [
  "title",
  "note",
  "refresh",
  "total",
  "requests",
  "totalTokens",
  "cacheRead",
  "cacheHitRate",
  "estimatedCost",
  "uncached",
  "modelMix",
  "dailyUsage",
  "requestLedger",
  "loading",
  "empty",
  "groupMeta",
  "cacheShort",
  "tokensShort",
  "cacheSummary",
  "view.overall",
  "view.daily",
  "view.category",
  "view.model",
  "category.session",
  "category.phone",
  "category.memory",
  "category.automation",
  "category.subagent",
  "category.compaction",
  "category.plugin",
  "category.utility",
  "category.vision",
  "category.unknown",
  "status.ok",
  "status.error",
  "status.aborted",
  "status.usage_missing",
];

function getByPath(value, keyPath) {
  return keyPath.split(".").reduce((current, key) => current?.[key], value);
}

describe("desktop usage locale contract", () => {
  it("ships complete usage-stat translations for every desktop locale", () => {
    for (const locale of LOCALES) {
      const filePath = path.join(process.cwd(), "desktop", "src", "locales", `${locale}.json`);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const usage = data.settings?.usage;

      expect(usage, `${locale} settings.usage`).toBeTruthy();
      for (const key of REQUIRED_USAGE_KEYS) {
        const value = getByPath(usage, key);
        expect(value, `${locale} settings.usage.${key}`).toEqual(expect.any(String));
        expect(value, `${locale} settings.usage.${key}`).not.toMatch(/^settings\.usage\./);
      }
    }
  });

  it("uses Chinese text for the simplified Chinese and English fallback usage pages", () => {
    for (const locale of ["zh", "en"]) {
      const filePath = path.join(process.cwd(), "desktop", "src", "locales", `${locale}.json`);
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

      expect(data.settings?.usage?.title).toBe("用量统计");
      expect(data.settings?.usage?.view?.overall).toBe("总览");
      expect(data.settings?.usage?.view?.category).toBe("按类别");
      expect(data.settings?.usage?.category?.session).toBe("会话");
      expect(data.settings?.usage?.category?.phone).toBe("手机");
      expect(data.settings?.usage?.category?.subagent).toBe("子代理");
      expect(data.settings?.usage?.status?.ok).toBe("完成");
      expect(data["error.regionUnavailable"]).toBe("此区域暂时无法显示");
      expect(data["viewMode.obsidian"]).toBe("切换到阅读器模式");
      expect(data.settings?.appearance?.precisionIdeMode).toBe("阅读器");
      expect(data.input?.thinkingLevel?.off).toBe("关闭");
      expect(data.input?.thinkingLevel?.auto).toBe("自动");
      expect(data.input?.thinkingLevel?.medium).toBe("中等");
      expect(data.input?.thinkingLevel?.high).toBe("深度");
      expect(data.input?.thinkingLevel?.xhigh).toBe("极限");
      expect(data.input?.thinkingDesc?.medium).toBe("中等推理");
      expect(data.input?.thinkingDesc?.xhigh).toBe("最强推理");
      expect(data.settings?.api?.thinkingLevels?.xhigh).toBe("极限");
    }
  });
});
