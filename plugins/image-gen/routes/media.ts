// @ts-nocheck
/* global Response, TransformStream */
// plugins/image-gen/routes/media.js
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { buildMediaProviders } from "../lib/provider-utils.ts";
import { createScopedConfigAccessor } from "../lib/scoped-config.ts";
import { isInvalidJsonBodyError, routeError, strictJson } from "../../../server/hono-helpers.ts";
import { inferMediaTypeFromModelId, normalizeModelType } from "../../../shared/model-type-inference.ts";

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
};

function isInvalidFilename(filename) {
  return filename.includes("/") || filename.includes("\\") || filename.includes("..");
}

function safeDownloadName(filename) {
  return filename.replace(/["\r\n]/g, "_");
}

async function safeBusRequest(ctx, type, payload, fallback) {
  try {
    if (!ctx.bus?.request) return fallback;
    return await ctx.bus.request(type, payload) || fallback;
  } catch (err) {
    ctx.log?.warn?.(`[image-gen] ${type} unavailable, using media provider fallback: ${err.message}`);
    return fallback;
  }
}

function protocolAdapterAvailable(ctx, protocolId) {
  if (!protocolId) return false;
  const registry = ctx?._mediaGen?.registry;
  if (typeof registry?.getProtocol !== "function") return true;
  return !!registry.getProtocol(protocolId);
}

function normalizeImageProviderFromCapability(ctx, providerId, provider = {}) {
  const normalizeImageModel = (model) => {
    if (!model?.id) return null;
    const adapterAvailable = protocolAdapterAvailable(ctx, model.protocolId);
    if (!adapterAvailable) {
      ctx.log?.warn?.(
        `[image-gen] settings hide media model "${providerId}/${model.id}": `
        + (model.protocolId
          ? `no adapter registered for protocol "${model.protocolId}"`
          : "protocol unrecognized (model has no protocolId)"),
      );
      return null;
    }
    const explicitType = normalizeModelType(model.type);
    const inferredType = inferMediaTypeFromModelId(model.id, providerId);
    if (!model.protocolId && explicitType !== "image" && inferredType !== "image") return null;
    return {
      id: model.id,
      name: model.name || model.displayName || model.id,
      type: "image",
      adapterAvailable,
      ...(model.protocolId ? { protocolId: model.protocolId } : {}),
      ...(model.credentialLaneId ? { credentialLaneId: model.credentialLaneId } : {}),
    };
  };
  const models = Array.isArray(provider.models)
    ? provider.models.map(normalizeImageModel).filter(Boolean)
    : [];

  return {
    providerId: provider.providerId || providerId,
    displayName: provider.displayName || providerId,
    hasCredentials: provider.hasCredentials !== false,
    unavailableReason: provider.unavailableReason || null,
    baseUrl: provider.baseUrl || "",
    api: provider.api || "",
    runtime: provider.runtime || null,
    credentialLanes: provider.credentialLanes || [],
    activeCredentialLaneId: provider.activeCredentialLaneId || null,
    activeCredentialProviderId: provider.activeCredentialProviderId || null,
    models,
    availableModels: [],
    imageModels: models,
    availableImageModels: [],
  };
}

function mergeImageModels(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const model of group || []) {
      if (!model?.id) continue;
      byId.set(model.id, { ...(byId.get(model.id) || {}), ...model });
    }
  }
  return [...byId.values()];
}

function mergeImageCapabilityProviders(ctx, baseProviders, mediaProviders) {
  const result = { ...(baseProviders || {}) };
  for (const [providerId, provider] of Object.entries(mediaProviders || {})) {
    const imageProvider = normalizeImageProviderFromCapability(ctx, providerId, provider);
    const existing = result[providerId];
    if (!existing) {
      if (imageProvider.models.length > 0 && !isBuiltinCapabilityCatalogOnlyProvider(providerId, provider)) {
        result[providerId] = imageProvider;
      }
      continue;
    }
    const imageModels = mergeImageModels(
      existing.imageModels || existing.models || [],
      imageProvider.models,
    );
    result[providerId] = {
      ...existing,
      displayName: imageProvider.displayName || existing.displayName,
      hasCredentials: imageProvider.hasCredentials,
      unavailableReason: imageProvider.unavailableReason || null,
      baseUrl: imageProvider.baseUrl || existing.baseUrl || "",
      api: imageProvider.api || existing.api || "",
      runtime: imageProvider.runtime || existing.runtime || null,
      credentialLanes: imageProvider.credentialLanes || existing.credentialLanes || [],
      activeCredentialLaneId: imageProvider.activeCredentialLaneId || existing.activeCredentialLaneId || null,
      activeCredentialProviderId: imageProvider.activeCredentialProviderId || existing.activeCredentialProviderId || null,
      imageModels,
      models: imageModels,
      audioModels: existing.audioModels || [],
      musicModels: existing.musicModels || [],
      videoModels: existing.videoModels || [],
      availableImageModels: [],
      availableAudioModels: existing.availableAudioModels || [],
      availableMusicModels: existing.availableMusicModels || [],
      availableVideoModels: existing.availableVideoModels || [],
    };
  }
  return result;
}

function isBuiltinCapabilityCatalogOnlyProvider(providerId, provider = {}) {
  if (provider?.isBuiltin === true) return true;
  const builtinIds = new Set(["openai", "volcengine"]);
  if (!builtinIds.has(providerId)) return false;
  if (provider.runtime || provider.baseUrl || provider.api || provider.activeCredentialLaneId) return false;
  if (Array.isArray(provider.credentialLanes) && provider.credentialLanes.length > 0) return false;
  const models = Array.isArray(provider.models) ? provider.models : [];
  return models.length > 0 && models.every((model) => model?.protocolId);
}

export default function (app, ctx) {
 // Serve generated media -streaming + Range support
  app.get("/media/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (isInvalidFilename(filename)) {
      return c.json({ error: "invalid filename" }, 400);
    }
    const filePath = path.join(ctx.dataDir, "generated", filename);

    let stat;
    try { stat = fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }

    const ext = path.extname(filename).slice(1);
    const mime = MIME[ext] || "application/octet-stream";
    const total = stat.size;
    const range = c.req.header("range");

    if (range) {
 // Range request -partial content (video seeking, progressive load)
      const match = range.match(/bytes=(\d*)-(\d*)/);
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : total - 1;
      const chunkSize = end - start + 1;

      const stream = fs.createReadStream(filePath, { start, end });
      const { readable, writable } = new TransformStream();
      streamPipe(stream, writable);

      return new Response(readable, {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(chunkSize),
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

 // Full request -stream the entire file (no readFileSync)
    const stream = fs.createReadStream(filePath);
    const { readable, writable } = new TransformStream();
    streamPipe(stream, writable);

    return new Response(readable, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(total),
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  app.post("/media/open/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (isInvalidFilename(filename)) {
      return c.json({ error: "invalid filename" }, 400);
    }
    const filePath = path.join(ctx.dataDir, "generated", filename);

    try { fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }

    try {
      await openWithSystem(filePath);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message || "failed to open file" }, 500);
    }
  });

  app.get("/media/download/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (isInvalidFilename(filename)) {
      return c.json({ error: "invalid filename" }, 400);
    }
    const filePath = path.join(ctx.dataDir, "generated", filename);

    let stat;
    try { stat = fs.statSync(filePath); } catch { return c.json({ error: "not found" }, 404); }

    const ext = path.extname(filename).slice(1);
    const mime = MIME[ext] || "application/octet-stream";
    const stream = fs.createReadStream(filePath);
    const { readable, writable } = new TransformStream();
    streamPipe(stream, writable);

    return new Response(readable, {
      headers: {
        "Content-Type": mime,
        "Content-Length": String(stat.size),
        "Content-Disposition": `attachment; filename="${safeDownloadName(filename)}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  // Provider summary for Media settings tab
  app.get("/providers", async (c) => {
    try {
      const agentId = c.req.query("agentId") || c.get("agentId") || null;
      const config = createScopedConfigAccessor(ctx, agentId);
      const [
        { providers: imageProviderCapabilities },
        { models: imageModels },
        { models: audioModels },
        { models: musicModels },
        { models: videoModels },
        { providers: catalog },
      ] = await Promise.all([
        safeBusRequest(ctx, "provider:media-providers", { capability: "image_generation" }, { providers: {} }),
        safeBusRequest(ctx, "provider:models-by-type", { type: "image" }, { models: [] }),
        safeBusRequest(ctx, "provider:models-by-type", { type: "audio" }, { models: [] }),
        safeBusRequest(ctx, "provider:models-by-type", { type: "music" }, { models: [] }),
        safeBusRequest(ctx, "provider:models-by-type", { type: "video" }, { models: [] }),
        safeBusRequest(ctx, "provider:catalog", {}, { providers: [] }),
      ]);
      const providers = mergeImageCapabilityProviders(ctx, buildMediaProviders({
        catalog: catalog || [],
        imageModels: imageModels || [],
        audioModels: audioModels || [],
        musicModels: musicModels || [],
        videoModels: videoModels || [],
      }), imageProviderCapabilities || {});
      return c.json({ providers, config: config.get() || {} });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Save plugin config (default model, provider defaults)
  app.put("/config", async (c) => {
    try {
      const agentId = c.req.query("agentId") || c.get("agentId") || null;
      const config = createScopedConfigAccessor(ctx, agentId);
      const body = await strictJson(c);
      const values = body && typeof body === "object" && !Array.isArray(body) && body.values && typeof body.values === "object" && !Array.isArray(body.values)
        ? body.values
        : body;
      const defaultValidationError = await validateDefaultImageModelConfig(values, ctx);
      if (defaultValidationError) return c.json({ error: defaultValidationError }, 400);
      for (const [key, value] of Object.entries(values || {})) {
        config.set(key, value);
      }
      return c.json({ ok: true });
    } catch (err) {
      if (isInvalidJsonBodyError(err)) return routeError(c, err);
      return c.json({ error: err.message }, 500);
    }
  });

  app.post("/providers/:providerId/models", async (c) => {
    const providerId = c.req.param("providerId");
    try {
      const body = await strictJson(c);
      const model = body?.model || body;
      const result = await ctx.bus.request("provider:add-media-model", {
        providerId,
        capability: "image_generation",
        model,
      });
      if (result?.error) return c.json({ error: result.error }, 400);
      return c.json({ ok: true });
    } catch (err) {
      if (isInvalidJsonBodyError(err)) return routeError(c, err);
      return c.json({ error: err.message }, 500);
    }
  });

  app.delete("/providers/:providerId/models/:modelId", async (c) => {
    const providerId = c.req.param("providerId");
    const modelId = c.req.param("modelId");
    try {
      const result = await ctx.bus.request("provider:remove-media-model", {
        providerId,
        capability: "image_generation",
        modelId,
      });
      if (result?.error) return c.json({ error: result.error }, 400);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err.message }, 500);
    }
  });
}

function openWithSystem(filePath) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let command = "xdg-open";
    let args = [filePath];
    if (platform === "darwin") {
      command = "open";
    } else if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", filePath];
    }
    execFile(command, args, (err) => err ? reject(err) : resolve(undefined));
  });
}

async function validateDefaultImageModelConfig(values, ctx) {
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;
  if (!Object.prototype.hasOwnProperty.call(values, "defaultImageModel")) return null;
  const value = values.defaultImageModel;
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "defaultImageModel must be an object with provider and id";
  }
  const providerId = typeof value.provider === "string" ? value.provider.trim() : "";
  const modelId = typeof value.id === "string" ? value.id.trim() : "";
  if (!providerId || !modelId) return "defaultImageModel requires provider and id";

  const registry = ctx?._mediaGen?.registry;
  if (!registry || typeof ctx.bus?.request !== "function") return null;
  try {
    const resolved = await ctx.bus.request("provider:resolve-media-model", {
      providerId,
      modelId,
      capability: "image_generation",
    });
    if (resolved?.error) return resolved.error;
    if (!resolved?.protocolId) return `media model "${providerId}/${modelId}" missing protocolId`;
    if (!registry.getProtocol?.(resolved.protocolId) && !registry.get?.(providerId)) {
      return `no image adapter registered for protocol ${resolved.protocolId}`;
    }
    return null;
  } catch (err) {
    return err?.message || String(err);
  }
}

/** Pipe a Node.js Readable into a Web WritableStream */
function streamPipe(nodeStream, writable) {
  const writer = writable.getWriter();
  nodeStream.on("data", (chunk) => writer.write(chunk));
  nodeStream.on("end", () => writer.close());
  nodeStream.on("error", () => writer.close());
}
