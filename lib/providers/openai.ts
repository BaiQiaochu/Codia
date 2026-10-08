/**
 * OpenAI provider plugin
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const openaiPlugin = {
  id: "openai",
  displayName: "OpenAI",
  authType: "api-key",
  defaultBaseUrl: "https://api.openai.com/v1",
  defaultApi: "openai-completions",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "gpt-image-1.5",
        models: [
          { id: "gpt-image-1.5", displayName: "GPT Image 1.5", protocolId: "openai-images", inputs: ["text", "image"], outputs: ["image"], supportsEdit: true, aliases: ["1.5"] },
          { id: "gpt-image-1", displayName: "GPT Image 1", protocolId: "openai-images", inputs: ["text", "image"], outputs: ["image"], supportsEdit: true, aliases: ["1"] },
          { id: "gpt-image-1-mini", displayName: "GPT Image 1 Mini", protocolId: "openai-images", inputs: ["text", "image"], outputs: ["image"], supportsEdit: true, aliases: ["1-mini", "mini"] },
          { id: "dall-e-3", displayName: "DALL-E 3", protocolId: "openai-images", inputs: ["text"], outputs: ["image"], aliases: ["dalle3"] },
        ],
      },
      speechRecognition: {
        defaultModelId: "gpt-4o-mini-transcribe",
        models: [
          { id: "gpt-4o-transcribe", displayName: "GPT-4o Transcribe", protocolId: "openai-audio-transcriptions", inputs: ["audio"], outputs: ["text"] },
          { id: "gpt-4o-mini-transcribe", displayName: "GPT-4o Mini Transcribe", protocolId: "openai-audio-transcriptions", inputs: ["audio"], outputs: ["text"] },
          { id: "whisper-1", displayName: "Whisper 1", protocolId: "openai-audio-transcriptions", inputs: ["audio"], outputs: ["text"] },
        ],
      },
    },
  },
};
