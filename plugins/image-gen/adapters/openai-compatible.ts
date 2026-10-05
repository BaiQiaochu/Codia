// @ts-nocheck
import fs from "fs";
import path from "path";
import { saveImage } from "../lib/download.ts";
import { isOpenAICompatibleApi } from "../lib/provider-utils.ts";
import { providerDefaultsFor } from "../lib/provider-defaults.ts";
import { resolveOpenAiImageSize } from "../lib/resolution-tiers.ts";
import { inferMediaTypeFromModelId } from "../../../shared/model-type-inference.ts";

function isLocalBaseUrl(url = "") {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

const FORMAT_TO_MIME = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

const OPENAI_RATIO_TO_SIZE = {
  "1:1": "1024x1024",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
  "5:4": "1280x1024",
  "4:5": "1024x1280",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "2:1": "2048x1024",
  "1:2": "1024x2048",
  "21:9": "2016x864",
  "9:21": "864x2016",
};

const RATIO_TO_ORIENTATION_SIZE = {
  "1:1": "square",
  "4:3": "landscape",
  "5:4": "landscape",
  "16:9": "landscape",
  "3:2": "landscape",
  "2:1": "landscape",
  "21:9": "landscape",
  "3:4": "portrait",
  "4:5": "portrait",
  "9:16": "portrait",
  "2:3": "portrait",
  "1:2": "portrait",
  "9:21": "portrait",
};

const ORIENTATION_TO_RATIO = {
  square: "1:1",
  landscape: "16:9",
  portrait: "9:16",
};

function matchesCompactGptImage2(value) {
  return /(^|[^a-z0-9])gpt[-_]?image_?2([^a-z0-9]|$)/i.test(String(value || ""));
}

function looksLikeOfficialGptImage2Model(modelId) {
  return /(^|[^a-z0-9])gpt-image-2([^a-z0-9]|$)/i.test(String(modelId || ""));
}

function looksLikeGptImage2(providerId, modelId) {
  if (matchesCompactGptImage2(providerId)) return true;
  if (looksLikeOfficialGptImage2Model(modelId)) return false;
  return matchesCompactGptImage2(modelId);
}

function shouldUseChatCompletionsForImage(providerDefaults, providerId, modelId) {
  const configured = String(
    providerDefaults?.imageRoute
      || providerDefaults?.image_route
      || providerDefaults?.imageEndpoint
      || providerDefaults?.image_endpoint
      || "",
  ).trim().toLowerCase();
  if (["images", "image", "images/generations", "generations"].includes(configured)) return false;
  if (["chat", "chat/completions", "chat-completions", "completions"].includes(configured)) return true;
  return looksLikeGptImage2(providerId, modelId);
}

function usesOrientationSize(providerDefaults, providerId, modelId) {
  return providerDefaults?.sizeSchema === "orientation"
    || providerDefaults?.sizeMode === "orientation"
    || providerDefaults?.size === "landscape"
    || providerDefaults?.size === "portrait"
    || providerDefaults?.size === "square"
    || looksLikeGptImage2(providerId, modelId);
}

function usesRatioSize(providerDefaults) {
  const configuredSize = String(providerDefaults?.size || "").trim();
  return providerDefaults?.sizeSchema === "ratio"
    || providerDefaults?.sizeMode === "ratio"
    || /^\d+\s*:\s*\d+$/.test(configuredSize);
}

function usesResolutionTierSize(providerDefaults) {
  return providerDefaults?.sizeSchema === "resolution"
    || providerDefaults?.sizeMode === "resolution"
    || providerDefaults?.resolutionAsSize === true
    || providerDefaults?.resolution_as_size === true;
}

function shouldUseRatioSize(providerDefaults) {
  return usesRatioSize(providerDefaults);
}

function shouldUseFlexibleOpenAiImageSize(params, providerDefaults, providerId, modelId) {
  if (usesOrientationSize(providerDefaults, providerId, modelId) || usesRatioSize(providerDefaults)) return false;
  if (usesResolutionTierSize(providerDefaults)) return false;
  const hasTierInput = normalizeResolutionTier(params.resolution)
    || normalizeResolutionTier(params.size)
    || normalizeResolutionTier(providerDefaults?.resolution)
    || normalizeResolutionTier(providerDefaults?.size);
  if (!hasTierInput && !providerDefaults?.openAiFlexibleSize && !providerDefaults?.openaiFlexibleSize) return false;
  return providerDefaults?.openAiFlexibleSize === true
    || providerDefaults?.openaiFlexibleSize === true
    || looksLikeOfficialGptImage2Model(modelId);
}

function shouldUseGenerationImageUrls(providerDefaults, providerId, modelId) {
  const configured = providerDefaults?.imageInputField || providerDefaults?.image_input_field;
  if (configured === "image") return false;
  if (configured === "image_urls" || configured === "imageUrls") return true;
  return looksLikeGptImage2(providerId, modelId);
}

function normalizeProviderSize(value, orientationMode) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (!orientationMode) return raw;

  const lower = raw.toLowerCase();
  if (/^(1k|2k|4k)$/i.test(raw)) return raw.toUpperCase();
  if (lower === "landscape" || lower === "portrait" || lower === "square") return lower;
  if (RATIO_TO_ORIENTATION_SIZE[raw]) return RATIO_TO_ORIENTATION_SIZE[raw];

  const match = raw.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (match) {
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (width > height) return "landscape";
    if (height > width) return "portrait";
    return "square";
  }

  return null;
}

function normalizeResolutionTier(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1k" || raw === "2k" || raw === "4k") return raw;
  return null;
}

function inferRatioFromPixelSize(size) {
  const match = String(size || "").trim().match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;

  let best = null;
  let bestDiff = Infinity;
  for (const ratio of Object.keys(RATIO_TO_ORIENTATION_SIZE)) {
    const [rw, rh] = ratio.split(":").map(Number);
    const diff = Math.abs((width / height) - (rw / rh));
    if (diff < bestDiff) {
      best = ratio;
      bestDiff = diff;
    }
  }
  return bestDiff < 0.03 ? best : null;
}

function resolveBodySize(params, providerDefaults, providerId, modelId) {
  if (shouldUseFlexibleOpenAiImageSize(params, providerDefaults, providerId, modelId)) {
    const resolved = resolveOpenAiImageSize(params, providerDefaults, {
      sourceName: "OpenAI-compatible image",
      flexible: true,
    });
    if (resolved) return resolved;
  }

  const orientationMode = usesOrientationSize(providerDefaults, providerId, modelId);
  const ratioMode = shouldUseRatioSize(providerDefaults, providerId, modelId);
  const compactGptImage2 = looksLikeGptImage2(providerId, modelId) && !usesResolutionTierSize(providerDefaults);
  const explicitRatio = params.aspect_ratio || params.aspectRatio || params.ratio || null;
  const defaultRatio = providerDefaults?.aspect_ratio || providerDefaults?.aspectRatio || providerDefaults?.ratio || null;
  const rawExplicitSize = params.size == null ? "" : String(params.size).trim();
  if (ratioMode && /^\d+\s*:\s*\d+$/.test(rawExplicitSize)) return rawExplicitSize;

  const explicitSize = normalizeProviderSize(params.size, orientationMode);
  const explicitSizeIsResolutionTier = normalizeResolutionTier(explicitSize);
  if (explicitSize && !(compactGptImage2 && explicitSizeIsResolutionTier)) return explicitSize;

  if (explicitRatio) {
    if (ratioMode) return explicitRatio;
    if (orientationMode) return RATIO_TO_ORIENTATION_SIZE[explicitRatio] || "square";
    if (OPENAI_RATIO_TO_SIZE[explicitRatio]) return OPENAI_RATIO_TO_SIZE[explicitRatio];
  }

  const resolutionSize = normalizeProviderSize(params.resolution, orientationMode);
  const resolutionSizeIsTier = normalizeResolutionTier(resolutionSize);
  if (resolutionSize && !(compactGptImage2 && resolutionSizeIsTier)) return resolutionSize;

  const defaultSize = normalizeProviderSize(providerDefaults?.size, orientationMode);
  if (defaultSize) return defaultSize;

  if (defaultRatio) {
    if (ratioMode) return defaultRatio;
    if (orientationMode) return RATIO_TO_ORIENTATION_SIZE[defaultRatio] || "square";
    if (OPENAI_RATIO_TO_SIZE[defaultRatio]) return OPENAI_RATIO_TO_SIZE[defaultRatio];
  }

  if (ratioMode) return "1:1";
  return orientationMode ? "square" : "1024x1024";
}

function resolveRatio(params, providerDefaults) {
  const explicitSize = String(params.size || "").trim();
  return params.aspect_ratio
    || params.aspectRatio
    || params.ratio
    || (/^\d+\s*:\s*\d+$/.test(explicitSize) ? explicitSize : null)
    || providerDefaults?.aspect_ratio
    || providerDefaults?.aspectRatio
    || providerDefaults?.ratio
    || null;
}

function resolveAspectRatioField(providerDefaults, providerId, modelId) {
  const configured = providerDefaults?.aspectRatioField || providerDefaults?.aspect_ratio_field;
  if (configured) return String(configured);
  if (providerDefaults?.sendAspectRatio === true || providerDefaults?.send_aspect_ratio === true) {
    return "aspect_ratio";
  }
  if (looksLikeGptImage2(providerId, modelId)) return "aspect_ratio";
  return null;
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

function resolveReferenceImageSchema(providerDefaults, providerId, modelId) {
  const configured = String(providerDefaults?.imageInputField || providerDefaults?.image_input_field || "").trim();
  if (configured) return configured;
  if (shouldUseGenerationImageUrls(providerDefaults, providerId, modelId)) return "image_urls";
  return "image";
}

function attachReferenceImages(body, imageInputs, schema) {
  if (!Array.isArray(imageInputs) || imageInputs.length === 0) return body;

  if (schema === "image_urls" || schema === "imageUrls") {
    body.image_urls = imageInputs;
    return body;
  }

  if (schema === "images[].image_url") {
    body.images = imageInputs.map((url) => ({ image_url: url }));
    return body;
  }

  if (schema === "images[].image_url.url") {
    body.images = imageInputs.map((url) => ({ image_url: { url } }));
    return body;
  }

  body.image = imageInputs;
  return body;
}

function shouldUseGenerationEndpointForRefs(providerDefaults, referenceSchema) {
  const route = String(
    providerDefaults?.imageRoute
      || providerDefaults?.image_route
      || providerDefaults?.imageEndpoint
      || providerDefaults?.image_endpoint
      || "",
  ).trim().toLowerCase();

  if (["images", "image", "images/generations", "generations"].includes(route)) return true;
  if (["edits", "images/edits"].includes(route)) return false;
  return referenceSchema !== "image";
}

function pushUnique(values, value) {
  if (value == null || value === "") return;
  const normalized = String(value).trim();
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (values.some((existing) => String(existing).toLowerCase() === key)) return;
  values.push(normalized);
}

function inferOrientationFromSize(size) {
  const current = String(size || "").trim().toLowerCase();
  if (current === "landscape" || current === "portrait" || current === "square") return current;

  const match = current.match(/^(\d+)\s*x\s*(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}

function buildSizeCandidates(params, providerDefaults, providerId, modelId) {
  const ratio = resolveRatio(params, providerDefaults);
  const primary = resolveBodySize(params, providerDefaults, providerId, modelId);
  const rawExplicitSize = params.size == null ? "" : String(params.size).trim();
  const candidates = [];

  pushUnique(candidates, primary);

  if (ratio) {
    const orientationSize = RATIO_TO_ORIENTATION_SIZE[ratio] || "square";
    if (usesRatioSize(providerDefaults)) {
      pushUnique(candidates, ratio);
      pushUnique(candidates, orientationSize);
    } else {
      pushUnique(candidates, orientationSize);
      pushUnique(candidates, ratio);
    }
    pushUnique(candidates, OPENAI_RATIO_TO_SIZE[ratio] || "1024x1024");
  } else {
    const orientationSize = inferOrientationFromSize(primary);
    const ratioFromSize = inferRatioFromPixelSize(rawExplicitSize || primary);
    if (ratioFromSize) pushUnique(candidates, ratioFromSize);
    if (orientationSize) pushUnique(candidates, ORIENTATION_TO_RATIO[orientationSize]);
    if (orientationSize) pushUnique(candidates, orientationSize);
    if (orientationSize === "landscape") pushUnique(candidates, "1536x1024");
    if (orientationSize === "portrait") pushUnique(candidates, "1024x1536");
    if (orientationSize === "square") pushUnique(candidates, "1024x1024");
  }
  pushUnique(candidates, rawExplicitSize);

  return candidates;
}

async function saveOpenAICompatibleResponseImage(image, mimeType, ctx, customName) {
  if (image?.b64_json) {
    const buffer = Buffer.from(image.b64_json, "base64");
    return saveImage(buffer, mimeType, ctx.dataDir, customName);
  }

  if (image?.url) {
    const dataUrl = parseDataImageUrl(image.url);
    if (dataUrl) {
      return saveImage(dataUrl.buffer, dataUrl.mimeType || mimeType, ctx.dataDir, customName);
    }

    const res = await fetch(image.url);
    if (!res.ok) {
      throw new Error(`Failed to download generated image: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const remoteMimeType = res.headers.get("content-type") || mimeType;
    return saveImage(buffer, remoteMimeType, ctx.dataDir, customName);
  }

  throw new Error("OpenAI-compatible response contained no b64_json or url");
}

function parseDataImageUrl(value) {
  const match = String(value || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

function pushResponseImage(out, seen, image) {
  if (!image || typeof image !== "object") return;
  const key = image.b64_json
    ? `b64:${String(image.b64_json).slice(0, 80)}`
    : `url:${String(image.url || "").slice(0, 240)}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(image);
}

function extractImagesFromText(text, out, seen) {
  const value = String(text || "");
  const dataUrlRe = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/g;
  for (const match of value.matchAll(dataUrlRe)) {
    pushResponseImage(out, seen, { url: match[0] });
  }

  const trimmed = value.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed) || /^data:image\//i.test(trimmed)) {
    pushResponseImage(out, seen, { url: trimmed });
    return;
  }

  if (/^[A-Za-z0-9+/=_-\s]+$/.test(trimmed) && trimmed.replace(/\s/g, "").length > 256) {
    pushResponseImage(out, seen, { b64_json: trimmed.replace(/\s/g, "") });
  }
}

function extractChatCompletionImages(data) {
  const out = [];
  const seen = new Set();

  const visit = (value, depth = 0) => {
    if (value == null || depth > 8) return;
    if (typeof value === "string") {
      extractImagesFromText(value, out, seen);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    if (value.b64_json) pushResponseImage(out, seen, { b64_json: value.b64_json });
    if (value.b64) pushResponseImage(out, seen, { b64_json: value.b64 });
    if (value.base64) pushResponseImage(out, seen, { b64_json: value.base64 });
    if (value.image_base64) pushResponseImage(out, seen, { b64_json: value.image_base64 });

    const imageUrl = typeof value.image_url === "string" ? value.image_url : value.image_url?.url;
    if (imageUrl) pushResponseImage(out, seen, { url: imageUrl });
    for (const key of ["url", "uri", "imageUrl"]) {
      if (value[key]) pushResponseImage(out, seen, { url: value[key] });
    }

    for (const key of ["content", "text", "message", "data", "output", "result", "images", "image", "items"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) visit(value[key], depth + 1);
    }
  };

  for (const choice of data?.choices || []) {
    visit(choice?.message?.content);
    visit(choice?.message?.images);
    visit(choice?.message?.image);
    visit(choice?.delta?.content);
  }

  if (out.length === 0) {
    visit(data?.data);
    visit(data?.output);
    visit(data?.result);
  }

  return out;
}

function buildChatCompletionImageBody(params, baseImageBody, imageInputs) {
  const promptParts = [String(params.prompt || "").trim() || "Generate an image."];
  if (baseImageBody.aspect_ratio) promptParts.push(`Aspect ratio: ${baseImageBody.aspect_ratio}.`);
  if (baseImageBody.size) promptParts.push(`Image size/orientation: ${baseImageBody.size}.`);

  const text = promptParts.join("\n");
  const content = imageInputs.length > 0
    ? [
        { type: "text", text },
        ...imageInputs.map((url) => ({ type: "image_url", image_url: { url } })),
      ]
    : text;

  return {
    model: baseImageBody.model,
    messages: [{ role: "user", content }],
    stream: false,
  };
}

function buildRemoteTaskId(providerId, remoteTaskId) {
  const providerToken = Buffer.from(String(providerId || ""), "utf8").toString("hex");
  const safeRemoteId = String(remoteTaskId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `oc_${providerToken}_${safeRemoteId}`;
}

function parseRemoteTaskId(taskId) {
  const match = String(taskId || "").match(/^oc_([a-fA-F0-9]+)_(.+)$/);
  if (!match) return null;
  return {
    providerId: Buffer.from(match[1], "hex").toString("utf8"),
    remoteTaskId: match[2],
  };
}

function extractRemoteTaskId(data) {
  const candidates = [
    data,
    data?.data,
    data?.result,
    data?.output,
    data?.task,
  ];
  for (const candidate of candidates) {
    const item = Array.isArray(candidate) ? candidate[0] : candidate;
    if (!item || typeof item !== "object") continue;
    const explicit = item.task_id || item.taskId || item.taskID || item.task?.id || item.task?.task_id;
    if (explicit) return explicit;
    const rawStatus = String(item.status || item.state || "").toLowerCase();
    if (item.id && /pending|submitted|queued|running|processing|created/.test(rawStatus)) {
      return item.id;
    }
  }
  return null;
}

function normalizeRemoteTaskStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "completed" || value === "succeeded" || value === "success" || value === "done") return "success";
  if (value === "failed" || value === "error" || value === "cancelled") return "failed";
  return "pending";
}

function extractRemoteResultImages(data) {
  const out = [];
  const seen = new Set();

  const pushImage = (item) => {
    if (typeof item === "string") {
      if (!/^(https?:\/\/|data:image\/)/i.test(item)) return;
      if (seen.has(item)) return;
      seen.add(item);
      out.push({ url: item });
      return;
    }

    if (!item || typeof item !== "object") return;

    if (item.b64_json) {
      const key = `b64:${String(item.b64_json).slice(0, 80)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ b64_json: item.b64_json });
      }
    }

    const urlValue = item.url || item.image_url || item.imageUrl || item.uri;
    if (Array.isArray(urlValue)) {
      for (const url of urlValue) pushImage(url);
    } else if (urlValue) {
      pushImage(urlValue);
    }

    for (const key of ["images", "image_urls", "imageUrls", "urls", "data"]) {
      if (!Array.isArray(item[key])) continue;
      for (const nested of item[key]) pushImage(nested);
    }
  };

  const payload = data?.data || data;
  const result = payload?.result || payload?.output || payload;
  for (const candidate of [
    result,
    result?.images,
    result?.image_urls,
    result?.imageUrls,
    result?.urls,
    payload?.images,
    payload?.image_urls,
    payload?.imageUrls,
    payload?.urls,
    data?.images,
    data?.image_urls,
    data?.imageUrls,
    data?.urls,
  ]) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) pushImage(item);
    } else {
      pushImage(candidate);
    }
  }

  return out;
}

async function resolveProviderCredentials(ctx, providerId) {
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds?.error) {
    throw new Error(creds.error);
  }
  if (!creds?.apiKey && !isLocalBaseUrl(creds?.baseUrl || "")) {
    throw new Error(`Provider "${providerId}" has no API key configured.`);
  }
  if (creds.api && !isOpenAICompatibleApi(creds.api)) {
    throw new Error(`Provider "${providerId}" is not an OpenAI-compatible API.`);
  }
  return creds;
}

async function resolveImageModelId(ctx, providerId, explicitModel, fallbackModelId = null) {
  if (explicitModel) return explicitModel;

  const byType = await ctx.bus.request("provider:models-by-type", {
    providerId,
    type: "image",
  }).catch(() => ({ models: [] }));
  const imageModels = Array.isArray(byType?.models) ? byType.models : [];

  const defaultImageModel = ctx.config?.get?.("defaultImageModel");
  if (defaultImageModel?.provider === providerId && defaultImageModel?.id) {
    const defaultId = String(defaultImageModel.id);
    const defaultListed = imageModels.some((model) => String(model?.id || "") === defaultId);
    if (defaultListed || inferMediaTypeFromModelId(defaultId, providerId) === "image") {
      return defaultId;
    }
  }

  if (imageModels[0]?.id) {
    return imageModels[0].id;
  }

  return fallbackModelId;
}

function buildErrorMessage(status, data, rawText) {
  let msg = `API error ${status}`;
  const detail = data?.error?.message || data?.message || rawText;
  if (detail) msg = `${msg}: ${detail}`;
  return msg;
}

function shouldRetryWithoutOptionalFields(result) {
  if (![400, 422].includes(result.status)) return false;
  return /output_format|response_format|quality|background|aspect_ratio|aspectRatio|resolution|unknown|unsupported|unrecognized|extra|invalid parameter|invalid field/i
    .test(result.message || "")
    || /未知|不支持|不识别|无法识别|多余|额外|无效|非法|不合法|参数|字段/.test(result.message || "");
}

function removeOptionalProviderFields(body) {
  const next = { ...body };
  delete next.n;
  delete next.output_format;
  delete next.response_format;
  delete next.quality;
  delete next.background;
  delete next.resolution;
  delete next.aspect_ratio;
  delete next.aspectRatio;
  delete next.output_compression;
  delete next.moderation;
  return next;
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
    message: buildErrorMessage(res.status, data, rawText),
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

function shouldRetryWithImagesImageUrl(result) {
  if (![400, 422].includes(result.status)) return false;
  return /images\[\]\.image_url|image_url\s+is\s+required|images.*image_url/i.test(result.message || "");
}

function extractReferenceValuesFromBody(body) {
  const values = [];
  const add = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (typeof value === "object") {
      add(value.image_url?.url || value.image_url || value.url || value.uri);
      return;
    }
    const normalized = String(value).trim();
    if (normalized) values.push(normalized);
  };
  add(body?.image_urls);
  add(body?.imageUrls);
  add(body?.image);
  add(body?.images);
  return [...new Set(values)];
}

function bodyUsesFlatImagesImageUrl(body) {
  return Array.isArray(body?.images)
    && body.images.some((item) => item && typeof item === "object" && typeof item.image_url === "string");
}

function bodyUsesNestedImagesImageUrl(body) {
  return Array.isArray(body?.images)
    && body.images.some((item) => item?.image_url && typeof item.image_url === "object" && typeof item.image_url.url === "string");
}

function buildImagesImageUrlFallbackBody(body, nested = false) {
  const values = extractReferenceValuesFromBody(body);
  if (values.length === 0) return null;
  const next = {
    ...body,
    images: values.map((url) => nested ? { image_url: { url } } : { image_url: url }),
  };
  delete next.image_urls;
  delete next.imageUrls;
  delete next.image;
  return next;
}

function referenceSchemaFallbackOrder(body) {
  if (bodyUsesFlatImagesImageUrl(body)) return [true];
  if (bodyUsesNestedImagesImageUrl(body)) return [false];
  return [false, true];
}

function summarizeRequestShape(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (Array.isArray(value)) {
      out[key] = `array(${value.length})`;
    } else if (value && typeof value === "object") {
      out[key] = "object";
    } else {
      out[key] = typeof value;
    }
  }
  return out;
}

function shouldRetryWithAlternateSize(result) {
  if (![400, 422].includes(result.status)) return false;
  return /size|resolution|尺寸|大小|分辨率|比例|不合法|非法|无效/i.test(result.message || "");
}

function shouldRetryWithoutSizeField(result, body) {
  return body && Object.prototype.hasOwnProperty.call(body, "size") && shouldRetryWithAlternateSize(result);
}

async function postImageRequestWithSizeFallback(endpoint, apiKey, body, sizeCandidates) {
  let result = await postImageRequest(endpoint, apiKey, body);
  for (let i = 1; !result.ok && shouldRetryWithAlternateSize(result) && i < sizeCandidates.length; i++) {
    body.size = sizeCandidates[i];
    result = await postImageRequest(endpoint, apiKey, body);
  }
  if (!result.ok && shouldRetryWithoutSizeField(result, body)) {
    delete body.size;
    result = await postImageRequest(endpoint, apiKey, body);
  }
  return result;
}

async function postImageRequestWithCompatibilityFallback(endpoint, apiKey, body, sizeCandidates) {
  let result = await postImageRequestWithSizeFallback(endpoint, apiKey, body, sizeCandidates);
  if (result.ok || !shouldRetryWithoutOptionalFields(result)) return { result, body };

  const strippedBody = removeOptionalProviderFields(body);
  result = await postImageRequestWithSizeFallback(endpoint, apiKey, strippedBody, sizeCandidates);
  return { result, body: strippedBody };
}

export async function submitOpenAICompatibleImage(params, ctx, providerId, { fallbackModelId = null } = {}) {
  const creds = await resolveProviderCredentials(ctx, providerId);
  const modelId = await resolveImageModelId(ctx, providerId, params.model, fallbackModelId);

  if (!modelId) {
    throw new Error(`Provider "${providerId}" has no configured image model.`);
  }

  const { baseUrl } = creds;
  const apiKey = creds.apiKey || "local";
  const allDefaults = ctx.config?.get?.("providerDefaults") || {};
  const providerDefaults = providerDefaultsFor(allDefaults, providerId);
  const outputFormat = params.format || providerDefaults?.format || "jpeg";
  const aspectRatio = resolveRatio(params, providerDefaults);
  const aspectRatioField = resolveAspectRatioField(providerDefaults, providerId, modelId);
  const resolutionTier = normalizeResolutionTier(params.resolution || providerDefaults?.resolution);
  const compactGptImage2 = looksLikeGptImage2(providerId, modelId);
  const sendResolution = providerDefaults?.sendResolution === true
    || providerDefaults?.send_resolution === true
    || usesResolutionTierSize(providerDefaults);
  const body = {
    model: modelId,
    prompt: params.prompt,
    n: 1,
    output_format: outputFormat,
    size: resolveBodySize(params, providerDefaults, providerId, modelId),
  };
  if (aspectRatio && aspectRatioField) body[aspectRatioField] = aspectRatio;
  if (resolutionTier && sendResolution) body.resolution = resolutionTier;
  const sizeCandidates = buildSizeCandidates(params, providerDefaults, providerId, modelId);

  const quality = params.quality || providerDefaults?.quality;
  if (quality) body.quality = quality;

  if (providerDefaults?.background) body.background = providerDefaults.background;

  let imageInputs = [];
  const referenceImages = collectReferenceImages(params);
  if (referenceImages.length > 0) {
    imageInputs = referenceImages.map((image) => {
      if (path.isAbsolute(image) && fs.existsSync(image)) {
        const buf = fs.readFileSync(image);
        const ext = path.extname(image).slice(1).toLowerCase();
        const mime = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
        }[ext] || "image/png";
        return `data:${mime};base64,${buf.toString("base64")}`;
      }
      return image;
    });
    const referenceSchema = resolveReferenceImageSchema(providerDefaults, providerId, modelId);
    attachReferenceImages(body, imageInputs, referenceSchema);
  }

  const base = baseUrl.replace(/\/+$/, "");
  if (shouldUseChatCompletionsForImage(providerDefaults, providerId, modelId)) {
    const endpoint = `${base}/chat/completions`;
    const requestBody = buildChatCompletionImageBody(params, body, imageInputs);
    const result = await postImageRequest(endpoint, apiKey, requestBody);

    if (!result.ok) {
      throw new Error(result.message);
    }

    const responseImages = extractChatCompletionImages(result.data);
    if (responseImages.length === 0) {
      throw new Error("Chat completions image response returned no images");
    }

    const mimeType = FORMAT_TO_MIME[outputFormat] || "image/png";
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const files = [];

    for (let i = 0; i < responseImages.length; i++) {
      const customName = params.filename
        ? (responseImages.length > 1 ? `${params.filename}-${i + 1}` : params.filename)
        : null;
      const { filename } = await saveOpenAICompatibleResponseImage(
        responseImages[i],
        mimeType,
        ctx,
        customName,
      );
      files.push(filename);
    }

    return { taskId, files };
  }

  const referenceSchema = resolveReferenceImageSchema(providerDefaults, providerId, modelId);
  const useGenerationEndpointForRefs = imageInputs.length > 0
    && shouldUseGenerationEndpointForRefs(providerDefaults, referenceSchema);

  let endpoint = useGenerationEndpointForRefs
    ? `${base}/images/generations`
    : body.image && !body.image_urls && !body.images
      ? `${base}/images/edits`
      : `${base}/images/generations`;

  let requestBody = body;
  let { result, body: effectiveBody } = await postImageRequestWithCompatibilityFallback(
    endpoint,
    apiKey,
    requestBody,
    sizeCandidates,
  );
  requestBody = effectiveBody;

  if (!result.ok && shouldRetryWithImagesImageUrl(result)) {
    for (const nested of referenceSchemaFallbackOrder(requestBody)) {
      const fallbackBody = buildImagesImageUrlFallbackBody(requestBody, nested);
      if (!fallbackBody) continue;
      endpoint = `${base}/images/generations`;
      requestBody = fallbackBody;
      ({ result, body: requestBody } = await postImageRequestWithCompatibilityFallback(
        endpoint,
        apiKey,
        requestBody,
        sizeCandidates,
      ));
      if (result.ok) break;
    }
  }

  if (!result.ok && requestBody.image && shouldRetryEditsAsGeneration(result)) {
    endpoint = `${base}/images/generations`;
    requestBody = {
      ...requestBody,
      size: sizeCandidates[0] || requestBody.size,
      image_urls: requestBody.image,
    };
    delete requestBody.image;
    ({ result, body: requestBody } = await postImageRequestWithCompatibilityFallback(
      endpoint,
      apiKey,
      requestBody,
      sizeCandidates,
    ));
  }

  if (!result.ok) {
    ctx.log?.error?.("[image-gen] openai-compatible image request failed", {
      providerId,
      endpoint,
      status: result.status,
      message: result.message,
      requestShape: summarizeRequestShape(requestBody),
    });
    throw new Error(result.message);
  }

  const remoteTaskId = extractRemoteTaskId(result.data);
  if (remoteTaskId) {
    return { taskId: buildRemoteTaskId(providerId, remoteTaskId) };
  }

  const responseImages = result.data?.data || [];
  if (responseImages.length === 0) {
    throw new Error("API returned no images");
  }

  const mimeType = FORMAT_TO_MIME[outputFormat] || "image/png";
  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const files = [];

  for (let i = 0; i < responseImages.length; i++) {
    const customName = params.filename
      ? (responseImages.length > 1 ? `${params.filename}-${i + 1}` : params.filename)
      : null;
    const { filename } = await saveOpenAICompatibleResponseImage(
      responseImages[i],
      mimeType,
      ctx,
      customName,
    );
    files.push(filename);
  }

  return { taskId, files };
}

export const openaiCompatibleImageAdapter = {
  id: "openai-compatible",
  protocolIds: ["openai-compatible", "openai-images"],
  name: "OpenAI Compatible Image",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    resolutions: [],
  },

  async submit(params, ctx) {
    const providerId = params.providerId || params.provider || "openai";
    return submitOpenAICompatibleImage(params, ctx, providerId);
  },

  async query(taskId, ctx) {
    const parsed = parseRemoteTaskId(taskId);
    if (!parsed) {
      throw new Error(`OpenAI-compatible async task id is invalid: ${taskId}`);
    }

    const creds = await resolveProviderCredentials(ctx, parsed.providerId);
    const base = creds.baseUrl.replace(/\/+$/, "");
    const endpoint = `${base}/tasks/${encodeURIComponent(parsed.remoteTaskId)}`;
    const res = await fetch(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${creds.apiKey || "local"}`,
      },
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

    if (!res.ok) {
      throw new Error(buildErrorMessage(res.status, data, rawText));
    }

    const payload = data?.data || data;
    const status = normalizeRemoteTaskStatus(payload?.status);
    if (status === "pending") return { status: "pending" };
    if (status === "failed") {
      return {
        status: "failed",
        failReason: payload?.error?.message || payload?.error || payload?.message || "generation failed",
      };
    }

    const responseImages = extractRemoteResultImages(data);
    if (responseImages.length === 0) {
      return { status: "failed", failReason: "generation completed but returned no image URLs" };
    }

    const files = [];
    const dataDir = ctx.dataDir || path.dirname(ctx.generatedDir);
    for (let i = 0; i < responseImages.length; i++) {
      const { filename } = await saveOpenAICompatibleResponseImage(
        responseImages[i],
        "image/png",
        { ...ctx, dataDir },
        responseImages.length > 1 ? `${parsed.remoteTaskId}-${i + 1}` : parsed.remoteTaskId,
      );
      files.push(filename);
    }

    return { status: "success", files };
  },
};
