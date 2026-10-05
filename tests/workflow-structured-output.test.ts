import { describe, expect, it } from "vitest";
import { createStructuredOutputTool } from "../lib/workflow/structured-output.ts";

describe("structured output tool", () => {
  it("工具形状正确，parameters 用传入的 schema", () => {
    const schema = { type: "object", required: ["n"], properties: { n: { type: "number" } } };
    const { tool } = createStructuredOutputTool(schema);
    expect(tool.name).toBe("structured_output");
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBe(schema);
  });

  it("调用前 getResult 为 undefined，调用后捕获参数", async () => {
    const { tool, getResult } = createStructuredOutputTool({ type: "object" });
    expect(getResult()).toBeUndefined();
    const r = await tool.execute("c1", { n: 42 });
    expect(r.content[0].type).toBe("text");
    expect(getResult()).toEqual({ n: 42 });
  });

  it("schema 缺省时退化为 type:object", () => {
    const { tool } = createStructuredOutputTool(undefined);
    expect(tool.parameters).toEqual({ type: "object" });
  });
});
