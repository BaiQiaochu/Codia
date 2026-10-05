// @ts-nocheck
import { saveMedia } from "../lib/download.ts";

const PROVIDER_ID = "minimax";
const DEFAULT_BASE_URL = "https://api.minimax.io";
const DEFAULT_AUDIO_MODEL = "speech-2.8-hd";
const DEFAULT_MUSIC_MODEL = "music-2.6";
const DEFAULT_VOICE_ID = "English_expressive_narrator";

const AUDIO_FORMAT_TO_MIME = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  pcm: "application/octet-stream",
  flac: "audio/flac",
  aac: "audio/aac",
};

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isMiniMaxChatBaseUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    const legacyChatHost = /(^|\.)api\.minimaxi\.com$/i.test(parsed.hostname);
    return legacyChatHost
      || /\/anthropic(\/|$)|\/chat(\/|$)|\/messages(\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalizeBaseUrl(value, { fromChatProvider = false } = {}) {
  if (fromChatProvider && isMiniMaxChatBaseUrl(value)) {
    return DEFAULT_BASE_URL;
  }

  let base = String(value || DEFAULT_BASE_URL).trim();
  if (!base) base = DEFAULT_BASE_URL;
  base = base.replace(/\/+$/, "");
  base = base.replace(/\/anthropic$/i, "");
  base = base.replace(/\/v1$/i, "");
  return base || DEFAULT_BASE_URL;
}

function joinEndpoint(base, endpoint) {
  const cleanEndpoint = String(endpoint || "").trim();
  if (/^https?:\/\//i.test(cleanEndpoint)) return cleanEndpoint;
  return `${base}${cleanEndpoint.startsWith("/") ? cleanEndpoint : `/${cleanEndpoint}`}`;
}

function getProviderDefaults(ctx) {
  const allDefaults = ctx.config?.get?.("providerDefaults") || {};
  return allDefaults?.[PROVIDER_ID] || {};
}

async function resolveCredentials(ctx, defaults = {}) {
  const creds = await ctx.bus.request("provider:credentials", { providerId: PROVIDER_ID })
    .catch((err) => ({ error: err?.message || String(err) }));
  const apiKey = defaults.apiKey || defaults.api_key || creds?.apiKey;
  if (!apiKey) {
    throw new Error('Provider "minimax" has no API key configured.');
  }
  const explicitBase = defaults.mediaBaseUrl || defaults.media_base_url || defaults.baseUrl || defaults.base_url;
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(explicitBase || creds?.baseUrl, { fromChatProvider: !explicitBase && !!creds?.baseUrl }),
  };
}

function resolveModel(params, ctx, defaults, configKey, fallback) {
  if (params.model) return params.model;
  const defaultConfig = ctx.config?.get?.(configKey);
  if (defaultConfig?.provider === PROVIDER_ID && defaultConfig?.id) return defaultConfig.id;
  const defaultKeys = {
    defaultAudioModel: ["audioModel", "audio_model"],
    defaultMusicModel: ["musicModel", "music_model"],
  }[configKey] || [];
  for (const key of defaultKeys) {
    const value = defaults?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value?.id) return value.id;
  }
  return fallback;
}

function parseJsonResponse(rawText) {
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    return null;
  }
}

function errorMessage(status, data, rawText) {
  const baseResp = data?.base_resp || data?.baseResp;
  const detail =
    data?.error?.message
    || data?.error_msg
    || data?.message
    || baseResp?.status_msg
    || rawText;
  return `MiniMax API error ${status}${detail ? `: ${detail}` : ""}`;
}

async function postJson(endpoint, apiKey, body) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const rawText = typeof res.text === "function" ? await res.text() : "";
  const data = parseJsonResponse(rawText);
  const baseResp = data?.base_resp || data?.baseResp;
  if (!res.ok) {
    throw new Error(errorMessage(res.status, data, rawText));
  }
  if (baseResp && Number(baseResp.status_code ?? baseResp.statusCode ?? 0) !== 0) {
    throw new Error(errorMessage(res.status, data, rawText));
  }
  return data;
}

function getPath(root, path) {
  if (!path) return undefined;
  let current = root;
  for (const part of String(path).split(".")) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function configuredValues(data, paths) {
  const out = [];
  for (const path of paths || []) {
    const value = getPath(data, path);
    if (Array.isArray(value)) out.push(...value);
    else if (value != null) out.push(value);
  }
  return out;
}

function parseDataUrl(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64"),
  };
}

function looksLikeBase64(value) {
  const text = String(value || "").trim();
  return text.length >= 24 && /^[A-Za-z0-9+/=\r\n]+$/.test(text) && text.length % 4 === 0;
}

function looksLikeHex(value) {
  const text = String(value || "").trim();
  return text.length >= 16 && text.length % 2 === 0 && /^[0-9a-f]+$/i.test(text);
}

function pushPayload(out, seen, value, defaultMimeType, hint = {}) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) pushPayload(out, seen, item, defaultMimeType, hint);
    return;
  }

  if (typeof value === "object") {
    const nestedMimeType = value.mime_type || value.mimeType || value.content_type || value.contentType || defaultMimeType;
    const nestedValues = [
      value.url,
      value.image_url,
      value.imageUrl,
      value.audio_url,
      value.audioUrl,
      value.file_url,
      value.fileUrl,
      value.b64_json,
      value.base64,
      value.image_base64,
      value.audio_base64,
      value.audio,
      value.hex,
      value.data,
    ];
    for (const item of nestedValues) pushPayload(out, seen, item, nestedMimeType, hint);
    return;
  }

  const text = String(value).trim();
  if (!text) return;
  let payload = null;
  if (/^https?:\/\//i.test(text)) {
    payload = { source: "url", value: text, mimeType: defaultMimeType };
  } else {
    const dataUrl = parseDataUrl(text);
    if (dataUrl) {
      payload = { source: "buffer", value: dataUrl.buffer, mimeType: dataUrl.mimeType };
    } else if (hint.hex || looksLikeHex(text)) {
      payload = { source: "buffer", value: Buffer.from(text, "hex"), mimeType: defaultMimeType };
    } else if (looksLikeBase64(text)) {
      payload = { source: "buffer", value: Buffer.from(text, "base64"), mimeType: defaultMimeType };
    }
  }

  if (!payload) return;
  const key = `${payload.source}:${typeof payload.value === "string" ? payload.value : payload.value.toString("base64").slice(0, 120)}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(payload);
}

function extractAudioPayloads(data, defaults, type, formatOverride = null) {
  const out = [];
  const seen = new Set();
  const paths = type === "music"
    ? defaults.musicResponsePaths || defaults.music_response_paths
    : defaults.audioResponsePaths || defaults.audio_response_paths;
  const configured = configuredValues(data, paths);
  const mimeType = resolveAudioMimeType(defaults, type, formatOverride);
  for (const item of configured) pushPayload(out, seen, item, mimeType, { hex: true });
  const payload = data?.data || data;
  for (const item of [
    payload?.audio_url,
    payload?.audioUrl,
    payload?.audio_urls,
    payload?.audioUrls,
    payload?.audio_base64,
    payload?.audio,
    payload?.music_url,
    payload?.musicUrl,
    payload?.music,
    payload?.file_url,
    payload?.fileUrl,
    payload?.url,
    payload?.files,
    data?.audio,
    data?.data,
  ]) {
    pushPayload(out, seen, item, mimeType, { hex: true });
  }
  return out;
}

async function savePayloads(payloads, ctx, defaultMimeType, namePrefix) {
  if (!payloads.length) {
    throw new Error("MiniMax API returned no downloadable media payloads.");
  }
  const files = [];
  for (let i = 0; i < payloads.length; i++) {
    const payload = payloads[i];
    let buffer;
    let mimeType = payload.mimeType || defaultMimeType;
    if (payload.source === "url") {
      const res = await fetch(payload.value);
      if (!res.ok) throw new Error(`Failed to download MiniMax media: HTTP ${res.status}`);
      buffer = Buffer.from(await res.arrayBuffer());
      mimeType = res.headers.get("content-type") || mimeType;
    } else {
      buffer = payload.value;
    }
    const customName = payloads.length > 1 ? `${namePrefix}-${i + 1}` : namePrefix;
    const { filename } = await saveMedia(buffer, mimeType, ctx.dataDir, customName);
    files.push(filename);
  }
  return files;
}

function resolveAudioMimeType(defaults, type, formatOverride = null) {
  const raw = formatOverride || (type === "music"
    ? defaults.musicFormat || defaults.music_format || defaults.format || "mp3"
    : defaults.audioFormat || defaults.audio_format || defaults.format || "mp3");
  const format = String(raw || "mp3").trim().toLowerCase();
  return AUDIO_FORMAT_TO_MIME[format] || "audio/mpeg";
}

function buildAudioBody(params, ctx, defaults) {
  const model = resolveModel(params, ctx, defaults, "defaultAudioModel", DEFAULT_AUDIO_MODEL);
  const format = params.format || defaults.audioFormat || defaults.audio_format || "mp3";
  const outputFormat =
    params.output_format
    || params.outputFormat
    || defaults.audioResponseFormat
    || defaults.audio_response_format
    || "hex";
  const voiceId = params.voice_id || params.voiceId || params.voice || defaults.voice_id || defaults.voiceId || DEFAULT_VOICE_ID;
  const voiceSetting = {
    voice_id: voiceId,
  };
  if (params.speed != null || defaults.speed != null) voiceSetting.speed = Number(params.speed ?? defaults.speed);
  if (params.volume != null || params.vol != null || defaults.volume != null || defaults.vol != null) {
    voiceSetting.vol = Number(params.volume ?? params.vol ?? defaults.volume ?? defaults.vol);
  }
  if (params.pitch != null || defaults.pitch != null) voiceSetting.pitch = Number(params.pitch ?? defaults.pitch);

  const audioSetting = {
    format,
  };
  if (params.sample_rate || params.sampleRate || defaults.sample_rate || defaults.sampleRate) {
    audioSetting.sample_rate = Number(params.sample_rate || params.sampleRate || defaults.sample_rate || defaults.sampleRate);
  }
  if (params.bitrate || defaults.bitrate) audioSetting.bitrate = Number(params.bitrate || defaults.bitrate);
  if (params.channel || defaults.channel) audioSetting.channel = Number(params.channel || defaults.channel);

  const body = {
    model,
    text: params.text || params.prompt,
    stream: false,
    output_format: outputFormat,
    voice_setting: voiceSetting,
    audio_setting: audioSetting,
  };
  if (params.language_boost || params.languageBoost || defaults.language_boost || defaults.languageBoost) {
    body.language_boost = params.language_boost || params.languageBoost || defaults.language_boost || defaults.languageBoost;
  }
  if (params.emotion || defaults.emotion) body.emotion = params.emotion || defaults.emotion;
  if (defaults.extraAudioBody && typeof defaults.extraAudioBody === "object") {
    Object.assign(body, defaults.extraAudioBody);
  }
  return body;
}

function buildMusicBody(params, ctx, defaults) {
  const model = resolveModel(params, ctx, defaults, "defaultMusicModel", DEFAULT_MUSIC_MODEL);
  const format = params.format || defaults.musicFormat || defaults.music_format || defaults.format || "mp3";
  const outputFormat =
    params.output_format
    || params.outputFormat
    || defaults.musicResponseFormat
    || defaults.music_response_format
    || defaults.output_format
    || "url";
  const lyrics = params.lyrics || params.lyric || "";
  const audioSetting = { format };
  if (params.sample_rate || params.sampleRate || defaults.sample_rate || defaults.sampleRate) {
    audioSetting.sample_rate = Number(params.sample_rate || params.sampleRate || defaults.sample_rate || defaults.sampleRate);
  }
  if (params.bitrate || defaults.bitrate) audioSetting.bitrate = Number(params.bitrate || defaults.bitrate);
  if (params.channel || defaults.channel) audioSetting.channel = Number(params.channel || defaults.channel);

  const body = {
    model,
    prompt: params.prompt,
    output_format: outputFormat,
    audio_setting: audioSetting,
    stream: false,
  };
  if (lyrics) body.lyrics = lyrics;
  if (params.duration || defaults.duration) body.duration = Number(params.duration || defaults.duration);
  if (params.genre || defaults.genre) body.genre = params.genre || defaults.genre;
  if (params.style || defaults.style) body.style = params.style || defaults.style;
  if (params.title || defaults.title) body.title = params.title || defaults.title;
  if (params.instrumental != null || params.is_instrumental != null || defaults.instrumental != null) {
    body.is_instrumental = Boolean(params.instrumental ?? params.is_instrumental ?? defaults.instrumental);
  }
  if (params.lyrics_optimizer != null || params.lyricsOptimizer != null || defaults.lyrics_optimizer != null) {
    body.lyrics_optimizer = Boolean(params.lyrics_optimizer ?? params.lyricsOptimizer ?? defaults.lyrics_optimizer);
  } else if (!lyrics) {
    body.lyrics_optimizer = true;
  }
  if (defaults.extraMusicBody && typeof defaults.extraMusicBody === "object") {
    Object.assign(body, defaults.extraMusicBody);
  }
  return body;
}

async function submitAudio(params, ctx, defaults, creds) {
  const endpoint = joinEndpoint(creds.baseUrl, defaults.audioEndpoint || defaults.audio_endpoint || "/v1/t2a_v2");
  const body = buildAudioBody(params, ctx, defaults);
  const data = await postJson(endpoint, creds.apiKey, body);
  const mimeType = resolveAudioMimeType(defaults, "audio", params.format);
  const payloads = extractAudioPayloads(data, defaults, "audio", params.format);
  const files = await savePayloads(payloads, ctx, mimeType, params.filename || "minimax-audio");
  return { taskId: randomId("minimax_audio"), files };
}

async function submitMusic(params, ctx, defaults, creds) {
  const endpoint = joinEndpoint(creds.baseUrl, defaults.musicEndpoint || defaults.music_endpoint || "/v1/music_generation");
  const body = buildMusicBody(params, ctx, defaults);
  const data = await postJson(endpoint, creds.apiKey, body);
  const mimeType = resolveAudioMimeType(defaults, "music", params.format);
  const payloads = extractAudioPayloads(data, defaults, "music", params.format);
  const files = await savePayloads(payloads, ctx, mimeType, params.filename || "minimax-music");
  return { taskId: randomId("minimax_music"), files };
}

export const minimaxMediaAdapter = {
  id: PROVIDER_ID,
  name: "MiniMax Media",
  types: ["audio", "music"],
  capabilities: {
    audioFormats: ["mp3", "wav", "flac"],
  },

  async checkAuth(ctx) {
    try {
      const defaults = getProviderDefaults(ctx);
      await resolveCredentials(ctx, defaults);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const defaults = getProviderDefaults(ctx);
    const creds = await resolveCredentials(ctx, defaults);
    if (params.type === "audio") return submitAudio(params, ctx, defaults, creds);
    if (params.type === "music") return submitMusic(params, ctx, defaults, creds);
    throw new Error("MiniMax image generation is not supported.");
  },

  async query() {
    return { status: "pending" };
  },
};
