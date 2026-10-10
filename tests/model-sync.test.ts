// @ts-nocheck
/**
 * model-sync.ts 单元测试
 *
 * 测试：added-models.yaml → models.json 单向投影
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "js-yaml";

// mock known-models 词典查询：provider + model 二级结构，未命中时再查通用 fallback
const KNOWN_MODELS = {
  dashscope: {
    "qwen3.5-flash": {
      name: "Qwen3.5 Flash",
      context: 131072,
      maxOutput: 8192,
      image: true,
      reasoning: true,
      quirks: ["enable_thinking"],
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
    "qwen3.6-plus": {
      name: "Qwen3.6 Plus",
      context: 1000000,
      maxOutput: 65536,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
    "qwen3-vl-plus": {
      name: "Qwen3 VL Plus",
      context: 262144,
      maxOutput: 32768,
      image: true,
      video: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "qwen", groundingMode: "native" },
    },
  },
  deepseek: {
    "deepseek-chat": { name: "DeepSeek Chat", context: 128000, maxOutput: 8192 },
    "deepseek-v4-pro": { name: "DeepSeek V4 Pro", context: 1000000, maxOutput: 384000, reasoning: true, xhigh: true },
  },
  zhipu: {
    "glm-4.7-flash": { name: "GLM-4.7 Flash", context: 200000, maxOutput: 128000, reasoning: true },
  },
  openai: {
    "gpt-6.1-sol": {
      name: "GPT-6.1 Sol",
      api: "openai-responses",
      context: 1048576,
      maxOutput: 128000,
      image: true,
      reasoning: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    },
    "gpt-4o": {
      name: "GPT-4o",
      context: 128000,
      maxOutput: 16384,
      image: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
    "gpt-audio-mini": {
      name: "GPT Audio Mini",
      context: 128000,
      maxOutput: 16384,
      audio: true,
    },
    "gpt-image-1": { name: "GPT Image 1", type: "image" },
  },
  gemini: {
    "gemini-3-flash-preview": {
      name: "Gemini 3 Flash Preview",
      context: 1048576,
      maxOutput: 65535,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: false, coordinateSpace: "norm-1000", boxOrder: "yxyx", outputFormat: "gemini", groundingMode: "native" },
    },
  },
  "kimi-coding": {
    "kimi-for-coding": {
      name: "Kimi for Coding",
      context: 262144,
      maxOutput: 32768,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
    "kimi-k2.6": {
      name: "Kimi K2.6",
      context: 262144,
      maxOutput: 98304,
      image: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
  },
  moonshot: {
    "kimi-k2.6": {
      name: "Kimi K2.6",
      context: 262144,
      maxOutput: 98304,
      image: true,
      video: true,
      reasoning: true,
      visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
    },
  },
  minimax: {
    "MiniMax-M2.7": { name: "MiniMax M2.7", context: 204800, maxOutput: 131072, reasoning: true },
  },
  mimo: {
    "mimo-v2.5": {
      name: "MiMo V2.5",
      context: 1048576,
      maxOutput: 131072,
      image: true,
      video: true,
      audio: true,
      reasoning: true,
    },
  },
  openrouter: {
    "deepseek/deepseek-v3.2": {
      name: "Deepseek/Deepseek V3.2",
      context: 163840,
      maxOutput: 163840,
      reasoning: true,
    },
    "xiaomi/mimo-v2-flash": {
      name: "Xiaomi/Mimo V2 Flash",
      context: 262144,
      maxOutput: 16384,
      reasoning: true,
    },
  },
  // 兼容读验证：legacy-vision 模型词典里用旧字段 vision，model-sync 应当识别并投影为 input
  legacy: {
    "legacy-vision-model": { name: "Legacy Vision Model", context: 32000, vision: true },
  },
};

const GENERIC_MODEL_FALLBACKS = {
  "kimi-k2.6": {
    name: "Kimi K2.6",
    context: 262144,
    maxOutput: 98304,
    image: true,
    reasoning: true,
    visionCapabilities: { grounding: true, boxes: true, points: true, coordinateSpace: "norm-1000", boxOrder: "xyxy", outputFormat: "anchor", groundingMode: "prompted" },
  },
  "MiniMax-M3": {
    name: "MiniMax M3",
    context: 1000000,
    maxOutput: 524288,
    image: true,
    reasoning: true,
  },
};

vi.mock("../shared/known-models.ts", () => ({
  lookupKnown(provider, modelId) {
    const lookup = (dict, id) => {
      if (!dict || typeof id !== "string") return null;
      if (dict[id]) return dict[id];
      const lowerId = id.toLowerCase();
      return Object.entries(dict).find(([key]) => key.toLowerCase() === lowerId)?.[1] || null;
    };
    if (provider) {
      const exact = lookup(KNOWN_MODELS[provider], modelId);
      if (exact) return exact;
    }
    const bare = modelId.includes("/") ? modelId.split("/").pop() : null;
    if (bare && provider) {
      const exactBare = lookup(KNOWN_MODELS[provider], bare);
      if (exactBare) return exactBare;
    }
    const fallback = lookup(GENERIC_MODEL_FALLBACKS, modelId);
    if (fallback) return fallback;
    if (bare) {
      const fallbackBare = lookup(GENERIC_MODEL_FALLBACKS, bare);
      if (fallbackBare) return fallbackBare;
    }
    return null;
  },
}));

const tmpDir = path.join(os.tmpdir(), "codia-test-model-sync-" + Date.now());
let modelsJsonPath;
let authJsonPath;

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  modelsJsonPath = path.join(tmpDir, "models.json");
  authJsonPath = path.join(tmpDir, "auth.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSync() {
  const mod = await import("../core/model-sync.ts");
  return mod.syncModels;
}

describe("syncModels", () => {
  it("routes current OpenAI tool models through Responses even when the provider has a legacy default", async () => {
    const syncModels = await loadSync();
    syncModels({
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gpt-6.1-sol"],
      },
    }, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.openai.models[0]).toMatchObject({
      id: "gpt-6.1-sol",
      api: "openai-responses",
      reasoning: true,
    });
    expect(result.providers.openai.models[0].thinkingLevelMap.off).toBeNull();
  });

  it("writes providers with credentials and models to models.json", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeDefined();
    expect(result.providers.dashscope.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(result.providers.dashscope.api).toBe("openai-completions");
    expect(result.providers.dashscope.apiKey).toBeUndefined();
    expect(result.providers.dashscope.models).toHaveLength(1);
    expect(result.providers.dashscope.models[0].id).toBe("qwen3.5-flash");
  });

  it("keeps user-entered API keys out of persisted Pi model configuration", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "public",
        models: ["my-custom-model"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.apiKey).toBeUndefined();
  });

  it("projects per-model default thinking level into runtime model metadata", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "reasoning-model", reasoning: true, defaultThinkingLevel: "high" },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0]).toMatchObject({
      id: "reasoning-model",
      defaultThinkingLevel: "high",
    });
  });

  it("projects provider model_defaults into runtime model metadata", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["reasoning-model"],
        model_defaults: {
          "reasoning-model": { thinking_level: "high" },
        },
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0]).toMatchObject({
      id: "reasoning-model",
      defaultThinkingLevel: "high",
    });
  });

  it("skips providers without api_key (and not localhost/OAuth)", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        // no api_key
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
    expect(Object.keys(result.providers)).toHaveLength(0);
  });

  it("skips providers without models", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        // no models
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
  });

  it("skips providers without base_url", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        // no base_url
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope).toBeUndefined();
  });

  it("enriches model metadata from known-models dictionary", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.dashscope.models[0];
    expect(model.name).toBe("Qwen3.5 Flash");
    expect(model.contextWindow).toBe(131072);
    expect(model.maxTokens).toBe(8192);
    expect(model.input).toEqual(["text", "image"]);
    // 运行时 Model 对象不再挂 vision 字段（Pi SDK 标准用 input 数组）
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(true);
    expect(model.quirks).toEqual(["enable_thinking"]);
    expect(model.compat.thinkingFormat).toBe("qwen");
  });

  it("projects native and prompted visual grounding family formats", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3-vl-plus", "qwen3.5-flash", "qwen3.6-plus"],
      },
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gpt-4o"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope.models[0].visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: true,
      coordinateSpace: "norm-1000",
      boxOrder: "xyxy",
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.dashscope.models[1].visionCapabilities).toMatchObject({
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.dashscope.models[2].visionCapabilities).toMatchObject({
      outputFormat: "qwen",
      groundingMode: "native",
    });
    expect(result.providers.openai.models[0].visionCapabilities).toMatchObject({
      outputFormat: "anchor",
      groundingMode: "prompted",
    });
  });

  it("accepts explicit user visual grounding capabilities for custom image models", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{
          id: "custom-grounded-vl",
          image: true,
          visionCapabilities: {
            grounding: true,
            boxes: true,
            points: false,
            coordinateSpace: "norm-1000",
            boxOrder: "yxyx",
            outputFormat: "gemini",
            groundingMode: "native",
          },
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models[0].visionCapabilities).toEqual({
      grounding: true,
      boxes: true,
      points: false,
      coordinateSpace: "norm-1000",
      boxOrder: "yxyx",
      outputFormat: "gemini",
      groundingMode: "native",
    });
  });

  it("enriches provider models from generic fallbacks when provider-specific metadata is missing", async () => {
    const syncModels = await loadSync();

    const providers = {
      volcengine: {
        base_url: "https://ark.cn-beijing.volces.com/api/v3",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.volcengine.models[0];
    expect(model.name).toBe("Kimi K2.6");
    expect(model.contextWindow).toBe(262144);
    expect(model.maxTokens).toBe(98304);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.reasoning).toBe(true);
  });

  it("projects Kimi Coding Plan stable model with Anthropic thinking compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["kimi-for-coding"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"]).toMatchObject({
      baseUrl: "https://api.kimi.com/coding/",
      api: "anthropic-messages",
    });
    expect(result.providers["kimi-coding"].models).toBeUndefined();
    expect(result.providers["kimi-coding"].modelOverrides).toBeUndefined();
  });

  it("preserves user metadata for Pi built-in Kimi Coding models as model overrides", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [{ id: "kimi-for-coding", name: "Kimi 自定义显示名", maxOutput: 16000, image: true, video: true }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"].models).toBeUndefined();
    expect(result.providers["kimi-coding"].modelOverrides["kimi-for-coding"]).toEqual({
      name: "Kimi 自定义显示名",
      maxTokens: 16000,
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
    });
  });

  it("keeps Kimi OpenAI-compatible configs custom while reusing Pi request headers", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-for-coding"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers["kimi-coding"].models[0];
    expect(model.id).toBe("kimi-for-coding");
    expect(model.headers).toEqual({ "User-Agent": "KimiCLI/1.5" });
  });

  it("marks Anthropic-compatible reasoning models with anthropic thinking format", async () => {
    const syncModels = await loadSync();

    const providers = {
      "kimi-coding": {
        base_url: "https://api.kimi.com/coding/",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
      minimax: {
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["MiniMax-M2.7"],
      },
      "minimax-token-plan": {
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-token-plan",
        models: ["MiniMax-M3"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["kimi-coding"].models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
    });
    expect(result.providers.minimax.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
    });
    expect(result.providers["minimax-token-plan"].api).toBe("anthropic-messages");
    expect(result.providers["minimax-token-plan"].baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(result.providers["minimax-token-plan"].apiKey).toBeUndefined();
    expect(result.providers["minimax-token-plan"].models[0]).toMatchObject({
      id: "MiniMax-M3",
      name: "MiniMax M3",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 524288,
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "anthropic",
      },
    });
    expect(result.providers["minimax-token-plan"].models[0].compat?.codiaVideoInput).toBeUndefined();
  });

  it("projects MiniMax Anthropic providers with x-api-key auth", async () => {
    const syncModels = await loadSync();

    const providers = {
      "minimax-token-plan": {
        base_url: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-token-plan",
        models: ["MiniMax-M3"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["minimax-token-plan"]).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://api.minimaxi.com/anthropic",
    });
    expect(result.providers["minimax-token-plan"].authHeader).toBeUndefined();
  });

  it("marks DeepSeek V4 on the Anthropic endpoint with an explicit reasoning profile", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: ["deepseek-v4-pro"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.deepseek.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "anthropic",
      reasoningProfile: "deepseek-v4-anthropic",
    });
  });

  it("does not infer thinkingFormat from Anthropic protocol without reasoning capability", async () => {
    const syncModels = await loadSync();

    const providers = {
      "custom-anthropic-proxy": {
        base_url: "https://example.test/anthropic",
        api: "anthropic-messages",
        api_key: "sk-test",
        models: [{ id: "plain-chat", reasoning: false }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["custom-anthropic-proxy"].models[0].compat).toEqual({
      supportsDeveloperRole: false,
    });
  });

  it("sets input: ['text'] for models without image modality (no vision field on Model)", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.deepseek.models[0];
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(false);
    expect(model.input).toEqual(["text"]);
  });

  it("projects explicit video capability into Codia compat and keeps Pi input schema-compatible", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "custom-video", video: true },
          { id: "custom-multimodal", image: true, video: true },
          "custom-unknown",
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models.map((m) => [m.id, m.input, m.compat?.codiaVideoInput])).toEqual([
      ["custom-video", ["text"], true],
      ["custom-multimodal", ["text", "image"], true],
      ["custom-unknown", ["text"], undefined],
    ]);
  });

  it("projects explicit audio capability into Codia compat and keeps Pi input schema-compatible", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "custom-audio", audio: true },
          { id: "custom-full-modal", image: true, video: true, audio: true },
          "custom-unknown",
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.custom.models.map((m) => [m.id, m.input, m.compat?.codiaVideoInput, m.compat?.codiaAudioInput])).toEqual([
      ["custom-audio", ["text"], undefined, true],
      ["custom-full-modal", ["text", "image"], true, true],
      ["custom-unknown", ["text"], undefined, undefined],
    ]);
  });

  it("projects known OpenAI audio models into Codia compat without invalid Pi input", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gpt-audio-mini"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.openai.models[0]).toMatchObject({
      id: "gpt-audio-mini",
      input: ["text"],
      compat: { codiaAudioInput: true },
    });
  });

  it("projects known video-capable models into Codia compat without invalid Pi input", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3-vl-plus"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.dashscope.models[0].input).toEqual(["text", "image"]);
    expect(result.providers.dashscope.models[0].compat.codiaVideoInput).toBe(true);
  });

  it("projects Moonshot Kimi official video capability into Codia compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      moonshot: {
        base_url: "https://api.moonshot.cn/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["kimi-k2.6"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.moonshot.models[0]).toMatchObject({
      id: "kimi-k2.6",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
    });
  });

  it("projects MiMo V2.5 full-modal metadata without invalid Pi input", async () => {
    const syncModels = await loadSync();

    const providers = {
      mimo: {
        base_url: "https://api.xiaomimimo.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["mimo-v2.5"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.mimo.models[0];
    expect(model).toMatchObject({
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 131072,
      reasoning: true,
    });
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      codiaVideoInput: true,
      codiaAudioInput: true,
      thinkingFormat: "qwen-chat-template",
      reasoningProfile: "mimo-openai",
    });
  });

  it("projects Xiaomi Token Plan MiMo models with MiMo thinking compat", async () => {
    const syncModels = await loadSync();

    const providers = {
      "xiaomi-token": {
        base_url: "https://token-plan-cn.xiaomimimo.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{
          id: "mimo-v2.5-pro",
          context: 1048576,
          maxOutput: 65536,
          reasoning: true,
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers["xiaomi-token"].models[0];
    expect(model).toMatchObject({
      id: "mimo-v2.5-pro",
      input: ["text"],
      contextWindow: 1048576,
      maxTokens: 65536,
      reasoning: true,
    });
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "qwen-chat-template",
      reasoningProfile: "mimo-openai",
    });
  });

  it("projects OpenRouter reasoning models with OpenRouter thinking compat without official provider profiles", async () => {
    const syncModels = await loadSync();

    const providers = {
      openrouter: {
        base_url: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["DeepSeek/DeepSeek-V3.2", "xiaomi/MiMo-V2-Flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const [deepseek, mimo] = result.providers.openrouter.models;
    expect(deepseek).toMatchObject({
      id: "DeepSeek/DeepSeek-V3.2",
      contextWindow: 163840,
      maxTokens: 163840,
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
      },
    });
    expect(deepseek.compat).not.toHaveProperty("reasoningProfile");

    expect(mimo).toMatchObject({
      id: "xiaomi/MiMo-V2-Flash",
      contextWindow: 262144,
      maxTokens: 16384,
      reasoning: true,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "openrouter",
      },
    });
    expect(mimo.compat).not.toHaveProperty("reasoningProfile");
  });

  it("writes Pi-loadable models when Codia video compatibility is enabled", async () => {
    const syncModels = await loadSync();
    const { ModelRuntime, createModelRegistry } = await import("../lib/pi-sdk/index.ts");

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3-vl-plus"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const runtime = await ModelRuntime.create({ authPath: path.join(tmpDir, "auth.json"), modelsPath: modelsJsonPath, allowModelNetwork: false });
    await runtime.setRuntimeApiKey("dashscope", "sk-test");
    const registry = createModelRegistry(runtime);
    const available = await registry.getAvailable();
    expect(available).toHaveLength(1);
    expect(available[0]).toMatchObject({
      id: "qwen3-vl-plus",
      provider: "dashscope",
      input: ["text", "image"],
      compat: { codiaVideoInput: true },
    });
  });

  it("rejects the official DeepSeek provider id before writing models.json", async () => {
    const syncModels = await loadSync();

    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["deepseek"],
      },
    };

    expect(() => syncModels(providers, { modelsJsonPath }))
      .toThrow(/deepseek.*provider.*model/i);
    expect(fs.existsSync(modelsJsonPath)).toBe(false);
  });

  it("accepts legacy 'vision' field in dictionary and projects to input array", async () => {
    const syncModels = await loadSync();
    const providers = {
      legacy: {
        base_url: "https://legacy.api.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["legacy-vision-model"],
      },
    };
    syncModels(providers, { modelsJsonPath });
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.legacy.models[0];
    expect(model.input).toEqual(["text", "image"]);
    expect(model.vision).toBeUndefined();
  });

  it("accepts legacy 'vision' field in user override and projects to input array", async () => {
    const syncModels = await loadSync();
    const providers = {
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [{ id: "deepseek-chat", vision: true }],  // legacy user override
      },
    };
    syncModels(providers, { modelsJsonPath });
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.deepseek.models[0];
    expect(model.input).toEqual(["text", "image"]);
    expect(model.vision).toBeUndefined();
  });

  it("handles model objects with user overrides (name, context, maxOutput)", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: [
          { id: "qwen3.5-flash", name: "My Custom Qwen", context: 65536, maxOutput: 4096 },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.dashscope.models[0];
    expect(model.id).toBe("qwen3.5-flash");
    expect(model.name).toBe("My Custom Qwen");
    expect(model.contextWindow).toBe(65536);
    expect(model.maxTokens).toBe(4096);
  });

  it("uses atomic write (tmp + rename)", async () => {
    const syncModels = await loadSync();

    const renameSpy = vi.spyOn(fs, "renameSync");

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    // renameSync should have been called with a tmp path → final path
    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [src, dest] = renameSpy.mock.calls[0];
    expect(dest).toBe(modelsJsonPath);
    expect(src).toMatch(/\.tmp$/);

    renameSpy.mockRestore();
  });

  it("returns false if no changes", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["qwen3.5-flash"],
      },
    };

    // first call: writes
    const changed1 = syncModels(providers, { modelsJsonPath });
    expect(changed1).toBe(true);

    // second call: same data, no change
    const changed2 = syncModels(providers, { modelsJsonPath });
    expect(changed2).toBe(false);
  });

  it("allows localhost providers without api_key", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:11434/v1",
        api: "openai-completions",
        // no api_key — but localhost, should pass
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("projects bare Ollama OpenAI-compatible base URLs to the /v1 runtime API root", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:51434",
        api: "openai-completions",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama.baseUrl).toBe("http://localhost:51434/v1");
  });

  it("does not duplicate /v1 for Ollama OpenAI-compatible base URLs", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://localhost:51434/v1/",
        api: "openai-completions",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama.baseUrl).toBe("http://localhost:51434/v1");
  });

  it("allows IPv6 loopback providers without api_key", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://[::1]:11434/v1",
        api: "openai-completions",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("allows no-auth providers without api_key on remote base URLs", async () => {
    const syncModels = await loadSync();

    const providers = {
      ollama: {
        base_url: "http://192.168.1.20:11434/v1",
        api: "openai-completions",
        auth_type: "none",
        models: ["llama3"],
      },
    };

    const changed = syncModels(providers, { modelsJsonPath });

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(result.providers.ollama.models[0].id).toBe("llama3");
  });

  it("derives no-auth policy from ProviderRegistry for existing Ollama configs", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
      "providers:",
      "  ollama:",
      "    base_url: http://192.168.1.20:11434/v1",
      "    api: openai-completions",
      "    models:",
      "      - llama3",
      "",
    ].join("\n"), "utf-8");

    const mm = new ModelManager({ codiaHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([{ id: "llama3", provider: "ollama" }]),
    };

    const changed = await mm.syncAndRefresh();

    expect(changed).toBe(true);
    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.ollama).toBeDefined();
    expect(result.providers.ollama.apiKey).toBe("local");
    expect(mm._modelRegistry.refresh).toHaveBeenCalledTimes(1);
    expect(mm.availableModels).toEqual([{ id: "llama3", provider: "ollama" }]);
  });

  it("stores model thinking defaults without narrowing builtin provider model availability", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), "providers: {}\n", "utf-8");

    const mm = new ModelManager({ codiaHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([
        { id: "gpt-4o", provider: "openai" },
        { id: "gpt-5", provider: "openai" },
      ]),
    };
    await mm.refreshAvailable();

    const result = await mm.setModelDefaultThinkingLevel({ id: "gpt-4o", provider: "openai" }, "high");

    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, "provider-catalog.json"), "utf-8"));
    expect(raw.providers.openai.models).toBeUndefined();
    expect(raw.providers.openai.model_defaults).toEqual({
      "gpt-4o": { thinking_level: "high" },
    });
    expect(result.thinkingLevel).toBe("high");
    expect(mm.availableModels.map(m => m.id)).toEqual(["gpt-4o", "gpt-5"]);
    expect(mm.availableModels.find(m => m.id === "gpt-4o")?.defaultThinkingLevel).toBe("high");
  });

  it("applies provider model metadata to available models", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
      "providers:",
      "  deepseek:",
      "    base_url: https://api.deepseek.com/v1",
      "    api: openai-completions",
      "    api_key: sk-deep",
      "    models:",
      "      - id: deepseek-v4-pro",
      "        thinkingLevels: [off, medium, high, max]",
      "        toolUse:",
      "          native: true",
      "        visionCapabilities:",
      "          grounding: true",
      "    model_defaults:",
      "      deepseek-v4-pro:",
      "        thinking_level: xhigh",
      "",
    ].join("\n"), "utf-8");

    const mm = new ModelManager({ codiaHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([
        { id: "deepseek-v4-pro", provider: "deepseek" },
      ]),
    };

    await mm.syncAndRefresh();

    const model = mm.availableModels.find(m => m.id === "deepseek-v4-pro");
    expect(model?.thinkingLevels).toEqual(["off", "medium", "high", "max"]);
    expect(model?.defaultThinkingLevel).toBe("xhigh");
    expect(model?.xhigh).toBe(true);
    expect(model?.toolUse).toEqual({ native: true });
    expect(model?.visionCapabilities).toEqual(expect.objectContaining({ grounding: true }));
  });

  it("ignores malformed provider records without breaking valid model projection", async () => {
    const { ModelManager } = await import("../core/model-manager.ts");
    fs.writeFileSync(path.join(tmpDir, "added-models.yaml"), [
      "providers:",
      "  deepseek:",
      "    base_url: https://api.deepseek.com/v1",
      "    api: openai-completions",
      "    api_key: sk-deep",
      "    models:",
      "      - deepseek-chat",
      "  dashscope-coding:",
      "  string-provider: broken",
      "",
    ].join("\n"), "utf-8");

    const mm = new ModelManager({ codiaHome: tmpDir });
    mm._modelRegistry = {
      refresh: vi.fn(),
      getAvailable: vi.fn().mockResolvedValue([
        { id: "deepseek-chat", provider: "deepseek" },
        { id: "unconfigured-model", provider: "other" },
      ]),
    };

    await expect(mm.syncAndRefresh()).resolves.toBe(true);

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.deepseek.models[0].id).toBe("deepseek-chat");
    expect(result.providers["dashscope-coding"]).toBeUndefined();
    expect(result.providers["string-provider"]).toBeUndefined();
    expect(mm.availableModels).toEqual([
      { id: "deepseek-chat", provider: "deepseek" },
    ]);
  });

  it("handles multiple providers in one call", async () => {
    const syncModels = await loadSync();

    const providers = {
      dashscope: {
        base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        api: "openai-completions",
        api_key: "sk-dash",
        models: ["qwen3.5-flash"],
      },
      deepseek: {
        base_url: "https://api.deepseek.com/v1",
        api: "openai-completions",
        api_key: "sk-deep",
        models: ["deepseek-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(Object.keys(result.providers)).toHaveLength(2);
    expect(result.providers.dashscope.models[0].id).toBe("qwen3.5-flash");
    expect(result.providers.deepseek.models[0].id).toBe("deepseek-chat");
    expect(result.providers.deepseek.models[0].name).toBe("DeepSeek Chat");
  });

  it("projects Gemini native API without OpenAI-chat store compatibility flags", async () => {
    const syncModels = await loadSync();

    const providers = {
      gemini: {
        base_url: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        api_key: "sk-test",
        models: ["gemini-3-flash-preview"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.gemini.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(result.providers.gemini.api).toBe("google-generative-ai");
    expect(result.providers.gemini.models[0].compat).toEqual({
      supportsDeveloperRole: false,
    });
  });

  it("sets compat.supportsStore=false for Gemini OpenAI compatibility configs (avoid 400 from /v1beta/openai)", async () => {
    const syncModels = await loadSync();

    const providers = {
      gemini: {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-2.0-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.gemini.models[0].compat).toBeDefined();
    expect(result.providers.gemini.models[0].compat.supportsStore).toBe(false);
  });

  it("sets compat.supportsStore=false when base_url points at generativelanguage even with non-gemini provider id", async () => {
    const syncModels = await loadSync();

    const providers = {
      "my-gemini-proxy": {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["gemini-2.0-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["my-gemini-proxy"].models[0].compat.supportsStore).toBe(false);
  });

  it("projects Zhipu OpenAI-compatible configs with explicit unsupported OpenAI fields", async () => {
    const syncModels = await loadSync();

    const providers = {
      zhipu: {
        base_url: "https://open.bigmodel.cn/api/paas/v4",
        api: "openai-completions",
        api_key: "sk-test",
        models: ["glm-4.7-flash"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers.zhipu.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: false,
      thinkingFormat: "zhipu",
      reasoningProfile: "zhipu-openai",
    });
  });

  it("skips models with type: image from models.json output", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        api: "openai-completions",
        models: [
          "gpt-4o",
          { id: "gpt-image-1", type: "image" },
        ],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers.openai?.models || [];
    const ids = models.map(m => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("gpt-image-1");
  });

  it("skips string model entries whose type is image via known-models lookup", async () => {
    const syncModels = await loadSync();

    const providers = {
      openai: {
        base_url: "https://api.openai.com/v1",
        api_key: "sk-test",
        api: "openai-completions",
        models: ["gpt-4o", "gpt-image-1"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const models = result.providers.openai?.models || [];
    const ids = models.map(m => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).not.toContain("gpt-image-1");
  });

  it("falls back to humanized name for unknown models", async () => {
    const syncModels = await loadSync();

    const providers = {
      custom: {
        base_url: "https://custom.api.com/v1",
        api: "openai-completions",
        api_key: "sk-custom",
        models: ["my-custom-model-240101"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    const model = result.providers.custom.models[0];
    // date suffix stripped, humanized
    expect(model.name).toBe("My Custom Model");
    expect(model.contextWindow).toBe(128000); // default
    expect(model.input).toEqual(["text"]); // unknown model defaults to text-only
    expect(model.vision).toBeUndefined();
    expect(model.reasoning).toBe(false);
  });

  it("preserves explicit model compat declarations from custom provider config", async () => {
    const syncModels = await loadSync();

    const providers = {
      "opencode-go": {
        base_url: "https://opencode.example.test/v1",
        api: "openai-completions",
        api_key: "sk-custom",
        models: [{
          id: "deepseek-v4-pro",
          reasoning: true,
          compat: { thinkingFormat: "deepseek" },
        }],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["opencode-go"].models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: "deepseek",
    });
  });

  it("projects provider request headers into models.json even without an api key", async () => {
    const syncModels = await loadSync();

    const providers = {
      "gateway-provider": {
        base_url: "https://gateway.example/v1",
        api: "openai-completions",
        headers: {
          Authorization: "Bearer gateway-token",
          "X-Corp-Auth": "corp-token",
        },
        models: ["gateway-chat"],
      },
    };

    syncModels(providers, { modelsJsonPath });

    const result = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8"));
    expect(result.providers["gateway-provider"]).toMatchObject({
      baseUrl: "https://gateway.example/v1",
      api: "openai-completions",
      headers: {
        Authorization: "Bearer gateway-token",
        "X-Corp-Auth": "corp-token",
      },
    });
    expect(result.providers["gateway-provider"].models[0].id).toBe("gateway-chat");
  });
});
