import { describe, expect, it } from "vitest";
import {
  getDefaultModelId,
  getKnownModels,
  resolveModelId,
} from "../lib/model-catalog.js";

describe("image model catalog defaults", () => {
  it("keeps OpenAI default on gpt-image-1.5 while still exposing gpt-image-2", () => {
    expect(getDefaultModelId("openai")).toBe("gpt-image-1.5");
    expect(resolveModelId("openai", "")).toBe("gpt-image-1.5");
    expect(resolveModelId("openai", null)).toBe("gpt-image-1.5");
    expect(resolveModelId("openai", "2")).toBe("gpt-image-2");
    expect(getKnownModels("openai").map((model) => model.id)).toEqual(expect.arrayContaining([
      "gpt-image-1.5",
      "gpt-image-2",
      "dall-e-3",
    ]));
  });
});
