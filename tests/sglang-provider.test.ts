// @ts-nocheck
import { describe, expect, it } from "vitest";
import { ExecutionRouter } from "../core/execution-router.js";

describe("SGLang provider compatibility", () => {
  it("resolves no-auth SGLang chat models with a synthetic local key", () => {
    const router = new ExecutionRouter(
      () => ({ id: "qwen3-32b", provider: "sglang", api: "openai-completions" }),
      {
        getCredentials: () => ({
          apiKey: "",
          baseUrl: "https://sglang.example.test/v1",
          api: "openai-completions",
          authType: "none",
        }),
      },
    );

    const result = router.resolve("chat", {
      models: { chat: { id: "qwen3-32b", provider: "sglang" } },
    });

    expect(result).toMatchObject({
      modelId: "qwen3-32b",
      providerId: "sglang",
      apiKey: "local",
      baseUrl: "https://sglang.example.test/v1",
    });
  });

  it("resolves no-auth SGLang utility models", () => {
    const router = new ExecutionRouter(
      () => ({ id: "qwen3-32b", provider: "sglang", api: "openai-completions" }),
      {
        getCredentials: () => ({
          apiKey: "",
          baseUrl: "https://sglang.example.test/v1",
          api: "openai-completions",
          authType: "none",
        }),
      },
    );

    const result = router.resolveUtilityConfig({
      models: { chat: { id: "qwen3-32b", provider: "sglang" } },
    });

    expect(result.api_key).toBe("local");
    expect(result.large_api_key).toBe("local");
  });
});
