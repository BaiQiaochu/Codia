import { describe, expect, it } from "vitest";
import { Button, GsapThemeProvider } from "@hana/plugin-components";
import { PLUGIN_UI_PROTOCOL } from "@hana/plugin-protocol";
import { defineTool, GSAP_BUS_SKIP } from "@hana/plugin-runtime";
import { createGsapPluginSdk, gsap } from "@hana/plugin-sdk";

describe("legacy Hana plugin package aliases", () => {
  it("resolve old @hana package names to the current G-SAP plugin SDK packages", () => {
    expect(Button).toBeTypeOf("object");
    expect(GsapThemeProvider).toBeTypeOf("function");
    expect(PLUGIN_UI_PROTOCOL).toBe("gsap.plugin.ui");
    expect(GSAP_BUS_SKIP).toBe(Symbol.for("gsap.event-bus.skip"));
    expect(defineTool({ name: "x", description: "x", execute: () => "ok" }).name).toBe("x");
    expect(createGsapPluginSdk).toBeTypeOf("function");
    expect(gsap.assets.url).toBeTypeOf("function");
  });
});
