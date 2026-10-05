import {
  MODEL_VIDEO_TRANSPORTS,
  resolveModelVideoInputTransport,
} from "../../shared/model-capabilities.ts";

export function matches(model) {
  return resolveModelVideoInputTransport(model) === MODEL_VIDEO_TRANSPORTS.OPENAI_VIDEO_URL;
}

export function apply(payload) {
  return normalizeOpenAIVideoUrlPayload(payload);
}

export function normalizeOpenAIVideoUrlPayload(payload) {
  if (!Array.isArray(payload?.messages)) return payload;

  let changed = false;
  const messages = payload.messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;

    let contentChanged = false;
    const content = message.content.map((part) => {
      const url = getDataVideoUrl(part);
      if (!url) return part;

      const { image_url: _imageUrlSnake, imageUrl: _imageUrlCamel, video_url, ...rest } = part;
      contentChanged = true;
      return {
        ...rest,
        type: "video_url",
        video_url: {
          ...(video_url && typeof video_url === "object" && !Array.isArray(video_url) ? video_url : {}),
          url,
        },
      };
    });

    if (!contentChanged) return message;
    changed = true;
    return { ...message, content };
  });

  return changed ? { ...payload, messages } : payload;
}

function getDataVideoUrl(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type !== "image_url") return null;
  const url = part.image_url?.url ?? part.imageUrl?.url;
  if (typeof url !== "string") return null;
  return url.toLowerCase().startsWith("data:video/") ? url : null;
}
