/**
 * OpenAI provider plugin
 */

import { OPENAI_IMAGE_MODELS } from "../../shared/openai-image-models.ts";

const openAIImageCapabilityModels = OPENAI_IMAGE_MODELS.map((model) => ({
  id: model.id,
  displayName: model.name,
  protocolId: "openai-images",
  inputs: ["text", "image"],
  outputs: ["image"],
  supportsEdit: true,
  ...(model.aliases ? { aliases: [...model.aliases] } : {}),
}));

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const openaiPlugin = {
  id: "openai",
  displayName: "OpenAI",
  authType: "api-key",
  defaultBaseUrl: "https://api.openai.com/v1",
  // Current OpenAI reasoning models require Responses for tool use and
  // encrypted reasoning history. Individual custom providers may still choose
  // Chat Completions explicitly.
  defaultApi: "openai-responses",
  capabilities: {
    media: {
      imageGeneration: {
        defaultModelId: "gpt-image-1.5",
        models: [
          ...openAIImageCapabilityModels,
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
