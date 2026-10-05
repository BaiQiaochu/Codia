// @ts-nocheck
/**
 * plugins/image-gen/tools/generate-video.js
 *
 * Non-blocking video generation through the unified media generation plugin.
 */
import path from "node:path";
import { mediaError, missingModel, runAdapterPreflight, taskFailure } from "../lib/preflight.ts";
import { createScopedConfigAccessor } from "../lib/scoped-config.ts";
import { resolveMediaAdapter } from "../lib/resolve-media-adapter.ts";
import { bridgeDeliveryTarget } from "../lib/bridge-delivery-target.ts";
import { isResponseDelivery, normalizeMediaDelivery, normalizeSessionRef } from "../lib/image-task-runner.ts";
import { resolveMediaParameters } from "../../../core/media/media-parameters.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "generate-video";
export const description = t("toolDef.generateVideo.description");
export const promptSnippet =
  "When the user asks to generate a provider-model video or animate a reference image, call image-gen_generate-video directly without requiring a slash command.";
export const promptGuidelines =
  "Use image-gen_generate-video for natural short video requests, image-to-video requests, and provider video model tasks.";

export const parameters = {
  type: "object",
  properties: {
    prompt: { type: "string", description: t("toolDef.generateVideo.promptDesc") },
    image: { type: "string", description: t("toolDef.generateVideo.imageDesc") },
    images: {
      type: "array",
      items: { type: "string" },
      description: "Optional ordered reference images for image-to-video",
    },
    duration: { type: "number", description: t("toolDef.generateVideo.durationDesc") },
    ratio: { type: "string", description: t("toolDef.generateVideo.ratioDesc") },
    aspect_ratio: { type: "string", description: "Alias for ratio" },
    generateAudio: { type: "boolean", description: "Whether the provider should generate audio when supported" },
    generate_audio: { type: "boolean", description: "Alias for generateAudio" },
    audio: { type: "boolean", description: "Alias for provider audio generation options" },
    watermark: { type: "boolean", description: "Whether to include provider watermark when supported" },
    resolution: { type: "string", description: "Provider-specific output resolution, e.g. 720p or 1080p" },
    action: { type: "string", description: "Provider-specific video action, e.g. image-to-video" },
    negative_prompt: { type: "string", description: "Provider-specific negative prompt" },
    negativePrompt: { type: "string", description: "Alias for negative_prompt" },
    prompt_extend: { type: "boolean", description: "Provider-specific prompt expansion flag" },
    promptExtend: { type: "boolean", description: "Alias for prompt_extend" },
    shot_type: { type: "string", description: "Provider-specific camera or shot mode" },
    shotType: { type: "string", description: "Alias for shot_type" },
    reference_urls: {
      type: "array",
      items: { type: "string" },
      description: "Provider-specific reference video or image URLs",
    },
    referenceUrls: {
      type: "array",
      items: { type: "string" },
      description: "Alias for reference_urls",
    },
    seed: { type: "number", description: "Provider-specific deterministic seed" },
    model: { type: "string", description: t("toolDef.generateVideo.modelDesc") },
    provider: { type: "string", description: t("toolDef.generateVideo.providerDesc") },
    mode: { type: "string", description: "Generation mode such as text2video, image2video, or multiframe2video" },
    options: {
      type: "object",
      description: "Provider-specific optional generation parameters. Use media option discovery before filling uncommon keys.",
      additionalProperties: true,
    },
  },
  required: ["prompt"],
};

function adapterForProvider(registry, providerId) {
  const direct = registry.get(providerId);
  if (direct?.types?.includes("video")) return direct;
  if (providerId === "volcengine" || providerId === "volcengine-coding") {
    const volcengineVideo = registry.get("volcengine-video");
    if (volcengineVideo?.types?.includes("video")) return volcengineVideo;
  }
  return null;
}

function normalizeReferenceImages(input) {
  const refs = [];
  const seen = new Set();
  const add = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    const ref = String(value).trim();
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  add(input.images);
  add(input.image);
  return refs;
}

export async function execute(input, ctx) {
  const { registry, store, poller } = ctx._mediaGen || {};
  if (!registry || !store || !poller) {
    return mediaError("video", "not_initialized", t("toolDef.generateVideo.notInitialized"));
  }

  const prompt = String(input.prompt || "").trim();
  if (!prompt) {
    return { content: [{ type: "text", text: t("toolDef.generateVideo.promptRequired") }] };
  }

  const sessionTarget = normalizeSessionRef(ctx);
  const { sessionId, sessionPath, sessionRef } = sessionTarget;
  const delivery = normalizeMediaDelivery(input);
  const responseDelivery = isResponseDelivery(delivery);
  if (!sessionId && !sessionPath && !responseDelivery) {
    return mediaError("video", "missing_session_path", t("plugin.imageGen.noSessionPath"));
  }

  const generatedDir = path.join(ctx.dataDir, "generated");
  const config = createScopedConfigAccessor(ctx, ctx.agentId || null);
  const defaultVideoModel = config.get("defaultVideoModel");
  const { adapter, providerId, modelId, model: resolvedModel } = await resolveMediaAdapter({
    registry,
    bus: ctx.bus,
    type: "video",
    inputProvider: input.provider,
    inputModel: input.model,
    defaultModel: defaultVideoModel,
    adapterForProvider,
  });
  if (!adapter) {
    return missingModel("video", t("toolDef.generateVideo.noProvider"));
  }

  const aspectRatio = input.aspect_ratio || input.aspectRatio || input.ratio || null;
  const selectedProviderId = providerId || adapter.id;
  const selectedModelId = input.model
    || modelId
    || (defaultVideoModel?.provider === selectedProviderId ? defaultVideoModel.id : null);
  const referenceImages = normalizeReferenceImages(input);
  const batchId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let parameterResolution;
  try {
    const providerDefaults = config.get("providerDefaults")?.[selectedProviderId] || {};
    parameterResolution = resolveMediaParameters({
      kind: "video",
      input: {
        ...input,
        ...(selectedModelId ? { model: selectedModelId } : {}),
      },
      providerId: selectedProviderId,
      model: resolvedModel,
      providerDefaults,
    });
  } catch (err) {
    return mediaError("video", "invalid_parameters", err?.message || String(err));
  }
  const params = {
    ...parameterResolution.resolvedParameters,
    type: "video",
    prompt,
    provider: selectedProviderId,
    providerId: selectedProviderId,
    mode: parameterResolution.modeId,
    resolvedParameters: parameterResolution.resolvedParameters,
    ...(referenceImages.length === 1 && { image: referenceImages[0] }),
    ...(referenceImages.length > 1 && { images: referenceImages }),
    ...(input.duration != null && { duration: input.duration }),
    ...(aspectRatio && { ratio: aspectRatio, aspect_ratio: aspectRatio }),
    ...(input.generateAudio != null && { generateAudio: input.generateAudio, generate_audio: input.generateAudio }),
    ...(input.generate_audio != null && { generateAudio: input.generate_audio, generate_audio: input.generate_audio }),
    ...(input.audio != null && { audio: input.audio }),
    ...(input.watermark != null && { watermark: input.watermark }),
    ...(input.resolution && { resolution: input.resolution }),
    ...(input.action && { action: input.action }),
    ...((input.negative_prompt || input.negativePrompt) && { negative_prompt: input.negative_prompt || input.negativePrompt }),
    ...(input.prompt_extend != null && { prompt_extend: input.prompt_extend }),
    ...(input.promptExtend != null && { prompt_extend: input.promptExtend }),
    ...((input.shot_type || input.shotType) && { shot_type: input.shot_type || input.shotType }),
    ...(input.reference_urls && { reference_urls: input.reference_urls }),
    ...(input.referenceUrls && { reference_urls: input.referenceUrls }),
    ...(input.seed != null && { seed: input.seed }),
    ...(selectedModelId && { model: selectedModelId }),
  };
  const submitCtx = { dataDir: ctx.dataDir, bus: ctx.bus, log: ctx.log, generatedDir, config, providerId: selectedProviderId, mediaType: "video" };

  const preflightError = await runAdapterPreflight(adapter, submitCtx, "video");
  if (preflightError) return preflightError;

  let result;
  try {
    result = await adapter.submit(params, submitCtx);
  } catch (err) {
    return taskFailure("video", t("toolDef.generateVideo.submitFailed", {
      error: err?.message || t("plugin.imageGen.unknownError"),
    }));
  }

  if (!result?.taskId) {
    return taskFailure("video", t("toolDef.generateVideo.missingTaskId"));
  }

  const deliveryTarget = responseDelivery ? null : bridgeDeliveryTarget(ctx);
  const deferredMeta = {
    type: "video-generation",
    prompt,
    ...(deliveryTarget ? { deliveryTarget } : {}),
  };

  store.add({
    taskId: result.taskId,
    adapterId: adapter.id,
    batchId,
    type: "video",
    prompt,
    params,
    sessionId,
    sessionPath,
    sessionRef,
    deliveryMode: delivery.mode,
    delivery,
    ...(deliveryTarget ? { deliveryTarget } : {}),
  });

  if (result.files?.length) store.update(result.taskId, { files: result.files });

  if (!responseDelivery) {
    try {
      await ctx.bus.request("deferred:register", {
        taskId: result.taskId,
        sessionId,
        sessionPath,
        sessionRef,
        meta: deferredMeta,
      });
    } catch (err) {
      ctx.log.warn(`deferred:register failed for ${result.taskId}:`, err);
    }

    try {
      await ctx.bus.request("task:register", {
        taskId: result.taskId,
        type: "media-generation",
        sessionId,
        sessionRef,
        parentSessionPath: sessionPath,
        meta: deferredMeta,
      });
    } catch {}
  }

  poller.add(result.taskId);

  return {
    content: [{ type: "text", text: t("toolDef.generateVideo.submitted") }],
    details: {
      mediaGeneration: {
        kind: "video",
        batchId,
        prompt,
        delivery,
        tasks: [{ taskId: result.taskId }],
      },
      card: {
        type: "iframe",
        route: `/video-card?batch=${batchId}`,
        title: t("toolDef.generateVideo.cardTitle"),
        description: prompt.slice(0, 60),
        aspectRatio: aspectRatio || "16:9",
      },
    },
  };
}
