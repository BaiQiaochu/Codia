import { beforeEach, describe, expect, it } from "vitest";

import { execute as listCapabilitiesExecute } from "../plugins/beautify/tools/list-capabilities.ts";
import {
  HTML_STYLE_GUIDE_SECTIONS,
  HTML_STYLE_GUIDE_VERSION,
  REQUIRED_SECTIONS,
  getReadSections,
  markSectionRead,
  missingRequiredSections,
  resetHtmlStyleGuideTracking,
  sessionTrackingKey,
} from "../plugins/beautify/lib/html-style-guide.ts";
import {
  description,
  execute,
  isEnabledForAgentConfig,
  parameters,
  promptGuidelines,
} from "../plugins/beautify/tools/get-html-style-guide.ts";
import { isBeautifyEnabledForAgentConfig } from "../plugins/beautify/lib/availability.ts";

describe("beautify html style guide", () => {
  beforeEach(() => resetHtmlStyleGuideTracking());

  it("declares a G-SAP full-page HTML guide with required first sections", () => {
    expect(HTML_STYLE_GUIDE_SECTIONS).toEqual([
      "color",
      "typography",
      "layout",
      "components",
      "imagery",
      "motion",
      "anti-patterns",
    ]);
    expect(REQUIRED_SECTIONS).toEqual(["color", "typography"]);
    expect(HTML_STYLE_GUIDE_VERSION).toBe("2026-06-10");
    expect(description).toContain("G-SAP");
    expect(description).not.toMatch(/Hana|Hanako/i);
    expect(promptGuidelines).toContain("beautify_get-html-style-guide");
    expect(parameters.properties.section.enum).toEqual(HTML_STYLE_GUIDE_SECTIONS);
    expect(isEnabledForAgentConfig).toBe(isBeautifyEnabledForAgentConfig);
  });

  it("tracks read sections per session key", () => {
    expect(sessionTrackingKey({ sessionPath: "/tmp/a.jsonl" })).toBe("/tmp/a.jsonl");
    expect(sessionTrackingKey({})).toBe("__no_session__");

    markSectionRead("s1", "color");
    expect(getReadSections("s1")).toEqual(["color"]);
    expect(getReadSections("s2")).toEqual([]);
    expect(missingRequiredSections("s1")).toEqual(["typography"]);
  });

  it("returns a router without concrete color tokens", async () => {
    const result = await execute({}, { sessionPath: "/tmp/style-a.jsonl" });
    const text = result.content[0].text;

    expect(text).toContain("color");
    expect(text).toContain("typography");
    expect(text).toContain("beautify_get-html-style-guide");
    expect(text).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(result.details).toMatchObject({ kind: "router", version: HTML_STYLE_GUIDE_VERSION });
  });

  it("requires color and typography before serving optional sections", async () => {
    const ctx = { sessionPath: "/tmp/style-a.jsonl" };
    const refused = await execute({ section: "components" }, ctx);
    expect(refused.details.kind).toBe("must-read-first");
    expect(refused.details.missingRequired).toEqual(["color", "typography"]);

    const color = await execute({ section: "color" }, ctx);
    expect(color.content[0].text).toContain("#537D96");

    const stillRefused = await execute({ section: "components" }, ctx);
    expect(stillRefused.details.missingRequired).toEqual(["typography"]);

    await execute({ section: "typography" }, ctx);
    const served = await execute({ section: "components" }, ctx);
    expect(served.details.kind).toBe("section");
    expect(served.content[0].text).toContain("focus-visible");
    expect(served.details.readSections).toEqual(["color", "typography", "components"]);
  });

  it("registers the html style guide in Beautify capabilities", async () => {
    const result = await listCapabilitiesExecute();
    const entry = result.details.capabilities.find((capability: any) => capability.id === "html-style-guide");

    expect(entry).toMatchObject({
      target: "full-page-html",
      tools: ["beautify_get-html-style-guide"],
    });
    expect(result.content[0].text).toContain("beautify_get-html-style-guide");
  });
});
