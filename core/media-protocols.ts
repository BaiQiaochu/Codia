import { isOpenAIImageModelId } from "../shared/openai-image-models.ts";

export const MEDIA_CAPABILITY_KEYS = {
  image_generation: "imageGeneration",
  image: "imageGeneration",
  video_generation: "videoGeneration",
  video: "videoGeneration",
  speech_generation: "speechGeneration",
  speech_recognition: "speechRecognition",
  speechRecognition: "speechRecognition",
  transcription: "speechRecognition",
  asr: "speechRecognition",
  speech: "speechGeneration",
  music_generation: "musicGeneration",
  music: "musicGeneration",
};

const OPENAI_COMPATIBLE_APIS = new Set(["openai-completions", "openai-responses"]);

export function capabilityKey(capability) {
  return MEDIA_CAPABILITY_KEYS[capability] || capability;
}

export function inferMediaProtocolId(
  providerId,
  capability,
  modelId,
  provider: { api?: string; sourceKind?: string } = {},
) {
  const key = capabilityKey(capability);
  const id = String(modelId || "");

  if (key === "imageGeneration") {
    if (providerId === "openai-codex-oauth") return "openai-codex-responses-image";
    if (providerId === "openai" && isOpenAIImageModelId(id)) return "openai-images";
    if (providerId === "volcengine" && id.includes("seedream")) return "volcengine-images";
    if (providerId === "dashscope" && id.startsWith("wan")) return "dashscope-wan-images";
    if (providerId === "dashscope" && id.startsWith("qwen-image-2")) return "dashscope-qwen-multimodal-image";
    if (providerId === "dashscope" && id.startsWith("qwen-image")) return "dashscope-qwen-text2image";
    if (providerId === "minimax" && (id.startsWith("image-") || !id)) return "minimax-images";
    if (providerId === "gemini" && id.includes("image")) return "gemini-generate-content-image";
    if (
      (provider.sourceKind === "user" || provider.sourceKind === "local-provider-plugin")
      && OPENAI_COMPATIBLE_APIS.has(provider.api)
    ) return "openai-images";
    return "";
  }

  if (key === "speechRecognition") {
    if (providerId === "openai" && (id.includes("transcribe") || id === "whisper-1")) return "openai-audio-transcriptions";
    if ((providerId === "mimo" || providerId === "mimo-token-plan") && id.includes("asr")) return "mimo-chat-completions-asr";
    if (providerId === "dashscope" && id.includes("asr")) return "dashscope-qwen-asr-chat";
    if (providerId === "volcengine-speech" && id.includes("bigasr")) return "volcengine-bigasr-transcription";
    if (providerId === "system-speech") return "system-speech-recognition";
  }

  return "";
}
