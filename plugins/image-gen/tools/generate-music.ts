import path from "node:path";
import { missingModel, runAdapterPreflight, taskFailure } from "../lib/preflight.ts";
import { createScopedConfigAccessor } from "../lib/scoped-config.ts";
import { resolveMediaAdapter } from "../lib/resolve-media-adapter.ts";
import { bridgeDeliveryTarget } from "../lib/bridge-delivery-target.ts";

export const name = "generate-music";
export const description =
  "Generate music from a prompt and optional lyrics. Non-blocking: returns a media card and updates it when complete.";

export const parameters = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "Music style or generation prompt" },
    lyrics: { type: "string", description: "Optional lyrics" },
    duration: { type: "number", description: "Optional duration in seconds" },
    genre: { type: "string", description: "Optional genre" },
    style: { type: "string", description: "Optional style" },
    instrumental: { type: "boolean", description: "Generate instrumental music" },
    format: { type: "string", description: "Output format, e.g. mp3, wav, flac" },
    output_format: { type: "string", description: "Response format, e.g. url, hex, base64" },
    sample_rate: { type: "number", description: "Audio sample rate" },
    bitrate: { type: "number", description: "Audio bitrate" },
    channel: { type: "number", description: "Audio channel count" },
    model: { type: "string", description: "Music model id" },
    provider: { type: "string", description: "Optional provider id, e.g. minimax" },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  const { registry, store, poller } = ctx._mediaGen || {};
  if (!registry || !store || !poller) {
    return { content: [{ type: "text", text: "Music generation plugin is not initialized" }] };
  }

  const config = createScopedConfigAccessor(ctx, ctx.agentId || null);
  const defaultMusicModel = config.get("defaultMusicModel");
  const { adapter, providerId, modelId } = await resolveMediaAdapter({
    registry,
    bus: ctx.bus,
    type: "music",
    inputProvider: input.provider,
    defaultModel: defaultMusicModel,
  });
  if (!adapter) {
    return missingModel("music", "No available music generation provider. Configure MiniMax or another music adapter.");
  }

  const generatedDir = path.join(ctx.dataDir, "generated");
  const submitCtx = { dataDir: ctx.dataDir, bus: ctx.bus, log: ctx.log, generatedDir, config, providerId: providerId || adapter.id, mediaType: "music" };
  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const params = {
    type: "music",
    prompt: input.prompt,
    provider: providerId || adapter.id,
    providerId: providerId || adapter.id,
    ...(input.lyrics && { lyrics: input.lyrics }),
    ...(input.duration != null && { duration: input.duration }),
    ...(input.genre && { genre: input.genre }),
    ...(input.style && { style: input.style }),
    ...(input.instrumental != null && { instrumental: input.instrumental }),
    ...(input.format && { format: input.format }),
    ...(input.output_format && { output_format: input.output_format }),
    ...(input.sample_rate != null && { sample_rate: input.sample_rate }),
    ...(input.bitrate != null && { bitrate: input.bitrate }),
    ...(input.channel != null && { channel: input.channel }),
    ...((input.model || modelId) && { model: input.model || modelId }),
  };

  const preflightError = await runAdapterPreflight(adapter, submitCtx, "music");
  if (preflightError) return preflightError;

  let result;
  try {
    result = await adapter.submit(params, submitCtx);
  } catch (err) {
    return taskFailure("music", `Music submission failed: ${err?.message || "unknown error"}`);
  }

  if (!result?.taskId) {
    return taskFailure("music", "Music submission failed: missing task id.");
  }

  const deliveryTarget = bridgeDeliveryTarget(ctx);
  const deferredMeta = {
    type: "music-generation",
    prompt: input.prompt,
    ...(deliveryTarget ? { deliveryTarget } : {}),
  };

  store.add({
    taskId: result.taskId,
    adapterId: adapter.id,
    batchId,
    type: "music",
    prompt: input.prompt,
    params,
    sessionPath: ctx.sessionPath,
    ...(deliveryTarget ? { deliveryTarget } : {}),
  });
  if (result.files?.length) store.update(result.taskId, { files: result.files });

  try {
    await ctx.bus.request("deferred:register", {
      taskId: result.taskId,
      sessionPath: ctx.sessionPath,
      meta: deferredMeta,
    });
  } catch (err) {
    ctx.log.warn(`deferred:register failed for ${result.taskId}:`, err);
  }

  try {
    await ctx.bus.request("task:register", {
      taskId: result.taskId,
      type: "media-generation",
      parentSessionPath: ctx.sessionPath,
      meta: deferredMeta,
    });
  } catch {}

  poller.add(result.taskId);

  return {
    content: [{ type: "text", text: "Submitted music generation task. The card below will update when complete." }],
    details: {
      card: {
        type: "iframe",
        route: `/audio-card?batch=${batchId}`,
        title: "Music Generation",
        description: input.prompt.slice(0, 60),
        aspectRatio: "4:1",
      },
    },
  };
}
