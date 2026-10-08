type StructuredOutputSchema = Record<string, any>;

export function createStructuredOutputTool(schema?: StructuredOutputSchema) {
  let captured: unknown;
  const tool = {
    name: "structured_output",
    label: "结构化输出",
    description: "返回严格符合所需 schema 的结构化结果。完成任务后必须调用一次。",
    parameters: schema && typeof schema === "object" ? schema : { type: "object" },
    execute: async (_toolCallId: string, params: unknown) => {
      captured = params;
      return { content: [{ type: "text", text: "结果已记录" }] };
    },
  };
  return {
    tool,
    getResult() {
      return captured;
    },
  };
}
