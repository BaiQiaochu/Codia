const IMAGE_MODEL_PATTERNS = [
  /gpt[-_]?image/,
  /chatgpt[-_]?image/,
  /dall[-_]?e/,
  /seedream/,
  /seededit/,
  /qwen[-_]?image/,
  /wanx/,
  /flux/,
  /stable[-_]?diffusion/,
  /sdxl/,
  /(?:^|[-_/])sd3(?:$|[-_/])/,
  /imagen/,
  /ideogram/,
  /recraft/,
  /hidream/,
  /kolors/,
  /midjourney/,
  /imagine[-_]?image/,
  /image[-_]?0?1/,
  /image[-_]?generation/,
  /text[-_]?to[-_]?image/,
  /txt[-_]?2[-_]?img/,
  /t2i/,
  /image[-_]?edit/,
  /img[-_]?2[-_]?img/,
  /i2i/,
  /dreamshaper/,
  /juggernaut/,
  /realvis/,
  /animagine/,
  /pony/,
];

const AUDIO_MODEL_PATTERNS = [
  /(?:^|[-_/])tts(?:$|[-_/])/,
  /(?:^|[-_/])stt(?:$|[-_/])/,
  /speech/,
  /voice/,
  /audio/,
];

const MUSIC_MODEL_PATTERNS = [
  /music/,
  /song/,
];

const VIDEO_MODEL_PATTERNS = [
  /video/,
  /seedance/,
  /seadance/,
  /(?:^|[-_/])sora(?:$|[-_/\d.])/,
  /(?:^|[-_/])veo(?:$|[-_/\d.])/,
  /kling/,
  /runway/,
  /ltx[-_]?video/,
  /cogvideo/,
  /wanx[-_]?video/,
  /wan[-_]?2(?:$|[-_/\d.])/,
  /text[-_]?to[-_]?video/,
  /txt[-_]?2[-_]?video/,
  /txt2video/,
  /t2v/,
  /image[-_]?to[-_]?video/,
  /img[-_]?2[-_]?video/,
  /i2v/,
];

const MODEL_TYPES = new Set(["chat", "image", "audio", "music", "video"]);

const CHAT_CAPABLE_FULL_MODAL_PATTERNS = [
  /^gpt[-_]?4o[-_]?audio[-_]?preview(?:$|[-_])/,
  /^gpt[-_]?4o[-_]?mini[-_]?audio[-_]?preview(?:$|[-_])/,
  /^gpt[-_]?audio(?:$|[-_](?:mini|preview|latest|\d))/,
  /^gemini[-_\w.]*native[-_]?audio(?:$|[-_])/,
  /qwen[\w.-]*[-_]?omni(?:$|[-_/])/,
  /mimo[\w.-]*[-_]?omni(?:$|[-_/])/,
];

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeModelType(value) {
  const type = normalized(value);
  if (!type) return null;
  if (type === "text" || type === "llm") return "chat";
  if (type === "voice" || type === "speech" || type === "tts" || type === "stt") return "audio";
  if (type === "song") return "music";
  if (type === "image_generation" || type === "text-to-image" || type === "txt2img") return "image";
  if (["movie", "video_generation", "text-to-video", "txt2video", "txt2vid", "t2v", "image-to-video", "img2video", "i2v"].includes(type)) return "video";
  return MODEL_TYPES.has(type) ? type : null;
}

export function isChatCapableFullModalModelId(modelId, providerId = "") {
  const id = normalized(modelId);
  if (!id) return false;
  const provider = normalized(providerId);
  if (provider.includes("comfy")) return false;
  return CHAT_CAPABLE_FULL_MODAL_PATTERNS.some((pattern) => pattern.test(id));
}

export function inferMediaTypeFromModelId(modelId, providerId = "") {
  const id = normalized(modelId);
  if (!id) return null;
  const provider = normalized(providerId);

  if (isChatCapableFullModalModelId(id, provider)) return null;
  if (provider.includes("comfy") && (id === "workflow" || id.includes("workflow"))) {
    return "image";
  }
  if (VIDEO_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return "video";
  if (MUSIC_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return "music";
  if (AUDIO_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return "audio";
  if (IMAGE_MODEL_PATTERNS.some((pattern) => pattern.test(id))) return "image";
  return null;
}

export function resolveModelTypeFromModelId(modelId, providerId = "", explicitType = null, knownType = null) {
  if (isChatCapableFullModalModelId(modelId, providerId)) return "chat";

  const explicit = normalizeModelType(explicitType);
  if (explicit) return explicit;

  const known = normalizeModelType(knownType);
  if (known) return known;

  const inferred = normalizeModelType(inferMediaTypeFromModelId(modelId, providerId));
  return inferred || "chat";
}
