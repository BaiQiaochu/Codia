// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

let execute, name, parameters;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../plugins/image-gen/tools/describe-media-options.js");
  execute = mod.execute;
  name = mod.name;
  parameters = mod.parameters;
});

describe("describe-media-options tool", () => {
  it("describes providers, models, modes, schemas, and input limits", async () => {
    expect(name).toBe("describe-media-options");
    expect(parameters.required).toEqual(["kind"]);

    const ctx = {
      bus: {
        request: vi.fn(async (type, payload) => {
          expect(type).toBe("provider:media-providers");
          expect(payload).toEqual({ capability: "image_generation" });
          return {
            providers: {
              "custom-image": {
                providerId: "custom-image",
                displayName: "Custom Image",
                models: [{
                  id: "image-pro",
                  displayName: "Image Pro",
                  inputLimits: { referenceImages: { max: 2 } },
                  modes: [{
                    id: "image2image",
                    label: "Image to Image",
                    defaults: { quality: "standard" },
                    inputLimits: { referenceImages: { min: 1, max: 2 } },
                    parameterSchema: {
                      type: "object",
                      properties: {
                        ratio: { type: "string", enum: ["1:1", "16:9"] },
                      },
                    },
                  }],
                }],
              },
            },
          };
        }),
      },
    };

    const result = await execute({
      kind: "image",
      provider: "custom-image",
      model: "image-pro",
      mode: "image2image",
    }, ctx);

    expect(result.details.mediaOptions).toMatchObject({
      kind: "image",
      providerId: "custom-image",
      model: {
        id: "image-pro",
        inputLimits: { referenceImages: { max: 2 } },
      },
      mode: {
        id: "image2image",
        defaults: { quality: "standard" },
        inputLimits: { referenceImages: { min: 1, max: 2 } },
        parameterSchema: {
          properties: {
            ratio: { enum: ["1:1", "16:9"] },
          },
        },
      },
    });
    expect(result.content[0].text).toContain("image2image");
  });
});
