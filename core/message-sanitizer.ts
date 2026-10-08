import {
  modelSupportsDirectAudioInput,
  modelSupportsDirectImageInput,
  modelSupportsImageInput,
  modelSupportsAudioInput,
  modelSupportsVideoInput,
} from "../shared/model-capabilities.ts";

const IMAGE_PLACEHOLDER_TEXT = "[image omitted: current model does not support image input]";
const VIDEO_PLACEHOLDER_TEXT = "[video omitted: current model does not support video input]";
const AUDIO_PLACEHOLDER_TEXT = "[audio omitted: current model does not support audio input]";
const HISTORICAL_IMAGE_PLACEHOLDER_TEXT = "[image omitted: historical image retained as file reference to avoid resending raw base64]";
const HISTORICAL_VIDEO_PLACEHOLDER_TEXT = "[video omitted: historical video retained as file reference to avoid resending raw base64]";
const HISTORICAL_AUDIO_PLACEHOLDER_TEXT = "[audio omitted: historical audio retained as file reference to avoid resending raw base64]";
const ATTACHED_IMAGE_MARKER_RE = /\[attached_image:\s*[^\]]+\]/g;
const ATTACHED_VIDEO_MARKER_RE = /\[attached_video:\s*[^\]]+\]/g;
const ATTACHED_AUDIO_MARKER_RE = /\[attached_audio:\s*[^\]]+\]/g;

export function modelSupportsImage(model) {
  return modelSupportsImageInput(model);
}

export function modelSupportsVideo(model) {
  return modelSupportsVideoInput(model);
}

export function modelSupportsAudio(model) {
  return modelSupportsAudioInput(model);
}

export function sanitizeMessagesForModel(messages, model) {
  if (!Array.isArray(messages)) return { messages, stripped: 0 };
  const supportsImage = modelSupportsDirectImageInput(model);
  const supportsVideo = modelSupportsVideo(model);
  const supportsAudio = modelSupportsDirectAudioInput(model);
  if (supportsImage && supportsVideo && supportsAudio) return { messages, stripped: 0 };
  if (!hasUnsupportedMediaContent(messages, { supportsImage, supportsVideo, supportsAudio })) {
    return { messages, stripped: 0 };
  }

  let stripped = 0;
  let strippedImages = 0;
  let strippedVideos = 0;
  let strippedAudios = 0;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.role !== "user" && msg.role !== "toolResult") return msg;
    if (typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    let localStripped = 0;
    const newContent = msg.content.map((block) => {
      if (!supportsImage && isImageLikeBlock(block)) {
        localStripped++;
        strippedImages++;
        return { type: "text", text: IMAGE_PLACEHOLDER_TEXT };
      }
      if (!supportsVideo && isVideoLikeBlock(block)) {
        localStripped++;
        strippedVideos++;
        return { type: "text", text: VIDEO_PLACEHOLDER_TEXT };
      }
      if (!supportsAudio && isAudioLikeBlock(block)) {
        localStripped++;
        strippedAudios++;
        return { type: "text", text: AUDIO_PLACEHOLDER_TEXT };
      }
      return block;
    });

    if (localStripped === 0) return msg;
    stripped += localStripped;
    return { ...msg, content: newContent };
  });

  return { messages: out, stripped, strippedImages, strippedVideos, strippedAudios };
}

export function stripHistoricalInlineMediaForReplay(messages) {
  if (!Array.isArray(messages)) return emptyMediaStripResult(messages);
  const lastAssistantIndex = findLastAssistantIndex(messages);
  if (lastAssistantIndex < 0) return emptyMediaStripResult(messages);
  return stripInlineMediaBlocks(messages, {
    shouldStripMessage: (_msg, index) => index < lastAssistantIndex,
    imagePlaceholder: HISTORICAL_IMAGE_PLACEHOLDER_TEXT,
    videoPlaceholder: HISTORICAL_VIDEO_PLACEHOLDER_TEXT,
    audioPlaceholder: HISTORICAL_AUDIO_PLACEHOLDER_TEXT,
  });
}

export function stripAllInlineMediaForHistory(messages) {
  if (!Array.isArray(messages)) return emptyMediaStripResult(messages);
  return stripInlineMediaBlocks(messages, {
    shouldStripMessage: () => true,
    imagePlaceholder: HISTORICAL_IMAGE_PLACEHOLDER_TEXT,
    videoPlaceholder: HISTORICAL_VIDEO_PLACEHOLDER_TEXT,
    audioPlaceholder: HISTORICAL_AUDIO_PLACEHOLDER_TEXT,
  });
}

function emptyMediaStripResult(messages) {
  return { messages, stripped: 0, strippedImages: 0, strippedVideos: 0 };
}

function hasUnsupportedMediaContent(messages, { supportsImage, supportsVideo, supportsAudio }) {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "toolResult") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!supportsImage && isImageLikeBlock(block)) return true;
      if (!supportsVideo && isVideoLikeBlock(block)) return true;
      if (!supportsAudio && isAudioLikeBlock(block)) return true;
    }
  }
  return false;
}

function isImageLikeBlock(block) {
  if (!block || typeof block !== "object") return false;

  const type = block.type;
  if (type === "image" || type === "image_url" || type === "input_image") {
    return true;
  }

  if (block.image_url || block.imageUrl || block.image) {
    return true;
  }

  const source = block.source;
  if (source && typeof source === "object") {
    const mediaType = String(source.media_type || source.mimeType || source.type || "");
    if (mediaType.startsWith("image/")) return true;
  }

  const mimeType = String(block.mimeType || block.media_type || "");
  if (mimeType.startsWith("image/") && (block.data || block.url)) return true;

  return false;
}

function isVideoLikeBlock(block) {
  if (!block || typeof block !== "object") return false;

  const type = block.type;
  if (type === "video" || type === "video_url" || type === "input_video") {
    return true;
  }

  if (block.video_url || block.videoUrl || block.video) {
    return true;
  }

  const source = block.source;
  if (source && typeof source === "object") {
    const mediaType = String(source.media_type || source.mimeType || source.type || "");
    if (mediaType.startsWith("video/")) return true;
  }

  const mimeType = String(block.mimeType || block.media_type || "");
  if (mimeType.startsWith("video/") && (block.data || block.url)) return true;

  return false;
}

function isAudioLikeBlock(block) {
  if (!block || typeof block !== "object") return false;

  const type = block.type;
  if (type === "audio" || type === "audio_url" || type === "input_audio") {
    return true;
  }

  if (block.audio_url || block.audioUrl || block.audio) {
    return true;
  }

  const source = block.source;
  if (source && typeof source === "object") {
    const mediaType = String(source.media_type || source.mimeType || source.type || "");
    if (mediaType.startsWith("audio/")) return true;
  }

  const mimeType = String(block.mimeType || block.media_type || "");
  if (mimeType.startsWith("audio/") && (block.data || block.url)) return true;

  return false;
}

function findLastAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return i;
  }
  return -1;
}

function stripInlineMediaBlocks(messages, {
  shouldStripMessage,
  imagePlaceholder,
  videoPlaceholder,
  audioPlaceholder,
}) {
  let strippedImages = 0;
  let strippedVideos = 0;
  let strippedAudios = 0;
  let changed = false;

  const out = messages.map((msg, index) => {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.role !== "user" && msg.role !== "toolResult") return msg;
    if (!Array.isArray(msg.content)) return msg;
    if (!shouldStripMessage(msg, index)) return msg;

    let localStripped = 0;
    let usedImageMarkers = 0;
    let usedVideoMarkers = 0;
    let usedAudioMarkers = 0;
    const text = contentText(msg.content);
    const imageMarkerCount = countMatches(text, ATTACHED_IMAGE_MARKER_RE);
    const videoMarkerCount = countMatches(text, ATTACHED_VIDEO_MARKER_RE);
    const audioMarkerCount = countMatches(text, ATTACHED_AUDIO_MARKER_RE);
    const newContent = [];

    for (const block of msg.content) {
      if (!block || typeof block !== "object") {
        newContent.push(block);
        continue;
      }
      if (isImageLikeBlock(block)) {
        localStripped++;
        strippedImages++;
        if (usedImageMarkers < imageMarkerCount) {
          usedImageMarkers++;
          continue;
        }
        newContent.push({ type: "text", text: imagePlaceholder });
        continue;
      }
      if (isVideoLikeBlock(block)) {
        localStripped++;
        strippedVideos++;
        if (usedVideoMarkers < videoMarkerCount) {
          usedVideoMarkers++;
          continue;
        }
        newContent.push({ type: "text", text: videoPlaceholder });
        continue;
      }
      if (isAudioLikeBlock(block)) {
        localStripped++;
        strippedAudios++;
        if (usedAudioMarkers < audioMarkerCount) {
          usedAudioMarkers++;
          continue;
        }
        newContent.push({ type: "text", text: audioPlaceholder });
        continue;
      }
      newContent.push(block);
    }
    if (localStripped === 0) return msg;
    changed = true;
    return { ...msg, content: newContent };
  });

  const stripped = strippedImages + strippedVideos + strippedAudios;
  return {
    messages: changed ? out : messages,
    stripped,
    strippedImages,
    strippedVideos,
    strippedAudios,
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function countMatches(text, re) {
  return String(text || "").match(re)?.length || 0;
}
