// @ts-nocheck
import { describe, expect, it } from "vitest";
import { loadLocale, t } from "../lib/i18n.ts";

describe("server i18n flat dotted keys", () => {
  it("resolves exact flat dotted locale keys", () => {
    loadLocale("zh-CN");

    expect(t("preview.markdownPreview")).toBe("预览");
  });
});
