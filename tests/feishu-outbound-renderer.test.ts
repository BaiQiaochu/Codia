// @ts-nocheck
import { describe, expect, it } from "vitest";
import { renderFeishuOutbound } from "../lib/bridge/feishu-outbound-renderer.ts";

function parseContent(rendered) {
  return JSON.parse(rendered.content);
}

describe("renderFeishuOutbound", () => {
  it("keeps ordinary markdown on Feishu post messages", () => {
    const rendered = renderFeishuOutbound("**bold**\n- item");

    expect(rendered.kind).toBe("post");
    expect(rendered.msgType).toBe("post");
    expect(parseContent(rendered).zh_cn.content).toEqual([
      [{ tag: "md", text: "**bold**" }],
      [{ tag: "md", text: "- item" }],
    ]);
  });

  it("routes markdown tables to Feishu interactive card JSON 2.0", () => {
    const table = [
      "| Name | Status | Owner |",
      "| --- | --- | --- |",
      "| #1516 | open | G-SAP |",
    ].join("\n");
    const rendered = renderFeishuOutbound(table);
    const card = parseContent(rendered);

    expect(rendered.kind).toBe("interactive");
    expect(rendered.msgType).toBe("interactive");
    expect(card).toMatchObject({
      schema: "2.0",
      config: { update_multi: true },
      body: {
        elements: [
          { tag: "markdown", content: table },
        ],
      },
    });
  });

  it("recognizes table variants without treating code pipes as tables", () => {
    const variants = [
      "| A | B |\n| --- | --- |\n| 1 | 2 |",
      "| A | B |\n| :--- | ---: |\n| ~~old~~ | `new` |",
      "| A | B | C | D |\n| --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 |",
    ];

    for (const text of variants) {
      expect(renderFeishuOutbound(text).msgType).toBe("interactive");
    }

    expect(renderFeishuOutbound("```md\n| A | B |\n| --- | --- |\n```").msgType).toBe("post");
    expect(renderFeishuOutbound("inline `| A | B |` only").msgType).toBe("post");
  });
});
