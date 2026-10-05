import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";
import { ProviderCatalogStore } from "../core/provider-catalog.ts";
import { SEARCH_CAPABILITY_PROVIDERS } from "../shared/search-providers.ts";

let tmpDir: string;

function writeLegacyAddedModels(data: Record<string, any>) {
  fs.writeFileSync(
    path.join(tmpDir, "added-models.yaml"),
    YAML.dump(data, { indent: 2, lineWidth: -1, sortKeys: false, quotingType: "\"" }),
    "utf-8",
  );
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

describe("ProviderCatalogStore", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gsap-provider-catalog-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migrates legacy added-models.yaml into provider-catalog.json v2 with an audit backup", () => {
    writeLegacyAddedModels({
      _deleted_providers: ["old-provider"],
      providers: {
        zhipu: {
          api_key: "sk-test",
          base_url: "https://open.bigmodel.cn/api/paas/v4",
          api: "openai-completions",
          models: [
            {
              id: "glm-test",
              reasoning: true,
              defaultThinkingLevel: "max",
              compat: { thinkingFormat: "zhipu" },
            },
          ],
          media: {
            image_generation: {
              models: [{ id: "image-test", protocolId: "openai-images" }],
            },
          },
        },
      },
    });

    const store = new ProviderCatalogStore(tmpDir);
    const catalog = store.load();

    expect(catalog.catalogVersion).toBe(2);
    expect(catalog.providers.zhipu.models[0]).toMatchObject({
      id: "glm-test",
      reasoning: true,
      defaultThinkingLevel: "max",
      compat: { thinkingFormat: "zhipu" },
    });
    expect(catalog.providers.zhipu.media.image_generation.models[0]).toMatchObject({
      id: "image-test",
      protocolId: "openai-images",
    });
    expect(catalog.meta.deletedProviders).toEqual(["old-provider"]);
    expect(catalog.capabilities["web.search"]).toEqual({ providers: SEARCH_CAPABILITY_PROVIDERS });

    const persisted = readJson(store.catalogPath);
    expect(persisted.catalogVersion).toBe(2);

    const backupsRoot = path.join(tmpDir, "migration-backups");
    const backupDirs = fs.readdirSync(backupsRoot).filter((name) => name.startsWith("provider-catalog-v1-"));
    expect(backupDirs).toHaveLength(1);
    expect(fs.existsSync(path.join(backupsRoot, backupDirs[0], "added-models.yaml"))).toBe(true);
    expect(readJson(path.join(backupsRoot, backupDirs[0], "migration-report.json"))).toMatchObject({
      targetVersion: 2,
      providers: ["zhipu"],
    });
  });

  it("uses provider-catalog.json as the only live write target after migration", () => {
    writeLegacyAddedModels({
      providers: {
        openai: {
          api_key: "sk-old",
          base_url: "https://api.openai.com/v1",
          api: "openai-completions",
          models: ["gpt-4o"],
        },
      },
    });
    const legacyPath = path.join(tmpDir, "added-models.yaml");
    const legacyBefore = fs.readFileSync(legacyPath, "utf-8");

    const store = new ProviderCatalogStore(tmpDir);
    store.load();
    store.saveProviders({
      openai: {
        api_key: "sk-new",
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        models: [{ id: "gpt-4o", image: true }],
      },
    });

    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(legacyBefore);
    expect(readJson(store.catalogPath).providers.openai).toMatchObject({
      api_key: "sk-new",
      models: [{ id: "gpt-4o", image: true }],
    });
  });

  it("preserves structurally safe unknown capabilities for future adapters", () => {
    const store = new ProviderCatalogStore(tmpDir);
    store.save({
      catalogVersion: 2,
      providers: {
        custom: {
          base_url: "https://example.test/v1",
          api: "openai-completions",
          models: ["custom-chat"],
        },
      },
      capabilities: {
        "web.search": { providers: [{ id: "brave", source: "api" }] },
        "future.action": { providers: [{ id: "future", mode: "adapter" }] },
      },
    });

    const catalog = store.load();

    expect(catalog.capabilities["web.search"].providers).toEqual([{ id: "brave", source: "api" }]);
    expect(catalog.capabilities["future.action"].providers).toEqual([{ id: "future", mode: "adapter" }]);
  });
});
