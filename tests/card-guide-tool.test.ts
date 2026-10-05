import { describe, expect, it } from "vitest";
import { createCardGuideTool } from "../lib/tools/card-guide-tool.ts";

describe("hana_card_guide compatibility tool", () => {
  it("keeps the legacy SDK tool name while returning G-SAP card guidance", async () => {
    const tool = createCardGuideTool();

    expect(tool.name).toBe("hana_card_guide");
    expect(tool.label).toContain("G-SAP");
    expect(tool.parameters.properties.modules).toBeDefined();

    const result = await tool.execute("call_1", {});
    const text = result.content[0].text;
    expect(text).toContain("--accent");
    expect(text).toContain("--bg-card");
    expect(text).toContain("--text");
    expect(text).toContain("--border");
    expect(text).toContain("--font-serif");
    expect(text).toContain("EB Garamond");
    expect(text).toContain("1.35rem");
    expect(text).toContain("0.75rem");
    expect(text).toContain("#537D96");
    expect(text).toContain("#1B365D");
    expect(text).toContain("#9D5F4D");
    expect(text).toContain("#FFFDF7");
    expect(text).toContain("gradient");
    expect(text).toContain("position: fixed");
    expect(text).toContain("DOCTYPE");
    expect(text).toContain("border-collapse");
    expect(text).toContain("tabular-nums");
    expect(text).toContain("blockquote");
    expect(text).toContain("<style>");
    expect(text).toContain("<script>");
    expect(text).toContain("inline style");
    expect(text).toContain("sr-only");
    expect(text).toContain("aria");
    expect(text).toContain("metric");
    expect(text).toContain("chart");
    expect(text).toContain("diagram");
  });
});
