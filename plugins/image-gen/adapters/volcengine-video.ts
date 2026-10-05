// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { saveMedia } from "../lib/download.ts";

const DEFAULT_PROVIDER_ID = "volcengine";
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_VIDEO_MODEL = "doubao-seedance-2-0-260128";

function providerPreference(providerId) {
  return providerId === "volcengine-coding"
    ? ["volcengine-coding", "volcengine"]
    : ["volcengine", "volcengine-coding"];
}

async function resolveCredentials(ctx, providerId) {
  const errors = [];
  for (const id of providerPreference(providerId)) {
    const creds = await ctx.bus.request("provider:credentials", { providerId: id });
    if (!creds?.error && creds?.apiKey) {
      return { ...creds, providerId: id };
    }
    if (creds?.error) errors.push(`${id}: ${creds.error}`);
  }

  const suffix = errors.length ? ` (${errors.join("; ")})` : "";
  throw new Error(`Provider "${providerId}" has no API key configured.${suffix}`);
}

function getProviderDefaults(ctx, requestedProviderId, actualProviderId) {
  const allDefaults = ctx.config?.get?.("providerDefaults") || {};
  return allDefaults[requestedProviderId]
    || allDefaults[actualProviderId]
    || allDefaults.volcengine
    || {};
}

function resolveModel(params, ctx, providerId, actualProviderId, defaults) {
  if (params.model) return params.model;
  const defaultVideoModel = ctx.config?.get?.("defaultVideoModel");
  if ((defaultVideoModel?.provider === providerId || defaultVideoModel?.provider === actualProviderId) && defaultVideoModel?.id) {
    return defaultVideoModel.id;
  }
  if (typeof defaults.videoModel === "string" && defaults.videoModel.trim()) return defaults.videoModel.trim();
  if (typeof defaults.video_model === "string" && defaults.video_model.trim()) return defaults.video_model.trim();
  return DEFAULT_VIDEO_MODEL;
}

function normalizeDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(Math.trunc(number), 1), 30);
}

function encodeRemoteId(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function decodeRemoteId(value) {
  return Buffer.from(String(value), "base64url").toString("utf8");
}

async function normalizeImageUrl(image) {
  const value = String(image || "").trim();
  if (!value) return null;
  if (path.isAbsolute(value) && fs.existsSync(value)) {
    const buffer = await fs.promises.readFile(value);
    const ext = path.extname(value).slice(1).toLowerCase();
    const mime = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
    }[ext] || "image/png";
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }
  return value;
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

async function buildContent(params) {
  const content = [{ type: "text", text: String(params.prompt || "").trim() }];
  const images = collectReferenceImages(params);
  for (const image of images) {
    const url = await normalizeImageUrl(image);
    if (url) content.push({ type: "image_url", image_url: { url } });
  }
  return content;
}

function parseJsonResponse(rawText) {
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch {
    return null;
  }
}

function buildErrorMessage(status, data, rawText) {
  const detail = data?.error?.message || data?.message || rawText;
  return `Volcengine video API error ${status}${detail ? `: ${detail}` : ""}`;
}

async function requestJson(url, apiKey, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers || {}),
    },
  });
  const rawText = typeof res.text === "function" ? await res.text() : "";
  const data = parseJsonResponse(rawText);
  if (!res.ok) throw new Error(buildErrorMessage(res.status, data, rawText));
  return data;
}

async function requestOk(url, apiKey, init = {}) {
  const res = await fetch(url, {
    method: "GET",
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers || {}),
    },
  });
  if (res.ok) return true;
  const rawText = typeof res.text === "function" ? await res.text() : "";
  const data = parseJsonResponse(rawText);
  throw new Error(buildErrorMessage(res.status, data, rawText));
}

function extractTaskId(data) {
  return data?.id || data?.data?.id || data?.task_id || data?.taskId || data?.data?.task_id || data?.data?.taskId;
}

function normalizeStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["succeeded", "success", "completed", "done"].includes(status)) return "success";
  if (["failed", "error", "cancelled", "canceled"].includes(status)) return "failed";
  return "pending";
}

function extractVideoUrl(data) {
  return data?.content?.video_url
    || data?.content?.videoUrl
    || data?.data?.content?.video_url
    || data?.data?.content?.videoUrl
    || data?.result?.video_url
    || data?.result?.videoUrl
    || data?.video_url
    || data?.videoUrl;
}

async function saveVideoUrl(videoUrl, ctx, taskId) {
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Failed to download generated video: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || "video/mp4";
  const { filename } = await saveMedia(buffer, mimeType, ctx.dataDir, taskId);
  return filename;
}

function remoteTaskId(providerId, taskId) {
  return `volcvideo_${Buffer.from(providerId, "utf8").toString("hex")}_${encodeRemoteId(taskId)}`;
}

function parseRemoteTaskId(taskId) {
  const match = String(taskId || "").match(/^volcvideo_([a-fA-F0-9]+)_(.+)$/);
  if (!match) return null;
  return {
    providerId: Buffer.from(match[1], "hex").toString("utf8"),
    remoteId: decodeRemoteId(match[2]),
  };
}

export const volcengineVideoAdapter = {
  id: "volcengine-video",
  name: "Volcengine Seedance Video",
  types: ["video"],
  capabilities: {
    ratios: ["adaptive", "1:1", "4:3", "3:4", "16:9", "9:16", "21:9"],
    durations: [5, 10, 15],
  },

  async checkAuth(ctx) {
    try {
      const creds = await resolveCredentials(ctx, DEFAULT_PROVIDER_ID);
      const baseUrl = (creds.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
      await requestOk(`${baseUrl}/models`, creds.apiKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const requestedProviderId = params.providerId || params.provider || DEFAULT_PROVIDER_ID;
    const creds = await resolveCredentials(ctx, requestedProviderId);
    const defaults = getProviderDefaults(ctx, requestedProviderId, creds.providerId);
    const modelId = resolveModel(params, ctx, requestedProviderId, creds.providerId, defaults);
    const baseUrl = creds.baseUrl || DEFAULT_BASE_URL;
    const body = {
      model: modelId,
      content: await buildContent(params),
      generate_audio: Boolean(params.generate_audio ?? params.generateAudio ?? defaults.generate_audio ?? defaults.generateAudio ?? false),
      ratio: params.ratio || params.aspect_ratio || params.aspectRatio || defaults.ratio || defaults.aspect_ratio || defaults.aspectRatio || "adaptive",
      watermark: Boolean(params.watermark ?? defaults.watermark ?? false),
    };
    const duration = normalizeDuration(params.duration ?? defaults.videoDuration ?? defaults.duration);
    if (duration) body.duration = duration;

    const data = await requestJson(`${baseUrl.replace(/\/+$/, "")}/contents/generations/tasks`, creds.apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const taskId = extractTaskId(data);
    if (!taskId) throw new Error("Volcengine video API returned no task id.");
    return { taskId: remoteTaskId(creds.providerId, taskId) };
  },

  async query(taskId, ctx) {
    const parsed = parseRemoteTaskId(taskId);
    if (!parsed) throw new Error(`Invalid Volcengine video task id: ${taskId}`);
    const creds = await resolveCredentials(ctx, parsed.providerId);
    const baseUrl = creds.baseUrl || DEFAULT_BASE_URL;
    const data = await requestJson(
      `${baseUrl.replace(/\/+$/, "")}/contents/generations/tasks/${encodeURIComponent(parsed.remoteId)}`,
      creds.apiKey,
      { method: "GET" },
    );
    const payload = data?.data || data;
    const status = normalizeStatus(payload?.status);
    if (status === "pending") return { status: "pending" };
    if (status === "failed") {
      return { status: "failed", failReason: payload?.error?.message || payload?.message || "video generation failed" };
    }

    const videoUrl = extractVideoUrl(payload);
    if (!videoUrl) return { status: "failed", failReason: "video generation completed but returned no video_url" };
    const filename = await saveVideoUrl(videoUrl, ctx, parsed.remoteId);
    return { status: "success", files: [filename] };
  },
};
