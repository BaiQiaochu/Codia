import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { syncModels } from "../core/model-sync.js";

const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-model-sync-projection-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

describe("syncModels chat projection", () => {
  it("does not project SDK auth alias or hidden providers into models.json", () => {
    const modelsJsonPath = tempFile("models.json");

    const changed = syncModels({
      visible: {
        base_url: "https://visible.example.test/v1",
        api: "openai-completions",
        api_key: "sk-visible",
        models: ["visible-chat"],
      },
      alias: {
        base_url: "https://alias.example.test/v1",
        api: "openai-completions",
        api_key: "sk-alias",
        models: ["alias-chat"],
      },
      hidden: {
        base_url: "https://hidden.example.test/v1",
        api: "openai-completions",
        api_key: "sk-hidden",
        models: ["hidden-chat"],
      },
    }, {
      modelsJsonPath,
      chatProjectionMap: {
        alias: "sdk-auth-alias",
        hidden: "none",
      },
    });

    expect(changed).toBe(true);
    const data = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(Object.keys(data.providers)).toEqual(["visible"]);
  });
});
