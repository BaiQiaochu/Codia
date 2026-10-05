/**
 * Volcengine Speech provider.
 *
 * BigASR uses the OpenSpeech endpoint and credentials that are not the same
 * operational lane as Ark chat/image endpoints, so it is modeled separately.
 */

/** @type {import('../../core/provider-registry.ts').ProviderPlugin} */
export const volcengineSpeechPlugin = {
  id: "volcengine-speech",
  displayName: "Volcengine Speech (BigASR)",
  authType: "api-key",
  defaultBaseUrl: "https://openspeech.bytedance.com",
  defaultApi: "volcengine-bigasr",
  capabilities: {
    media: {
      speechRecognition: {
        defaultModelId: "bigasr-flash",
        models: [
          { id: "bigasr-flash", displayName: "BigASR Flash", protocolId: "volcengine-bigasr-transcription", inputs: ["audio"], outputs: ["text"], aliases: ["bigasr", "bigasr-auc"] },
        ],
      },
    },
  },
};
