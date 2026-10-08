import { describe, expect, it } from "vitest";
import {
  getReasoningProfile,
  getThinkingFormat,
  normalizeProviderPayload,
} from "../../core/provider-compat.ts";

const kimiOpenAIModel = {
  id: "kimi-k2.6",
  provider: "moonshot",
  api: "openai-completions",
  baseUrl: "https://api.moonshot.cn/v1",
  reasoning: true,
  maxTokens: 98304,
};

describe("provider-compat/kimi", () => {
  it("detects official Kimi OpenAI-compatible thinking contracts", () => {
    expect(getThinkingFormat(kimiOpenAIModel)).toBe("kimi");
    expect(getReasoningProfile(kimiOpenAIModel)).toBe("kimi-openai");
  });

  it("enables thinking with Kimi official fields in chat mode", () => {
    const payload = {
      model: "kimi-k2.6",
      max_tokens: 12000,
      messages: [{ role: "user", content: "hi" }],
    };

    const result = normalizeProviderPayload(payload, kimiOpenAIModel, {
      mode: "chat",
      reasoningLevel: "medium",
    });

    expect(result).not.toBe(payload);
    expect(result).toMatchObject({
      model: "kimi-k2.6",
      max_completion_tokens: 12000,
      reasoning_effort: "medium",
      thinking: { type: "enabled" },
    });
    expect(result).not.toHaveProperty("max_tokens");
  });

  it("maps xhigh to Kimi high effort instead of DeepSeek max", () => {
    const result = normalizeProviderPayload({
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    }, kimiOpenAIModel, {
      mode: "chat",
      reasoningLevel: "xhigh",
    });

    expect(result.reasoning_effort).toBe("high");
    expect(result.thinking).toEqual({ type: "enabled" });
    expect(result).not.toHaveProperty("output_config");
  });

  it("disables thinking and strips replayed reasoning_content for utility calls", () => {
    const payload = {
      model: "kimi-k2.6",
      messages: [
        { role: "assistant", content: "answer", reasoning_content: "private" },
        { role: "user", content: "summarize" },
      ],
      reasoning_effort: "medium",
      thinking: { type: "enabled", keep: "all" },
    };

    const result = normalizeProviderPayload(payload, kimiOpenAIModel, { mode: "utility" });

    expect(result).not.toBe(payload);
    expect(result.reasoning_effort).toBeUndefined();
    expect(result.thinking).toEqual({ type: "disabled" });
    expect(result.messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("recovers reasoning_content for Kimi tool-call replay", () => {
    const payload = {
      model: "kimi-k2.6",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I need to inspect the file." }],
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "Read", arguments: "{}" },
          }],
        },
      ],
    };

    const result = normalizeProviderPayload(payload, kimiOpenAIModel, {
      mode: "chat",
      reasoningLevel: "high",
    });

    expect(result.messages[0]).toMatchObject({
      reasoning_content: "I need to inspect the file.",
    });
  });

  it("keeps root tool parameters object-shaped while removing Kimi-incompatible root anyOf", () => {
    const schemaOnlyKimiModel = {
      ...kimiOpenAIModel,
      reasoning: false,
      compat: {
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
      },
    };
    const officeReadParameters = {
      type: "object",
      properties: {
        resource: { type: "object", description: "ResourceIO ResourceRef to read." },
        filePath: { type: "string", description: "Legacy absolute local path." },
        outputFormat: { type: "string", enum: ["text", "markdown", "html", "json"] },
      },
      anyOf: [
        { required: ["resource"] },
        { required: ["filePath"] },
      ],
    };
    const payload = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "read this" }],
      tools: [{
        type: "function",
        function: {
          name: "office_read-document",
          description: "Read supported Office/text documents into structured text.",
          parameters: officeReadParameters,
        },
      }],
    };

    const result = normalizeProviderPayload(payload, schemaOnlyKimiModel, { mode: "chat" });
    const parameters = result.tools[0].function.parameters;

    expect(result).not.toBe(payload);
    expect(result.tools).not.toBe(payload.tools);
    expect(payload.tools[0].function.parameters).toBe(officeReadParameters);
    expect(parameters).toHaveProperty("type", "object");
    expect(parameters).toHaveProperty("properties", officeReadParameters.properties);
    expect(parameters).not.toHaveProperty("anyOf");
    expect(parameters.description).toContain("required field sets: resource; filePath");
  });

  it("normalizes nested anyOf schemas without changing other providers", () => {
    const schemaOnlyKimiModel = {
      ...kimiOpenAIModel,
      reasoning: false,
      compat: {
        thinkingFormat: "kimi",
        reasoningProfile: "kimi-openai",
      },
    };
    const payload = {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "choose" }],
      tools: [{
        type: "function",
        function: {
          name: "choose",
          description: "Choose a value.",
          parameters: {
            type: "object",
            properties: {
              value: {
                type: "string",
                description: "The selected value.",
                anyOf: [
                  { enum: ["a"] },
                  { enum: ["b"] },
                ],
              },
            },
          },
        },
      }],
    };

    const kimiResult = normalizeProviderPayload(payload, schemaOnlyKimiModel, { mode: "chat" });
    const valueSchema = kimiResult.tools[0].function.parameters.properties.value;

    expect(kimiResult.tools[0].function.parameters).toHaveProperty("type", "object");
    expect(valueSchema).not.toHaveProperty("type");
    expect(valueSchema.description).toBe("The selected value.");
    expect(valueSchema.anyOf).toEqual([
      { type: "string", enum: ["a"] },
      { type: "string", enum: ["b"] },
    ]);

    const nonKimiResult = normalizeProviderPayload(payload, {
      id: "gpt-test",
      provider: "openai",
      api: "openai-completions",
    }, { mode: "chat" });
    expect(nonKimiResult).toBe(payload);
  });
});
