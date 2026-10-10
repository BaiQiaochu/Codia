import { describe, expect, it } from "vitest";
import { Button, CodiaThemeProvider } from "@codia/plugin-components";
import { PLUGIN_UI_PROTOCOL } from "@codia/plugin-protocol";
import { defineTool, CODIA_BUS_SKIP } from "@codia/plugin-runtime";
import { createCodiaPluginSdk, codia } from "@codia/plugin-sdk";

describe("legacy Codia plugin package aliases", () => {
  it("resolve old @codia package names to the current Codia plugin SDK packages", () => {
    expect(Button).toBeTypeOf("object");
    expect(CodiaThemeProvider).toBeTypeOf("function");
    expect(PLUGIN_UI_PROTOCOL).toBe("codia.plugin.ui");
    expect(CODIA_BUS_SKIP).toBe(Symbol.for("codia.event-bus.skip"));
    expect(defineTool({ name: "x", description: "x", execute: () => "ok" }).name).toBe("x");
    expect(createCodiaPluginSdk).toBeTypeOf("function");
    expect(codia.assets.url).toBeTypeOf("function");
  });
});
