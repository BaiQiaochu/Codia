import { describe, expect, it } from "vitest";
import { description, execute } from "../plugins/beautify/tools/get-cover-style-guide.ts";

describe("beautify cover style guide tool", () => {
  it("actively directs agents to read style guidance before creating markdown covers", async () => {
    expect(description).toContain("先调用本工具");
    expect(description).toContain("Markdown");

    const result = await execute({ themeTone: "dark", userGuidance: "quiet editorial cover" });
    expect(result.content[0].text).toContain("Markdown");
    expect(result.content[0].text).toContain("quiet editorial cover");
    expect(result.details.themeTone).toBe("dark");
    expect(result.details.workflow).toContain("调用 beautify_get-cover-style-guide");
  });
});
