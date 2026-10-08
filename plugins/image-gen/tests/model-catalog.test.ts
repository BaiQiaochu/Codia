import { describe, expect, it } from "vitest";
import {
  MODEL_CATALOG,
  getDefaultModelId,
  getKnownModels,
  resolveModelId,
} from "../lib/model-catalog.ts";

describe("MODEL_CATALOG", () => {
  it("contains the built-in public image provider catalogs", () => {
    expect(MODEL_CATALOG).toHaveProperty("volcengine");
    expect(MODEL_CATALOG).toHaveProperty("openai");
    expect(MODEL_CATALOG).toHaveProperty("comfyui");
  });

  it("keeps each catalog entry renderable", () => {
    for (const models of Object.values(MODEL_CATALOG)) {
      for (const model of models) {
        expect(model.id).toBeTruthy();
        expect(model.name).toBeTruthy();
      }
    }
  });

  it("has no more than one explicit default per provider", () => {
    for (const models of Object.values(MODEL_CATALOG)) {
      expect(models.filter((model) => model.default).length).toBeLessThanOrEqual(1);
    }
  });
});

describe("resolveModelId", () => {
  it("returns exact matches for known full model IDs", () => {
    expect(resolveModelId("volcengine", "doubao-seedream-3-0-t2i"))
      .toBe("doubao-seedream-3-0-t2i");
    expect(resolveModelId("openai", "gpt-image-1.5"))
      .toBe("gpt-image-1.5");
    expect(resolveModelId("openai", "gpt-image-2"))
      .toBe("gpt-image-2");
  });

  it("resolves short aliases to provider model IDs", () => {
    expect(resolveModelId("volcengine", "5.0"))
      .toBe("doubao-seedream-5-0");
    expect(resolveModelId("volcengine", "5.0-lite"))
      .toBe("doubao-seedream-5-0-lite-260128");
    expect(resolveModelId("volcengine", "3.0"))
      .toBe("doubao-seedream-3-0-t2i");
    expect(resolveModelId("volcengine", "4.5"))
      .toBe("doubao-seedream-4-5-251128");
  });

  it("resolves OpenAI aliases", () => {
    expect(resolveModelId("openai", "1.5")).toBe("gpt-image-1.5");
    expect(resolveModelId("openai", "mini")).toBe("gpt-image-1-mini");
    expect(resolveModelId("openai", "2")).toBe("gpt-image-2");
  });

  it("is case-insensitive for aliases", () => {
    expect(resolveModelId("volcengine", "5.0-LITE"))
      .toBe("doubao-seedream-5-0-lite-260128");
  });

  it("falls back to provider defaults only when no model is supplied", () => {
    expect(resolveModelId("volcengine", null)).toBe("doubao-seedream-5-0-lite-260128");
    expect(resolveModelId("volcengine", undefined)).toBe("doubao-seedream-5-0-lite-260128");
    expect(resolveModelId("openai", null)).toBe("gpt-image-1.5");
  });

  it("preserves unrecognized model strings for forward-compatible provider catalogs", () => {
    expect(resolveModelId("volcengine", "nonexistent-model")).toBe("nonexistent-model");
  });

  it("passes unknown provider values through without inventing defaults", () => {
    expect(resolveModelId("unknown-provider", null)).toBe("");
    expect(resolveModelId("unknown-provider", "some-model")).toBe("some-model");
  });
});

describe("getKnownModels", () => {
  it("returns public id/name entries without alias metadata", () => {
    const models = getKnownModels("volcengine");
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model).toHaveProperty("id");
      expect(model).toHaveProperty("name");
      expect(model).not.toHaveProperty("aliases");
    }
  });

  it("returns an empty array for unknown providers", () => {
    expect(getKnownModels("nonexistent")).toEqual([]);
  });
});

describe("getDefaultModelId", () => {
  it("returns the configured provider default model", () => {
    expect(getDefaultModelId("volcengine")).toBe("doubao-seedream-5-0-lite-260128");
    expect(getDefaultModelId("openai")).toBe("gpt-image-1.5");
  });

  it("returns null for unknown providers", () => {
    expect(getDefaultModelId("nonexistent")).toBeNull();
  });
});
