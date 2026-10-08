import { describe, expect, it } from "vitest";
import { ConfigCoordinator } from "../core/config-coordinator.js";

describe("ConfigCoordinator.getSharedModels", () => {
  it("保留完整的 {id, provider} 共享模型引用", () => {
    const coordinator = new ConfigCoordinator({
      getPrefs: () => ({
        getPreferences: () => ({}),
      }),
    });

    coordinator._prefs = () => ({
      utility_model: { id: "qwen3.6:35b-a3b-bf16", provider: "dashscope" },
      utility_large_model: { id: "qwen3.6:35b-a3b-bf16", provider: "dashscope" },
      summarizer_model: { id: "MiniMax-M2.7", provider: "minimax" },
    });

    expect(coordinator.getSharedModels()).toEqual({
      utility: { id: "qwen3.6:35b-a3b-bf16", provider: "dashscope" },
      utility_large: { id: "qwen3.6:35b-a3b-bf16", provider: "dashscope" },
      vision: null,
      vision_enabled: false,
      summarizer: { id: "MiniMax-M2.7", provider: "minimax" },
      compiler: null,
    });
  });
});
