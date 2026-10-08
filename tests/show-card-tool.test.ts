import { describe, expect, it } from "vitest";
import { createShowCardTool } from "../lib/tools/show-card-tool.ts";

describe("show_card tool", () => {
  it("exposes title/code parameters", () => {
    const tool = createShowCardTool();

    expect(tool.name).toBe("show_card");
    expect(tool.parameters.properties.title).toBeDefined();
    expect(tool.parameters.properties.code).toBeDefined();
    expect(tool.parameters.required).toContain("title");
    expect(tool.parameters.required).toContain("code");
  });

  it("returns a unique rendered card payload", async () => {
    const tool = createShowCardTool();
    const code = '<div style="padding: 1rem"><h2>Q4 Revenue</h2></div>';

    const first = await tool.execute("call_1", { title: "q4_revenue", code });
    const second = await tool.execute("call_2", { title: "q4_revenue_copy", code: "<p>copy</p>" });

    expect(first.details.status).toBe("rendered");
    expect(first.details.title).toBe("q4_revenue");
    expect(first.details.code).toBe(code);
    expect(typeof first.details.cardId).toBe("string");
    expect(first.details.cardId).not.toBe(second.details.cardId);
    expect(first.content[0].text).toContain("rendered");
  });
});
