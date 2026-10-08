// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { saveMedia } from "../lib/download.ts";
import { isOpenAICompatibleApi } from "../lib/provider-utils.ts";

const ADAPTER_ID = "openai-compatible-media";
const TASK_PREFIX = "ocm";

const TYPE_DEFAULTS = {
  audio: {
    endpoint: "/audio/speech",
    configKey: "defaultAudioModel",
    modelKeys: ["audioModel", "audio_model"],
    formatKeys: ["audioFormat", "audio_format", "format"],
    responsePaths: ["audioResponsePaths", "audio_response_paths"],
    mimeType: "audio/mpeg",
    namePrefix: "openai-compatible-audio",
  },
  music: {
    endpoint: "/music/generations",
    configKey: "defaultMusicModel",
    modelKeys: ["musicModel", "music_model"],
    formatKeys: ["musicFormat", "music_format", "format"],
    responsePaths: ["musicResponsePaths", "music_response_paths"],
    mimeType: "audio/mpeg",
    namePrefix: "openai-compatible-music",
  },
  video: {
    endpoint: "/videos/generations",
    configKey: "defaultVideoModel",
    modelKeys: ["videoModel", "video_model"],
    formatKeys: ["videoFormat", "video_format", "format"],
    responsePaths: ["videoResponsePaths", "video_response_paths"],
    mimeType: "video/mp4",
    namePrefix: "openai-compatible-video",
  },
};

const AUDIO_MIME_BY_FORMAT = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

const VIDEO_MIME_BY_FORMAT = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

function isLocalBaseUrl(url = "") {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(String(url || ""));
}

function randomTaskId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function joinEndpoint(baseUrl, endpoint) {
  const cleanEndpoint = String(endpoint || "").trim();
  if (/^https?:\/\//i.test(cleanEndpoint)) return cleanEndpoint;
  const base = trimTrailingSlash(baseUrl);
  return `${base}${cleanEndpoint.startsWith("/") ? cleanEndpoint : `/${cleanEndpoint}`}`;
}

function getProviderDefaults(ctx, providerId) {
  const allDefaults = ctx.config?.get?.("providerDefaults") || {};
  return allDefaults?.[providerId] || {};
}

function getDefaultValue(defaults, keys = []) {
  for (const key of keys) {
    const value = defaults?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function endpointForType(type, defaults) {
  const endpoint =
    defaults?.[`${type}Endpoint`]
    || defaults?.[`${type}_endpoint`]
    || defaults?.endpoint
    || TYPE_DEFAULTS[type]?.endpoint;
  return endpoint;
}

function queryEndpointForType(type, defaults, remoteTaskId) {
  const template =
    defaults?.[`${type}QueryEndpoint`]
    || defaults?.[`${type}_query_endpoint`]
    || defaults?.queryEndpoint
    || defaults?.query_endpoint
    || defaults?.taskEndpoint
    || defaults?.task_endpoint
    || `/tasks/${encodeURIComponent(remoteTaskId)}`;
  return String(template).replace(/\{taskId\}|\{id\}/g, encodeURIComponent(remoteTaskId));
}

async function resolveCredentials(ctx, providerId) {
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds?.error) throw new Error(creds.error);
  if (!creds?.baseUrl && !creds?.base_url) {
    throw new Error(`Provider "${providerId}" has no base URL configured.`);
  }
  const baseUrl = creds.baseUrl || creds.base_url;
  if (!creds.api || !isOpenAICompatibleApi(creds.api)) {
    throw new Error(`Provider "${providerId}" is not an OpenAI-compatible API.`);
  }
  if (!creds.apiKey && !creds.api_key && !isLocalBaseUrl(baseUrl)) {
    throw new Error(`Provider "${providerId}" has no API key configured.`);
  }
  return {
    apiKey: creds.apiKey || creds.api_key || "local",
    baseUrl,
  };
}

async function resolveModel(ctx, providerId, type, params, defaults) {
  if (params.model) return params.model;

  const typeDefaults = TYPE_DEFAULTS[type];
  const configuredDefault = ctx.config?.get?.(typeDefaults.configKey);
  if (configuredDefault?.provider === providerId && configuredDefault?.id) return configuredDefault.id;

  const defaultModel = getDefaultValue(defaults, typeDefaults.modelKeys);
  if (typeof defaultModel === "string" && defaultModel.trim()) return defaultModel.trim();
  if (defaultModel?.id) return defaultModel.id;

  const byType = await ctx.bus.request("provider:models-by-type", { providerId, type })
    .catch(() => ({ models: [] }));
  const firstModel = Array.isArray(byType?.models) ? byType.models[0] : null;
  return firstModel?.id || null;
}

function resolveFormat(defaults, type, params) {
  const raw = params.format || getDefaultValue(defaults, TYPE_DEFAULTS[type].formatKeys);
  const format = String(raw || "").trim().toLowerCase();
  if (!format) return null;
  return format;
}

function resolveMime(defaults, type, params, contentType = "") {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (normalized && !/^(application\/json|text\/plain)$/.test(normalized)) return normalized;
  const format = resolveFormat(defaults, type, params);
  if (type === "video") return VIDEO_MIME_BY_FORMAT[format] || TYPE_DEFAULTS[type].mimeType;
  return AUDIO_MIME_BY_FORMAT[format] || TYPE_DEFAULTS[type].mimeType;
}

function buildAudioBody(params, model, defaults) {
  const body = {
    model,
    input: params.text || params.prompt,
  };
  const voice = params.voice_id || params.voice || defaults.voice_id || defaults.voice || "alloy";
  if (voice) body.voice = voice;
  const format = resolveFormat(defaults, "audio", params);
  if (format) body.response_format = format;
  if (params.speed != null) body.speed = params.speed;
  if (defaults.extraAudioBody && typeof defaults.extraAudioBody === "object") {
    Object.assign(body, defaults.extraAudioBody);
  }
  return body;
}

function buildMusicBody(params, model, defaults) {
  const body = {
    model,
    prompt: params.prompt,
  };
  if (params.lyrics) body.lyrics = params.lyrics;
  if (params.duration != null) body.duration = params.duration;
  if (params.genre) body.genre = params.genre;
  if (params.style) body.style = params.style;
  if (params.instrumental != null) body.instrumental = params.instrumental;
  const format = resolveFormat(defaults, "music", params);
  if (format) body.response_format = format;
  if (defaults.extraMusicBody && typeof defaults.extraMusicBody === "object") {
    Object.assign(body, defaults.extraMusicBody);
  }
  return body;
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
  add(params.image_urls);
  add(params.imageUrls);
  add(params.image);
  return values;
}

function imageMimeForPath(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
  }[ext] || "image/png";
}

function normalizeReferenceImage(value) {
  const image = String(value || "").trim();
  if (!image) return "";
  if (path.isAbsolute(image) && fs.existsSync(image)) {
    const buffer = fs.readFileSync(image);
    return `data:${imageMimeForPath(image)};base64,${buffer.toString("base64")}`;
  }
  return image;
}

function resolveVideoInputField(defaults) {
  const configured = getDefaultValue(defaults, [
    "videoInputField",
    "video_input_field",
    "imageInputField",
    "image_input_field",
  ]);
  return typeof configured === "string" ? configured.trim() : "";
}

function attachVideoReferenceImages(body, images, schema) {
  if (!images.length) return;

  if (schema === "image_urls" || schema === "imageUrls") {
    body.image_urls = images;
    return;
  }

  if (schema === "images[].image_url") {
    body.images = images.map((url) => ({ image_url: url }));
    return;
  }

  if (schema === "images[].image_url.url") {
    body.images = images.map((url) => ({ image_url: { url } }));
    return;
  }

  if (schema === "image_url" || images.length === 1) {
    body.image_url = images[0];
    if (images.length === 1) return;
  }

  if (images.length > 1) body.image_urls = images;
}

function extractVideoReferenceValues(body) {
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
  add(body?.image_url);
  add(body?.image_urls);
  add(body?.imageUrls);
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

function buildVideoImagesImageUrlFallbackBody(body, nested = false) {
  const values = extractVideoReferenceValues(body);
  if (values.length === 0) return null;
  const next = {
    ...body,
    images: values.map((url) => nested ? { image_url: { url } } : { image_url: url }),
  };
  delete next.image_url;
  delete next.image_urls;
  delete next.imageUrls;
  return next;
}

function videoReferenceSchemaFallbackOrder(body) {
  if (bodyUsesFlatImagesImageUrl(body)) return [true];
  if (bodyUsesNestedImagesImageUrl(body)) return [false];
  return [false, true];
}

function buildVideoBody(params, model, defaults) {
  const body = {
    model,
    prompt: params.prompt,
  };
  const images = collectReferenceImages(params).map(normalizeReferenceImage).filter(Boolean);
  attachVideoReferenceImages(body, images, resolveVideoInputField(defaults));
  if (params.duration != null) body.duration = params.duration;
  const aspectRatio = params.aspect_ratio || params.aspectRatio || params.ratio || defaults.aspect_ratio || defaults.aspectRatio || defaults.ratio;
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (params.generateAudio != null) body.generate_audio = params.generateAudio;
  if (params.generate_audio != null) body.generate_audio = params.generate_audio;
  if (params.watermark != null) body.watermark = params.watermark;
  const format = resolveFormat(defaults, "video", params);
  if (format) body.response_format = format;
  if (defaults.extraVideoBody && typeof defaults.extraVideoBody === "object") {
    Object.assign(body, defaults.extraVideoBody);
  }
  return body;
}

function buildRequestBody(type, params, model, defaults) {
  if (type === "audio") return buildAudioBody(params, model, defaults);
  if (type === "music") return buildMusicBody(params, model, defaults);
  return buildVideoBody(params, model, defaults);
}

async function postJsonOrMedia(endpoint, apiKey, body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const contentType = res.headers?.get?.("content-type") || "";
  if (!res.ok) {
    const raw = typeof res.text === "function" ? await res.text() : "";
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    const detail = parsed?.error?.message || parsed?.message || raw;
    const err = new Error(`API error ${res.status}${detail ? `: ${detail}` : ""}`);
    err.status = res.status;
    err.data = parsed;
    err.rawText = raw;
    throw err;
  }

  if (/application\/json|text\/json/i.test(contentType)) {
    const raw = typeof res.text === "function" ? await res.text() : "";
    try {
      return { data: raw ? JSON.parse(raw) : null, contentType };
    } catch {
      return { data: raw, contentType };
    }
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

function shouldRetryWithImagesImageUrl(err) {
  if (![400, 422].includes(Number(err?.status))) return false;
  return /images\[\]\.image_url|image_url\s+is\s+required|images.*image_url/i.test(err?.message || "");
}

async function postJsonOrMediaWithVideoFallback(endpoint, apiKey, body, type) {
  try {
    return await postJsonOrMedia(endpoint, apiKey, body);
  } catch (err) {
    if (type !== "video" || !shouldRetryWithImagesImageUrl(err)) throw err;

    let lastError = err;
    for (const nested of videoReferenceSchemaFallbackOrder(body)) {
      const fallbackBody = buildVideoImagesImageUrlFallbackBody(body, nested);
      if (!fallbackBody) continue;
      try {
        return await postJsonOrMedia(endpoint, apiKey, fallbackBody);
      } catch (nextErr) {
        lastError = nextErr;
        if (!shouldRetryWithImagesImageUrl(nextErr)) throw nextErr;
      }
    }
    throw lastError;
  }
}

async function getJson(endpoint, apiKey) {
  const res = await fetch(endpoint, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const raw = typeof res.text === "function" ? await res.text() : "";
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch {}
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || raw;
    throw new Error(`API error ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

function getPath(root, path) {
  let current = root;
  for (const part of String(path || "").split(".")) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function configuredResponseValues(data, defaults, type) {
  const keys = TYPE_DEFAULTS[type].responsePaths;
  const paths = [];
  for (const key of keys) {
    const value = defaults?.[key];
    if (Array.isArray(value)) paths.push(...value);
  }
  return paths.flatMap((path) => {
    const value = getPath(data, path);
    return Array.isArray(value) ? value : value == null ? [] : [value];
  });
}

function looksLikeBase64(value) {
  const text = String(value || "").trim();
  return text.length >= 24 && /^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.replace(/\s/g, "").length % 4 === 0;
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2].replace(/\s/g, ""), "base64"),
  };
}

function pushPayload(out, seen, value, defaultMimeType) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) pushPayload(out, seen, item, defaultMimeType);
    return;
  }
  if (typeof value === "object") {
    const mimeType = value.mime_type || value.mimeType || value.content_type || value.contentType || defaultMimeType;
    for (const key of [
      "url", "uri", "file_url", "fileUrl",
      "audio_url", "audioUrl", "music_url", "musicUrl", "video_url", "videoUrl",
      "b64_json", "base64", "audio_base64", "video_base64", "data",
      "audio", "music", "video", "file", "files",
    ]) {
      pushPayload(out, seen, value[key], mimeType);
    }
    return;
  }

  const text = String(value).trim();
  if (!text) return;
  const dataUrl = parseDataUrl(text);
  let payload = null;
  if (/^https?:\/\//i.test(text)) {
    payload = { source: "url", value: text, mimeType: defaultMimeType };
  } else if (dataUrl) {
    payload = { source: "buffer", value: dataUrl.buffer, mimeType: dataUrl.mimeType || defaultMimeType };
  } else if (looksLikeBase64(text)) {
    payload = { source: "buffer", value: Buffer.from(text.replace(/\s/g, ""), "base64"), mimeType: defaultMimeType };
  }

  if (!payload) return;
  const key = `${payload.source}:${typeof payload.value === "string" ? payload.value : payload.value.toString("base64").slice(0, 120)}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(payload);
}

function extractPayloads(data, defaults, type, defaultMimeType) {
  const out = [];
  const seen = new Set();
  for (const item of configuredResponseValues(data, defaults, type)) {
    pushPayload(out, seen, item, defaultMimeType);
  }
  for (const item of [
    data?.data,
    data?.output,
    data?.result,
    data?.file,
    data?.files,
    data?.url,
    data?.urls,
    data?.audio,
    data?.music,
    data?.video,
    data?.audio_url,
    data?.music_url,
    data?.video_url,
    data?.audio_urls,
    data?.video_urls,
    data?.file_url,
  ]) {
    pushPayload(out, seen, item, defaultMimeType);
  }
  return out;
}

async function savePayloads(payloads, ctx, defaultMimeType, namePrefix) {
  const files = [];
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    let buffer = payload.value;
    let mimeType = payload.mimeType || defaultMimeType;
    if (payload.source === "url") {
      const res = await fetch(payload.value);
      if (!res.ok) throw new Error(`Failed to download generated media: HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
      mimeType = res.headers?.get?.("content-type") || mimeType;
    }
    const customName = payloads.length > 1 ? `${namePrefix}-${i + 1}` : namePrefix;
    const { filename } = await saveMedia(buffer, mimeType, ctx.dataDir, customName);
    files.push(filename);
  }
  return files;
}

function encodeRemoteTaskId(providerId, type, remoteTaskId) {
  const providerToken = Buffer.from(String(providerId || ""), "utf8").toString("hex");
  const safeRemoteId = String(remoteTaskId || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${TASK_PREFIX}_${providerToken}_${type}_${safeRemoteId}`;
}

function parseRemoteTaskId(taskId) {
  const match = String(taskId || "").match(/^ocm_([a-fA-F0-9]+)_([a-z]+)_(.+)$/);
  if (!match) return null;
  return {
    providerId: Buffer.from(match[1], "hex").toString("utf8"),
    type: match[2],
    remoteTaskId: match[3],
  };
}

function extractRemoteTaskId(data) {
  const candidates = [data, data?.data, data?.result, data?.output, data?.task];
  for (const candidate of candidates) {
    const item = Array.isArray(candidate) ? candidate[0] : candidate;
    if (!item || typeof item !== "object") continue;
    const id = item.task_id || item.taskId || item.id || item.task?.id || item.task?.task_id;
    if (id) return id;
  }
  return null;
}

function normalizeStatus(data) {
  const payload = data?.data || data?.result || data?.output || data;
  const status = String(payload?.status || payload?.state || "").toLowerCase();
  if (["completed", "succeeded", "success", "done", "finished"].includes(status)) return "success";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "pending";
}

export async function submitOpenAICompatibleMedia(params, ctx, providerId) {
  const type = params.type;
  const typeDefaults = TYPE_DEFAULTS[type];
  if (!typeDefaults) throw new Error(`Unsupported OpenAI-compatible media type: ${type}`);

  const defaults = getProviderDefaults(ctx, providerId);
  const creds = await resolveCredentials(ctx, providerId);
  const model = await resolveModel(ctx, providerId, type, params, defaults);
  if (!model) throw new Error(`Provider "${providerId}" has no configured ${type} model.`);

  const endpoint = joinEndpoint(creds.baseUrl, endpointForType(type, defaults));
  const body = buildRequestBody(type, params, model, defaults);
  const response = await postJsonOrMediaWithVideoFallback(endpoint, creds.apiKey, body, type);
  const mimeType = resolveMime(defaults, type, params, response.contentType);
  const namePrefix = `${typeDefaults.namePrefix}-${providerId}`;

  if (response.buffer) {
    const { filename } = await saveMedia(response.buffer, mimeType, ctx.dataDir, namePrefix);
    return { taskId: randomTaskId(`${TASK_PREFIX}_${type}`), files: [filename] };
  }

  const payloads = extractPayloads(response.data, defaults, type, mimeType);
  if (payloads.length > 0) {
    return {
      taskId: randomTaskId(`${TASK_PREFIX}_${type}`),
      files: await savePayloads(payloads, ctx, mimeType, namePrefix),
    };
  }

  const remoteTaskId = extractRemoteTaskId(response.data);
  if (remoteTaskId) return { taskId: encodeRemoteTaskId(providerId, type, remoteTaskId) };

  throw new Error(`OpenAI-compatible ${type} response returned no downloadable media payloads.`);
}

export const openaiCompatibleMediaAdapter = {
  id: ADAPTER_ID,
  name: "OpenAI Compatible Media",
  types: ["audio", "music", "video"],

  async checkAuth(ctx) {
    if (!ctx.providerId) return { ok: true };
    try {
      await resolveCredentials(ctx, ctx.providerId);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const providerId = params.providerId || params.provider;
    if (!providerId) throw new Error("OpenAI-compatible media provider id is required.");
    return submitOpenAICompatibleMedia(params, ctx, providerId);
  },

  async query(taskId, ctx) {
    const parsed = parseRemoteTaskId(taskId);
    if (!parsed) throw new Error(`OpenAI-compatible media task id is invalid: ${taskId}`);

    const defaults = getProviderDefaults(ctx, parsed.providerId);
    const creds = await resolveCredentials(ctx, parsed.providerId);
    const endpoint = joinEndpoint(creds.baseUrl, queryEndpointForType(parsed.type, defaults, parsed.remoteTaskId));
    const data = await getJson(endpoint, creds.apiKey);
    const status = normalizeStatus(data);
    if (status === "pending") return { status: "pending" };
    if (status === "failed") {
      return { status: "failed", failReason: data?.error?.message || data?.message || "generation failed" };
    }

    const mimeType = resolveMime(defaults, parsed.type, ctx.task?.params || {});
    const payloads = extractPayloads(data, defaults, parsed.type, mimeType);
    if (payloads.length === 0) {
      return { status: "failed", failReason: "generation completed but returned no downloadable media payloads" };
    }
    const dataDir = ctx.dataDir;
    const files = await savePayloads(payloads, { ...ctx, dataDir }, mimeType, `${TYPE_DEFAULTS[parsed.type].namePrefix}-${parsed.remoteTaskId}`);
    return { status: "success", files };
  },
};
