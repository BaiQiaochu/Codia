// @ts-nocheck
import {
  createLocalTaskId,
  normalizeBaseUrl,
  normalizeImageInput,
  saveBase64Images,
} from "./common.ts";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

async function getCredentials(ctx, params = {}) {
  const providerId = params.credentialProviderId || params.providerId || "gemini";
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds.error || !creds.apiKey) {
    throw new Error(`Provider "${providerId}" has no API key configured. Configure it in Settings > Providers.`);
  }
  return creds;
}

function collectInlineImages(data) {
  const images = [];
  for (const candidate of data?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      const inline = part.inlineData || part.inline_data;
      const b64 = inline?.data;
      if (typeof b64 === "string") {
        images.push({
          data: b64,
          mimeType: inline.mimeType || inline.mime_type || "image/png",
        });
      }
    }
  }
  return images;
}

async function remoteImageToInlinePart(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download Gemini reference image failed ${res.status}`);
  const mimeType = res.headers?.get?.("content-type") || "image/png";
  const data = Buffer.from(await res.arrayBuffer()).toString("base64");
  return { inline_data: { mime_type: mimeType, data } };
}

async function imagePart(image) {
  if (typeof image !== "string") return null;
  if (image.startsWith("data:")) {
    const match = image.match(/^data:([^;]+);base64,(.*)$/);
    if (!match) return null;
    return { inline_data: { mime_type: match[1], data: match[2] } };
  }
  if (/^https?:\/\//i.test(image)) {
    return remoteImageToInlinePart(image);
  }
  return { file_data: { file_uri: image } };
}

export const geminiImageAdapter = {
  id: "gemini",
  protocolId: "gemini-generate-content-image",
  name: "Gemini Image",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    resolutions: ["1K", "2K", "4K"],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "gemini" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const creds = await getCredentials(ctx, params);
    const modelId = params.modelId || params.model || "gemini-3.1-flash-image-preview";
    const parts = [{ text: params.prompt }];
    for (const image of normalizeImageInput(params.images || params.image)) {
      const part = await imagePart(image);
      if (part) parts.push(part);
    }

    const imageConfig = {};
    const aspectRatio = params.aspect_ratio || params.aspectRatio || params.ratio;
    if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
    if (params.size || params.resolution) imageConfig.imageSize = params.size || params.resolution;

    const body = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        ...(Object.keys(imageConfig).length ? { responseFormat: { image: imageConfig } } : {}),
      },
    };

    const res = await fetch(`${normalizeBaseUrl(creds.baseUrl, DEFAULT_BASE_URL)}/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": creds.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const images = collectInlineImages(data);
    if (images.length === 0) throw new Error("Gemini API returned no images");

    const files = [];
    for (const [index, image] of images.entries()) {
      const saved = await saveBase64Images(
        [image.data],
        image.mimeType,
        ctx.dataDir,
        params.filename && images.length > 1 ? `${params.filename}-${index + 1}` : params.filename,
      );
      files.push(...saved);
    }
    return { taskId: createLocalTaskId(), files };
  },
};
