import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISABLED_TOOL_NAMES,
  OPTIONAL_TOOL_NAMES,
  assertAllToolsCategorized,
  computeSettingsAvailableToolNames,
  computeToolSnapshot,
  uniqueToolNames,
} from "../shared/tool-categories.ts";

describe("tool categories", () => {
  it("keeps the expected optional tool whitelist", () => {
    expect(new Set(OPTIONAL_TOOL_NAMES)).toEqual(new Set([
      "automation",
      "beautify",
      "browser",
      "cron",
      "dm",
      "install_skill",
      "office",
      "update_settings",
      "workflow",
    ]));
  });

  it("deduplicates tool names while preserving order", () => {
    expect(uniqueToolNames(["read", "", null, "browser", "read", "dm"])).toEqual([
      "read",
      "browser",
      "dm",
    ]);
  });

  it("filters disabled optional tools after deduplication", () => {
    expect(computeToolSnapshot(
      ["read", "browser", "browser", "dm", "channel"],
      ["browser", "channel"],
      { extraDisabled: ["dm"] },
    )).toEqual(["read", "channel"]);
  });

  it("keeps settings optional toggles visible before runtime tools initialize", () => {
    expect(computeSettingsAvailableToolNames(["wait"], {
      pluginTools: [{ _pluginId: "beautify" }, { _pluginId: "office" }],
    })).toEqual(expect.arrayContaining([
      "wait",
      "automation",
      "beautify",
      "browser",
      "cron",
      "dm",
      "install_skill",
      "office",
      "update_settings",
      "workflow",
    ]));
  });

  it("hides plugin-backed optional toggles when their plugin is missing", () => {
    const result = computeSettingsAvailableToolNames(["wait"], { pluginTools: [] });
    expect(result).toContain("browser");
    expect(result).not.toContain("beautify");
    expect(result).not.toContain("office");
  });

  it("categorizes the built-in workflow orchestration tool", () => {
    expect(() => assertAllToolsCategorized(["workflow"])).not.toThrow();
  });

  it("keeps workflow default-off until the agent explicitly enables it", () => {
    expect(DEFAULT_DISABLED_TOOL_NAMES).toContain("workflow");
  });
});
