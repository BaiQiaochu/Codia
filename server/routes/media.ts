// @ts-nocheck
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { createScopedConfigAccessor } from "../../plugins/image-gen/lib/scoped-config.ts";

const DEFAULT_MAX_GENERATED_MEDIA_BYTES = 50 * 1024 * 1024;
const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

export function createMediaRoute(engine, hub = null, options = {}) {
  const route = new Hono();
  const maxGeneratedMediaBytes = normalizePositiveInteger(
    options.maxGeneratedMediaBytes,
    DEFAULT_MAX_GENERATED_MEDIA_BYTES,
  );

  route.post("/media/generate", async (c) => forwardMediaGeneration(c, engine, hub, "media:generate"));
  route.post("/media/image/generate", async (c) => forwardMediaGeneration(c, engine, hub, "media:generate-image"));
  route.post("/media/video/generate", async (c) => forwardMediaGeneration(c, engine, hub, "media:generate-video"));

  route.post("/media/asr/transcribe", async (c) => {
    try {
      const body = await safeJson(c);
      const result = await transcribeCompat(engine, body);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 400);
    }
  });

  route.get("/media/providers", async (c) => {
    const capability = normalizeCapability(c.req.query("capability") || "image_generation");
    return listMediaProviders(c, engine, hub, capability);
  });
  route.get("/media/image/providers", (c) => listMediaProviders(c, engine, hub, "image_generation"));
  route.get("/media/video/providers", (c) => listMediaProviders(c, engine, hub, "video_generation"));

  route.put("/media/image/config", async (c) => saveMediaConfig(c, engine));
  route.put("/media/video/config", async (c) => saveMediaConfig(c, engine));

  route.post("/media/image/providers/:providerId/models", async (c) => saveProviderModel(c, engine, hub, "image_generation"));
  route.post("/media/video/providers/:providerId/models", async (c) => saveProviderModel(c, engine, hub, "video_generation"));
  route.delete("/media/image/providers/:providerId/models/:modelId", async (c) => removeProviderModel(c, engine, hub, "image_generation"));
  route.delete("/media/video/providers/:providerId/models/:modelId", async (c) => removeProviderModel(c, engine, hub, "video_generation"));

  route.get("/media/tasks", async (c) => {
    try {
      const payload = {};
      const status = c.req.query("status") || c.req.query("filter");
      if (status) payload.status = status;
      const result = await requestBus(engine, hub, "media-gen:get-tasks", payload);
      return c.json({ tasks: result?.tasks || [] });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 500);
    }
  });

  route.get("/media/tasks/batch/:batchId", async (c) => {
    try {
      const result = await requestBus(engine, hub, "media-gen:get-tasks", { batchId: c.req.param("batchId") });
      return c.json({ tasks: result?.tasks || [] });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 500);
    }
  });

  route.get("/media/tasks/:taskId", async (c) => {
    try {
      const result = await requestBus(engine, hub, "media-gen:get-task", { taskId: c.req.param("taskId") });
      if (!result?.task) return c.json({ error: "not found" }, 404);
      return c.json({ task: result.task });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 500);
    }
  });

  route.post("/media/tasks/:taskId/retry", async (c) => {
    try {
      const result = await requestBus(engine, hub, "task:retry", { taskId: c.req.param("taskId") });
      return c.json(result || { ok: true });
    } catch (err) {
      return c.json({ error: err?.message || String(err) }, 500);
    }
  });

  route.get("/media/generated/:filename", async (c) => serveGeneratedMedia(c, engine, maxGeneratedMediaBytes));

  route.post("/media/generated/open/:filename", async (c) => {
    try {
      const filePath = resolveGeneratedFile(engine, c.req.param("filename"));
      const file = await statGeneratedMediaFile(filePath, maxGeneratedMediaBytes);
      if (file.error) return c.json({ error: file.error }, file.status);
      await openWithSystem(filePath);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err?.message || "failed to open file" }, 500);
    }
  });

  return route;
}

async function forwardMediaGeneration(c, engine, hub, type) {
  try {
    const body = await safeJson(c);
    const media = engine?.media;
    if (media) {
      if (type === "media:generate" && typeof media.generateMedia === "function") {
        return c.json(await media.generateMedia(body));
      }
      if (type === "media:generate-image" && typeof media.generateImageFromBus === "function") {
        return c.json(await media.generateImageFromBus(body));
      }
      if (type === "media:generate-video" && typeof media.generateVideoFromBus === "function") {
        return c.json(await media.generateVideoFromBus(body));
      }
    }
    const result = await requestBus(engine, hub, type, withResponseDelivery(body));
    if (result?.error) return c.json(result, 400);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
}

async function listMediaProviders(c, engine, hub, capability) {
  try {
    if (capability === "speech_recognition") {
      if (!engine?.speechRecognition?.listProviders) throw new Error("speech recognition service unavailable");
      return c.json(engine.speechRecognition.listProviders());
    }
    if (capability === "image_generation" && typeof engine?.media?.listImageProviders === "function") {
      return c.json(await engine.media.listImageProviders());
    }
    if (capability === "video_generation" && typeof engine?.media?.listVideoProviders === "function") {
      return c.json(await engine.media.listVideoProviders());
    }
    const result = await requestBus(engine, hub, "provider:media-providers", { capability });
    return c.json(result || { providers: {} });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 500);
  }
}

async function saveMediaConfig(c, engine) {
  try {
    const body = await safeJson(c);
    const values = body?.values && typeof body.values === "object" && !Array.isArray(body.values)
      ? body.values
      : body;
    const patch = {};
    for (const [key, value] of Object.entries(values || {})) {
      patch[key] = value === null ? undefined : value;
    }
    if (c.req.path.endsWith("/media/image/config") && typeof engine?.media?.setImageConfig === "function") {
      const next = await engine.media.setImageConfig(patch);
      return c.json({ ok: true, config: next || {}, values: next || {} });
    }
    if (c.req.path.endsWith("/media/video/config") && typeof engine?.media?.setVideoConfig === "function") {
      const next = await engine.media.setVideoConfig(patch);
      return c.json({ ok: true, config: next || {}, values: next || {} });
    }
    const config = resolveImageGenConfig(engine, c.req.query("agentId"));
    for (const [key, value] of Object.entries(values || {})) {
      config.set(key, value === null ? undefined : value);
    }
    return c.json({ ok: true, config: config.get() || {}, values: config.get() || {} });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
}

async function saveProviderModel(c, engine, hub, capability) {
  try {
    const body = await safeJson(c);
    const model = body?.model || body;
    const result = await requestBus(engine, hub, "provider:add-media-model", {
      providerId: c.req.param("providerId"),
      capability,
      model,
    });
    if (result?.error) return c.json({ error: result.error }, 400);
    return c.json(result || { ok: true });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
}

async function removeProviderModel(c, engine, hub, capability) {
  try {
    const result = await requestBus(engine, hub, "provider:remove-media-model", {
      providerId: c.req.param("providerId"),
      capability,
      modelId: c.req.param("modelId"),
    });
    if (result?.error) return c.json({ error: result.error }, 400);
    return c.json(result || { ok: true });
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
}

async function transcribeCompat(engine, body = {}) {
  if (typeof engine?.media?.transcribeAudio === "function") {
    return engine.media.transcribeAudio(body);
  }
  const service = engine?.speechRecognition;
  if (!service) throw new Error("speech recognition service unavailable");
  const language = body.language || body.lang;
  if (body.sessionPath && body.fileId && typeof service.transcribeVoiceAttachment === "function") {
    return service.transcribeVoiceAttachment({ sessionPath: body.sessionPath, fileId: body.fileId, language });
  }
  if (typeof service.transcribeFile !== "function") throw new Error("speech recognition file transcription unavailable");
  const filePath = body.filePath || body.realPath || body.path || body.file?.filePath || body.file?.realPath;
  if (!filePath) throw new Error("audio file path is required");
  return service.transcribeFile({
    file: {
      ...(body.file && typeof body.file === "object" ? body.file : {}),
      filePath,
      realPath: body.realPath || filePath,
      displayName: body.displayName || body.filename || path.basename(filePath),
      filename: body.filename || path.basename(filePath),
      mime: body.mime || body.type || "audio/webm",
    },
    language,
  });
}

function withResponseDelivery(body = {}) {
  const payload = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
  const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
    ? payload.input
    : null;
  const hasSessionPath = typeof payload.sessionPath === "string" && payload.sessionPath.trim()
    || typeof input?.sessionPath === "string" && input.sessionPath.trim();
  const hasDelivery = payload.delivery !== undefined
    || payload.deliveryMode !== undefined
    || input?.delivery !== undefined
    || input?.deliveryMode !== undefined;
  if (!hasSessionPath && !hasDelivery) payload.delivery = { mode: "response" };
  return payload;
}

async function requestBus(engine, hub, type, payload) {
  const bus = hub?.eventBus || engine?.getEventBus?.() || engine?.eventBus;
  if (!bus?.request) throw new Error("media event bus unavailable");
  return bus.request(type, payload);
}

function resolveImageGenConfig(engine, agentId = null) {
  const plugin = engine?.pluginManager?.getPlugin?.("image-gen");
  const ctx = plugin?.ctx;
  if (!ctx?.dataDir) throw new Error("image-gen plugin unavailable");
  return createScopedConfigAccessor(ctx, agentId || null);
}

function resolveGeneratedDir(engine) {
  const plugin = engine?.pluginManager?.getPlugin?.("image-gen");
  const ctx = plugin?.ctx;
  const dir = ctx?._mediaGen?.generatedDir || (ctx?.dataDir ? path.join(ctx.dataDir, "generated") : "");
  if (!dir) throw new Error("image-gen generated directory unavailable");
  return dir;
}

function resolveGeneratedFile(engine, rawFilename) {
  const filename = String(rawFilename || "");
  if (!filename || filename !== path.basename(filename) || filename.includes("..")) {
    throw new Error("invalid filename");
  }
  return path.join(resolveGeneratedDir(engine), filename);
}

async function serveGeneratedMedia(c, engine, maxGeneratedMediaBytes = DEFAULT_MAX_GENERATED_MEDIA_BYTES) {
  let filePath;
  try {
    filePath = resolveGeneratedFile(engine, c.req.param("filename"));
  } catch (err) {
    return c.json({ error: err?.message || String(err) }, 400);
  }
  const file = await statGeneratedMediaFile(filePath, maxGeneratedMediaBytes);
  if (file.error) return c.json({ error: file.error }, file.status);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const stream = Readable.toWeb(fs.createReadStream(filePath));
  return new Response(stream, {
    headers: {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": String(file.stat.size),
      "Cache-Control": "no-store",
    },
  });
}

async function statGeneratedMediaFile(filePath, maxGeneratedMediaBytes) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return { error: "not found", status: 404 };
    if (stat.size > maxGeneratedMediaBytes) {
      return { error: "media_file_too_large", status: 413 };
    }
    return { stat };
  } catch (err) {
    if (err?.code === "ENOENT") return { error: "not found", status: 404 };
    throw err;
  }
}

function normalizePositiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function normalizeCapability(value) {
  const text = String(value || "").trim();
  if (text === "image" || text === "imageGeneration") return "image_generation";
  if (text === "video" || text === "videoGeneration") return "video_generation";
  if (text === "asr" || text === "transcription" || text === "speechRecognition") return "speech_recognition";
  return text || "image_generation";
}

function openWithSystem(filePath) {
  return new Promise((resolve, reject) => {
    if (process.platform === "darwin") {
      execFile("open", [filePath], (err) => err ? reject(err) : resolve(null));
      return;
    }
    if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", "", filePath], (err) => err ? reject(err) : resolve(null));
      return;
    }
    execFile("xdg-open", [filePath], (err) => err ? reject(err) : resolve(null));
  });
}
