// @ts-nocheck
import fs from "fs";
import path from "path";
import { saveImage } from "../lib/download.ts";
import { resolveKnownModelId } from "../lib/provider-utils.ts";
import {
  IMAGE_RESOLUTION_TIERS,
  OPENAI_IMAGE_RATIOS,
  resolveOpenAiImageSize,
} from "../lib/resolution-tiers.ts";
import { inferMediaTypeFromModelId } from "../../../shared/model-type-inference.ts";
import { supportsFlexibleOpenAIImageSize } from "../../../shared/openai-image-models.ts";

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const EXT_TO_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

async function saveOpenAIResponseImage(image, mimeType, ctx, customName) {
  if (image?.b64_json) {
    const buffer = Buffer.from(image.b64_json, "base64");
    return saveImage(buffer, mimeType, ctx.dataDir, customName);
  }

  if (image?.url) {
    const res = await fetch(image.url);
    if (!res.ok) {
      throw new Error(`Failed to download generated image: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const remoteMimeType = res.headers.get("content-type") || mimeType;
    return saveImage(buffer, remoteMimeType, ctx.dataDir, customName);
  }

  throw new Error("OpenAI image response contained no b64_json or url");
}

async function postImageRequest(endpoint, apiKey, body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  let rawText = "";
  let data = null;
  if (typeof res.text === "function") {
    rawText = await res.text();
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {}
  } else if (typeof res.json === "function") {
    data = await res.json();
    rawText = data ? JSON.stringify(data) : "";
  }

  return {
    ok: res.ok,
    status: res.status,
    data,
    rawText,
    message: `API error ${res.status}${data?.error?.message ? `: ${data.error.message}` : rawText ? `: ${rawText}` : ""}`,
  };
}

function shouldRetryEditsAsGeneration(result) {
  if ([404, 405, 415].includes(result.status)) return true;
  if (result.status === 403) {
    return /permission|forbidden|access denied|not allowed|insufficient|unauthori[sz]ed|权限|无权|拒绝|禁止|暂无权限/i
      .test(result.message || "");
  }
  if (![400, 422, 500].includes(result.status)) return false;
  return /edit|multipart|form.?data|parse|unsupported|not found|method/i.test(result.message || "");
}

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

async function imageToFormPart(image, index) {
  if (path.isAbsolute(image) && fs.existsSync(image)) {
    const buffer = fs.readFileSync(image);
    const ext = path.extname(image).slice(1).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] || "image/png";
    const filename = path.basename(image) || `image-${index + 1}.png`;
    return { blob: new Blob([buffer], { type: mimeType }), filename };
  }

  const dataUrl = parseDataUrl(image);
  if (dataUrl) {
    const ext = dataUrl.mimeType.split("/")[1] || "png";
    return {
      blob: new Blob([dataUrl.buffer], { type: dataUrl.mimeType }),
      filename: `image-${index + 1}.${ext}`,
    };
  }

  if (/^https?:\/\//i.test(String(image || ""))) {
    const res = await fetch(image);
    if (!res.ok) throw new Error(`Failed to fetch reference image: HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") || "image/png";
    const ext = mimeType.split("/")[1] || "png";
    return {
      blob: new Blob([buffer], { type: mimeType }),
      filename: `image-${index + 1}.${ext}`,
    };
  }

  throw new Error(`Unsupported reference image input: ${String(image || "").slice(0, 80)}`);
}

function imageToGenerationInput(image) {
  if (path.isAbsolute(image) && fs.existsSync(image)) {
    const buffer = fs.readFileSync(image);
    const ext = path.extname(image).slice(1).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] || "image/png";
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  }

  const value = String(image || "");
  if (/^(data:image\/|https?:\/\/)/i.test(value)) return value;
  return image;
}

function collectReferenceImages(params) {
  const values = [];
  const seen = new Set();
  const add = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    const normalized = String(value).trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    values.push(normalized);
  };
  add(params.images);
  add(params.image);
  return values;
}

function resolveOpenAIImageModelId(rawModelId) {
  const resolved = resolveKnownModelId("openai", rawModelId, "image");
  if (inferMediaTypeFromModelId(resolved, "openai") === "image") return resolved;
  return "gpt-image-1";
}

async function postImageEditRequest(endpoint, apiKey, body) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (key === "image" || value == null) continue;
    form.append(key, String(value));
  }

  const images = Array.isArray(body.image) ? body.image : [body.image];
  for (let i = 0; i < images.length; i++) {
    const part = await imageToFormPart(images[i], i);
    form.append("image", part.blob, part.filename);
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  let rawText = "";
  let data = null;
  if (typeof res.text === "function") {
    rawText = await res.text();
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {}
  } else if (typeof res.json === "function") {
    data = await res.json();
    rawText = data ? JSON.stringify(data) : "";
  }

  return {
    ok: res.ok,
    status: res.status,
    data,
    rawText,
    message: `API error ${res.status}${data?.error?.message ? `: ${data.error.message}` : rawText ? `: ${rawText}` : ""}`,
  };
}

export const openaiImageAdapter = {
  id: "openai",
  protocolId: "openai-images",
  name: "OpenAI Image",
  types: ["image"],
  capabilities: {
    ratios: [...OPENAI_IMAGE_RATIOS],
    resolutions: [...IMAGE_RESOLUTION_TIERS],
  },

  async checkAuth(ctx) {
    try {
      const creds = await ctx.bus.request("provider:credentials", { providerId: "openai" });
      if (creds.error || !creds.apiKey) {
        return { ok: false, message: creds.error || "API key is not configured" };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const providerId = params.credentialProviderId || params.providerId || "openai";
    const creds = await ctx.bus.request("provider:credentials", { providerId });
    if (creds.error || !creds.apiKey) {
      throw new Error(`Provider "${providerId}" has no API key configured.`);
    }

    const { apiKey, baseUrl } = creds;
    const defaultImageModel = ctx.config?.get?.("defaultImageModel");
    const rawModelId = params.modelId
      || params.model
      || (defaultImageModel?.provider === providerId ? defaultImageModel.id : null)
      || "gpt-image-1";
    const modelId = resolveOpenAIImageModelId(rawModelId);

    const allDefaults = ctx.config?.get?.("providerDefaults") || {};
    const providerDefaults = allDefaults[providerId] || allDefaults.openai || {};
    const outputFormat = params.format || providerDefaults?.format || "jpeg";
    const effectiveRatio = params.aspect_ratio || params.aspectRatio || params.ratio || providerDefaults?.aspect_ratio;
    const size = resolveOpenAiImageSize(
      { ...params, ratio: effectiveRatio },
      providerDefaults,
      {
        sourceName: "OpenAI image",
        flexible: supportsFlexibleOpenAIImageSize(modelId),
      },
    );
    const body = {
      model: modelId,
      prompt: params.prompt,
      n: 1,
      output_format: outputFormat,
    };
    if (size) body.size = size;

    const quality = params.quality || providerDefaults?.quality;
    if (quality) body.quality = quality;

    if (providerDefaults?.background) body.background = providerDefaults.background;

    const referenceImages = collectReferenceImages(params);
    if (referenceImages.length) body.image = referenceImages;

    const base = baseUrl.replace(/\/+$/, "");
    let endpoint = body.image
      ? `${base}/images/edits`
      : `${base}/images/generations`;
    let result = body.image
      ? await postImageEditRequest(endpoint, apiKey, body)
      : await postImageRequest(endpoint, apiKey, body);

    if (!result.ok && body.image && shouldRetryEditsAsGeneration(result)) {
      endpoint = `${base}/images/generations`;
      const generationBody = {
        ...body,
        image_urls: body.image.map(imageToGenerationInput),
      };
      delete generationBody.image;
      result = await postImageRequest(endpoint, apiKey, generationBody);
    }

    if (!result.ok) {
      throw new Error(result.message);
    }

    const responseImages = result.data?.data || [];
    if (responseImages.length === 0) {
      throw new Error("API returned no images");
    }

    const mimeType = FORMAT_TO_MIME[outputFormat] || "image/png";
    const revisedPrompt = responseImages[0]?.revised_prompt;
    if (revisedPrompt && ctx.log) {
      ctx.log(`[openai-image] revised_prompt: ${revisedPrompt}`);
    }

    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const files = [];
    for (let i = 0; i < responseImages.length; i++) {
      const customName = params.filename
        ? (responseImages.length > 1 ? `${params.filename}-${i + 1}` : params.filename)
        : null;
      const { filename } = await saveOpenAIResponseImage(responseImages[i], mimeType, ctx, customName);
      files.push(filename);
    }

    return { taskId, files };
  },
};
