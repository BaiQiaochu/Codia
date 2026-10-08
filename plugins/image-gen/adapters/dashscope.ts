// @ts-nocheck
import {
  createLocalTaskId,
  downloadImageUrls,
  normalizeBaseUrl,
  normalizeImageInput,
} from "./common.ts";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";

function resolveDashScopeBaseUrl(baseUrl) {
  const base = normalizeBaseUrl(baseUrl, DEFAULT_BASE_URL);
  if (base.endsWith("/compatible-mode/v1")) {
    return `${base.slice(0, -"/compatible-mode/v1".length)}/api/v1`;
  }
  if (base.endsWith("/api/v1")) return base;
  return `${base}/api/v1`;
}

async function getCredentials(ctx, params = {}) {
  const providerId = params.credentialProviderId || params.providerId || "dashscope";
  const creds = await ctx.bus.request("provider:credentials", { providerId });
  if (creds.error || !creds.apiKey) {
    throw new Error(`Provider "${providerId}" has no API key configured. Configure it in Settings > Providers.`);
  }
  return creds;
}

function collectDashScopeUrls(data) {
  const urls = [];
  for (const item of data?.output?.results || []) {
    if (item?.url) urls.push(item.url);
    if (item?.image) urls.push(item.image);
  }
  for (const choice of data?.output?.choices || []) {
    for (const part of choice?.message?.content || []) {
      if (part?.image) urls.push(part.image);
      if (part?.image_url) urls.push(part.image_url);
    }
  }
  if (Array.isArray(data?.output?.images)) {
    for (const item of data.output.images) {
      if (typeof item === "string") urls.push(item);
      else if (item?.url) urls.push(item.url);
    }
  }
  return [...new Set(urls)];
}

function buildMessages(prompt, images) {
  const content = [{ text: prompt }];
  for (const image of images) content.push({ image });
  return [{ role: "user", content }];
}

function modelFamily(modelId) {
  if (String(modelId || "").startsWith("qwen-image-2")) return "qwen-multimodal";
  if (String(modelId || "").startsWith("qwen-image")) return "qwen-text2image";
  return "wan";
}

function generationParameters(params, family) {
  const parameters = {
    n: 1,
    ...(params.size || params.resolution ? { size: params.size || params.resolution } : {}),
  };
  if (family === "wan") {
    if (params.aspect_ratio || params.aspectRatio || params.ratio) {
      parameters.aspect_ratio = params.aspect_ratio || params.aspectRatio || params.ratio;
    }
    return parameters;
  }
  if (params.negative_prompt || params.negativePrompt) {
    parameters.negative_prompt = params.negative_prompt || params.negativePrompt;
  }
  if (params.prompt_extend !== undefined || params.promptExtend !== undefined) {
    parameters.prompt_extend = params.prompt_extend ?? params.promptExtend;
  }
  if (params.watermark !== undefined) parameters.watermark = params.watermark;
  return parameters;
}

export const dashscopeImageAdapter = {
  id: "dashscope",
  protocolId: "dashscope-wan-images",
  protocolIds: [
    "dashscope-images",
    "dashscope-qwen-multimodal-image",
    "dashscope-qwen-text2image",
  ],
  name: "DashScope Image",
  types: ["image"],
  capabilities: {
    ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"],
    resolutions: ["1K", "2K", "4K"],
  },

  async checkAuth(ctx) {
    try {
      await getCredentials(ctx, { providerId: "dashscope" });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err.message || String(err) };
    }
  },

  async submit(params, ctx) {
    const creds = await getCredentials(ctx, params);
    const modelId = params.modelId || params.model || "wan2.7-image-pro";
    const family = modelFamily(modelId);
    const body = {
      model: modelId,
      input: family === "qwen-text2image"
        ? { prompt: params.prompt }
        : { messages: buildMessages(params.prompt, normalizeImageInput(params.images || params.image)) },
      parameters: generationParameters(params, family),
    };
    const endpoint = family === "qwen-text2image"
      ? "/services/aigc/text2image/image-synthesis"
      : family === "qwen-multimodal"
        ? "/services/aigc/multimodal-generation/generation"
        : "/services/aigc/image-generation/generation";
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${creds.apiKey}`,
    };
    if (family !== "qwen-multimodal") headers["X-DashScope-Async"] = "enable";

    const res = await fetch(`${resolveDashScopeBaseUrl(creds.baseUrl)}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = `API error ${res.status}`;
      try {
        const err = await res.json();
        if (err.message) msg = `${msg}: ${err.message}`;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    if (data.code && data.code !== "Success") {
      throw new Error(`DashScope API error ${data.code}: ${data.message || "unknown error"}`);
    }
    const taskId = data?.output?.task_id || data?.output?.taskId || data?.request_id || createLocalTaskId();
    const urls = collectDashScopeUrls(data);
    if (urls.length > 0) {
      const files = await downloadImageUrls(urls, ctx.dataDir, params.filename);
      return { taskId, files };
    }
    return { taskId };
  },

  async query(taskId, ctx) {
    const creds = await getCredentials(ctx, {
      providerId: ctx.task?.params?.credentialProviderId || ctx.task?.credentialProviderId || "dashscope",
    });
    const res = await fetch(`${resolveDashScopeBaseUrl(creds.baseUrl)}/tasks/${encodeURIComponent(taskId)}`, {
      headers: { "Authorization": `Bearer ${creds.apiKey}` },
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    const status = data?.output?.task_status || data?.output?.taskStatus;
    if (status && !["SUCCEEDED", "FAILED", "CANCELED"].includes(status)) {
      return { status: "pending" };
    }
    if (status === "FAILED" || status === "CANCELED") {
      return { status: "failed", error: data?.message || status };
    }
    const urls = collectDashScopeUrls(data);
    if (urls.length === 0) return { status: "pending" };
    const files = await downloadImageUrls(urls, ctx.dataDir);
    return { status: "success", files };
  },
};
