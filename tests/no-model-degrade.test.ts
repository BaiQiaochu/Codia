import { describe, expect, it } from "vitest";
import { canRunBackgroundTask, resolveRunnableModel } from "../lib/runtime/model-availability.js";

describe("model availability runtime helper", () => {
  it("returns false when no available models exist", () => {
    expect(canRunBackgroundTask({
      availableModels: [],
      agentConfig: { models: { chat: { id: "gpt-test", provider: "openai" } } },
    })).toBe(false);
  });

  it("returns true when the configured chat model exists", () => {
    expect(canRunBackgroundTask({
      availableModels: [{ id: "gpt-test", provider: "openai", name: "GPT Test" }],
      agentConfig: { models: { chat: { id: "gpt-test", provider: "openai" } } },
    })).toBe(true);
  });

  it("resolves explicit runnable model override", () => {
    const model = resolveRunnableModel({
      availableModels: [{ id: "img-pro", provider: "local-image", name: "IMG Pro" }],
      agentConfig: {},
      explicitModel: { id: "img-pro", provider: "local-image" },
    });
    expect(model?.id).toBe("img-pro");
    expect(model?.provider).toBe("local-image");
  });
});
