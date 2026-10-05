// @ts-nocheck
import {
  createLocalTaskId,
  downloadImageUrls,
  normalizeBaseUrl,
  normalizeImageInput,
  saveBase64Images,
} from "./common.ts";

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";

function resolveMiniMaxBaseUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL);
  if (base.endsWith("/anthropic")) return `${base.slice(0, -"/anthropic".length)}/v1`;
  if (base.endsWith("/v1")) return base;
  return `${base}/v1`;
}

async function getCredentials(ctx, params = {}) {
  const providerId = params.credentialProviderId || params.providerId || "minimax";
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds.error || !creds.apiKey) {
    throw new Error(`Provider "${providerId}" has no API key configured. Configure it in Settings > Providers.`);
  }
  return creds;
}

function collectBase64Images(data) {
  const raw = data?.data?.image_base64 || data?.data?.images || data?.image_base64;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => typeof item === "string" ? item : item?.base64 || item?.b64_json).filter(Boolean);
  }
  if (typeof raw === "string") return [raw];
  return [];
}

function collectImageUrls(data) {
  const raw = data?.data?.image_urls || data?.data?.images || data?.image_urls;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => typeof item === "string" ? item : item?.url || item?.image_url).filter(Boolean);
  }
  if (typeof raw === "string") return [raw];
  return [];
}

export const minimaxImageAdapter = {
  id: "minimax",
  protocolId: "minimax-images",
  name: "MiniMax Image",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
    resolutions: [],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "minimax" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const creds = await getCredentials(ctx, params);
    const body = {
      model: params.modelId || params.model || "image-01",
      prompt: params.prompt,
      response_format: "base64",
      ...(params.aspect_ratio || params.aspectRatio || params.ratio
        ? { aspect_ratio: params.aspect_ratio || params.aspectRatio || params.ratio }
        : {}),
      ...(params.n ? { n: params.n } : {}),
      ...(params.prompt_optimizer !== undefined ? { prompt_optimizer: params.prompt_optimizer } : {}),
    };

    const images = normalizeImageInput(params.images || params.image);
    if (images.length > 0) {
      body.subject_reference = images.map((image) => ({
        type: "character",
        image_file: image,
      }));
    }

    const res = await fetch(`${resolveMiniMaxBaseUrl(creds.baseUrl)}/image_generation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.base_resp?.status_msg) msg = `${msg}: ${err.base_resp.status_msg}`;
        else if (err.error?.message) msg = `${msg}: ${err.error.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const statusCode = data?.base_resp?.status_code;
    if (statusCode !== undefined && Number(statusCode) !== 0) {
      throw new Error(`MiniMax API error ${statusCode}: ${data?.base_resp?.status_msg || "unknown error"}`);
    }

    const base64Images = collectBase64Images(data);
    const urlImages = collectImageUrls(data);
    const files = base64Images.length
      ? await saveBase64Images(base64Images, "image/jpeg", ctx.dataDir, params.filename)
      : await downloadImageUrls(urlImages, ctx.dataDir, params.filename);
    if (files.length === 0) throw new Error("MiniMax API returned no images");
    return { taskId: data.id || createLocalTaskId(), files };
  },
};
