import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { syncModels } from "../core/model-sync.ts";

function projectMimoModel(modelId) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-known-mimo-"));
  const modelsJsonPath = path.join(tempDir, "models.json");
  try {
    syncModels({
      mimo: {
        base_url: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [modelId],
      },
    }, { modelsJsonPath });
    const projected = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    return projected.providers.mimo.models[0];
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("MiMo known model capabilities", () => {
  it("projects MiMo V2.5 Pro as text-only so auxiliary vision can handle images", () => {
    const model = projectMimoModel("mimo-v2.5-pro");

    expect(model).toMatchObject({
      id: "mimo-v2.5-pro",
      name: "MiMo V2.5 Pro",
      input: ["text"],
      contextWindow: 1048576,
      maxTokens: 131072,
      reasoning: true,
    });
    expect(model.compat).not.toHaveProperty("hanaVideoInput");
  });

  it("keeps MiMo V2.5 full-modal while preserving Pi-compatible input", () => {
    const model = projectMimoModel("mimo-v2.5");

    expect(model).toMatchObject({
      id: "mimo-v2.5",
      input: ["text", "image"],
      compat: {
        hanaVideoInput: true,
        hanaAudioInput: true,
      },
    });
  });
});
