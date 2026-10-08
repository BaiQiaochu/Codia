/**
 * MiniMax provider plugin (API key)
 *
 * MiniMax 按量付费 API 接入。
 * 文档：https://platform.minimax.io/docs
 */

export const minimaxImageGenerationCapability = {
  defaultModelId: "image-01",
  credentialLanes: [
    { id: "minimax", providerId: "minimax", label: "MiniMax" },
    { id: "minimax-token-plan", providerId: "minimax-token-plan", label: "MiniMax Token Plan" },
  ],
  models: [
    { id: "image-01", displayName: "MiniMax Image 01", protocolId: "minimax-images", inputs: ["text", "image"], outputs: ["image"] },
    { id: "image-01-live", displayName: "MiniMax Image 01 Live", protocolId: "minimax-images", inputs: ["text", "image"], outputs: ["image"] },
  ],
};

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const minimaxPlugin = {
  id: "minimax",
  displayName: "MiniMax",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/anthropic",
  defaultApi: "anthropic-messages",
  capabilities: {
    media: {
      imageGeneration: minimaxImageGenerationCapability,
    },
  },
};
