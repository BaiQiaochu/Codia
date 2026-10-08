// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

describe("runtime i18n module", () => {
  it("loads translations from lib without importing server routes", async () => {
    vi.resetModules();
    const { getLocale, loadLocale, t } = await import("../lib/i18n.js");

    loadLocale("en");

    expect(getLocale()).toBe("en");
    expect(t("error.defaultChannelName")).not.toBe("error.defaultChannelName");
  });

  it("keeps the server i18n entry compatible", async () => {
    vi.resetModules();
    const serverI18n = await import("../server/i18n.js");

    serverI18n.loadLocale("en");

    expect(serverI18n.getLocale()).toBe("en");
    expect(serverI18n.t("error.defaultChannelName")).not.toBe("error.defaultChannelName");
  });
});
