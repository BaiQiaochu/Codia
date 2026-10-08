// @ts-nocheck
import { describe, expect, it } from "vitest";
import { transformSync } from "esbuild";
import fs from "fs";
import path from "path";
import vm from "vm";

function loadBrowserI18n(fetchImpl = async () => ({ ok: false })) {
  const source = fs.readFileSync(path.join(process.cwd(), "desktop", "src", "lib", "i18n.ts"), "utf-8");
  const { code } = transformSync(source, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  });
  const window = {};
  vm.runInNewContext(code, {
    window,
    console,
    fetch: fetchImpl,
    navigator: { language: "zh-CN" },
    module: { exports: {} },
    exports: {},
  });
  return window.i18n;
}

describe("desktop browser i18n", () => {
  it("resolves flat locale keys before falling back to dot-path lookup", () => {
    const i18n = loadBrowserI18n();
    i18n._data = {
      "preview.markdownPreview": "预览",
      preview: {
        exitMarkdownPreview: "回到编辑",
      },
    };

    expect(i18n.t("preview.markdownPreview")).toBe("预览");
    expect(i18n.t("preview.exitMarkdownPreview")).toBe("回到编辑");
  });

  it("falls back to English per key when the active locale is missing a value", async () => {
    const payloads = new Map([
      ["./locales/zh.json", { common: { ok: "中文" } }],
      ["./locales/en.json", { common: { ok: "English", missing: "English fallback" } }],
    ]);
    const i18n = loadBrowserI18n(async (url) => ({
      ok: payloads.has(url),
      statusText: "not found",
      json: async () => payloads.get(url),
    }));

    await i18n.load("zh");

    expect(i18n.t("common.ok")).toBe("中文");
    expect(i18n.t("common.missing")).toBe("English fallback");
    expect(i18n.t("common.unknown")).toBe("common.unknown");
  });
});
