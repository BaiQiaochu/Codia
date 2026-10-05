// @ts-nocheck
// plugins/image-gen/adapters/volcengine.js
import fs from "fs";
import path from "path";
import { saveImage } from "../lib/download.ts";
import { resolveKnownModelId } from "../lib/provider-utils.ts";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

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

const SIZE_TABLE = {
  "2K": {
    "1:1": "2048x2048",
    "4:3": "2304x1728",
    "3:4": "1728x2304",
    "16:9": "2848x1600",
    "9:16": "1600x2848",
    "3:2": "2496x1664",
    "2:3": "1664x2496",
    "21:9": "3136x1344",
  },
  "4K": {
    "1:1": "4096x4096",
    "4:3": "3456x2592",
    "3:4": "2592x3456",
    "16:9": "4096x2304",
    "9:16": "2304x4096",
    "3:2": "3744x2496",
    "2:3": "2496x3744",
    "21:9": "4704x2016",
  },
};

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

function normalizeTier(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^(2k|4k)$/i.test(raw)) return raw.toUpperCase();
  return raw;
}

function resolveSize(size, aspectRatio, providerDefaults) {
  const effectiveRatio = aspectRatio || providerDefaults?.aspect_ratio || providerDefaults?.aspectRatio || providerDefaults?.ratio;
  const effectiveSize = normalizeTier(size || providerDefaults?.size || providerDefaults?.resolution || "2K");

  if (effectiveRatio && SIZE_TABLE[effectiveSize]) {
    return SIZE_TABLE[effectiveSize][effectiveRatio] || effectiveSize;
  }

  return effectiveSize || "2K";
}

async function normalizeReferenceImage(image) {
  if (path.isAbsolute(image) && fs.existsSync(image)) {
    const buf = await fs.promises.readFile(image);
    const ext = path.extname(image).slice(1).toLowerCase();
    const mime = EXT_TO_MIME[ext] || "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  }
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

async function saveResponseImage(image, mimeType, ctx, customName) {
  if (image?.b64_json) {
    return saveImage(Buffer.from(image.b64_json, "base64"), mimeType, ctx.dataDir, customName);
  }

  const url = image?.url || image?.image_url || image?.imageUrl;
  if (url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download generated image: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const remoteMime = res.headers.get("content-type") || mimeType;
    return saveImage(buffer, remoteMime, ctx.dataDir, customName);
  }

  throw new Error("Volcengine image response contained no b64_json or url");
}

function extractResponseImages(data) {
  const candidates = [
    data?.data,
    data?.result?.data,
    data?.result?.images,
    data?.output?.images,
    data?.images,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }

  return [];
}

export const volcengineImageAdapter = {
  id: "volcengine",
  protocolId: "volcengine-images",
  aliases: ["volcengine-coding"],
  name: "Volcengine Seedream",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"],
    resolutions: ["2k", "4k"],
  },

  async checkAuth(ctx) {
    try {
      await resolveCredentials(ctx, "volcengine");
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err?.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const requestedProviderId = params.providerId || params.provider || "volcengine";
    const creds = await resolveCredentials(ctx, requestedProviderId);
    const baseUrl = creds.baseUrl || DEFAULT_BASE_URL;

    const defaultImageModel = ctx.config?.get?.("defaultImageModel");
    const rawModelId = params.model
      || (defaultImageModel?.provider === requestedProviderId || defaultImageModel?.provider === creds.providerId
        ? defaultImageModel.id
        : null)
      || "seedream-3-0";
    const modelId = resolveKnownModelId("volcengine", rawModelId);

    const allDefaults = ctx.config?.get?.("providerDefaults") || {};
    const providerDefaults = allDefaults[requestedProviderId]
      || allDefaults[creds.providerId]
      || allDefaults.volcengine
      || {};

    const outputFormat = params.format || providerDefaults?.format || "jpeg";
    const aspectRatio = params.aspect_ratio || params.aspectRatio || params.ratio;
    const body = {
      model: modelId,
      prompt: params.prompt,
      response_format: "b64_json",
      output_format: outputFormat,
      size: resolveSize(params.size || params.resolution, aspectRatio, providerDefaults),
      watermark: providerDefaults?.watermark ?? false,
    };

    const referenceImages = collectReferenceImages(params);
    if (referenceImages.length) {
      body.image = await Promise.all(referenceImages.map(normalizeReferenceImage));
    }

    if (providerDefaults.guidance_scale !== undefined) body.guidance_scale = providerDefaults.guidance_scale;
    if (providerDefaults.seed !== undefined) body.seed = providerDefaults.seed;

    const url = `${baseUrl.replace(/\/+$/, "")}/images/generations`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const rawText = await res.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {}

    if (!res.ok) {
      const detail = data?.error?.message || data?.message || rawText;
      throw new Error(`API error ${res.status}${detail ? `: ${detail}` : ""}`);
    }

    const responseImages = extractResponseImages(data);
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
      const { filename } = await saveResponseImage(responseImages[i], mimeType, ctx, customName);
      files.push(filename);
    }

    return { taskId, files };
  },
};
