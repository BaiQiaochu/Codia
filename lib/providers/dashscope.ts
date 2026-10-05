/**
 * DashScope provider plugin
 *
 * 阿里云百炼 OpenAI 兼容接口，承载 Qwen、MiniMax（通过 DashScope 转发）、
 * GLM、Kimi、SiliconFlow 等众多模型。
 *
 * 文档：https://help.aliyun.com/zh/model-studio/developer-reference/use-qwen-by-calling-api
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const dashscopePlugin = {
  id: "dashscope",
  displayName: "阿里云百炼 (DashScope)",
  authType: "api-key",
  defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "wan2.7-image-pro",
        models: [
          { id: "wan2.7-image-pro", displayName: "Wan 2.7 Image Pro", protocolId: "dashscope-wan-images", inputs: ["text", "image"], outputs: ["image"], aliases: ["wan-2.7-pro"] },
          { id: "wan2.7-image", displayName: "Wan 2.7 Image", protocolId: "dashscope-wan-images", inputs: ["text", "image"], outputs: ["image"], aliases: ["wan-2.7"] },
          { id: "qwen-image-2.0-pro", displayName: "Qwen Image 2.0 Pro", protocolId: "dashscope-qwen-multimodal-image", inputs: ["text"], outputs: ["image"], aliases: ["qwen-image-pro"] },
          { id: "qwen-image-plus", displayName: "Qwen Image Plus", protocolId: "dashscope-qwen-text2image", inputs: ["text"], outputs: ["image"], aliases: ["qwen-image"] },
          { id: "qwen-image", displayName: "Qwen Image", protocolId: "dashscope-qwen-text2image", inputs: ["text"], outputs: ["image"] },
        ],
      },
      speechRecognition: {
        defaultModelId: "qwen3-asr-flash",
        models: [
          { id: "qwen3-asr-flash", displayName: "Qwen3 ASR Flash", protocolId: "dashscope-qwen-asr-chat", inputs: ["audio"], outputs: ["text"] },
        ],
      },
    },
  },
};
