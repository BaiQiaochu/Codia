// @ts-nocheck
/**
 * plugins/image-gen/tools/generate-image.js
 *
 * Non-blocking image generation. Registers a local task immediately, then
 * submits to the provider in the background. Completion is delivered through
 * Poller + DeferredResultStore.
 */
import { mediaError, missingModel, runAdapterPreflight } from "../lib/preflight.ts";
import { createScopedConfigAccessor } from "../lib/scoped-config.ts";
import {
  bridgeDeliveryTarget,
  buildImageParams,
  createSubmitContext,
  createTaskId,
  imageDeferredMeta,
  isResponseDelivery,
  normalizeSessionPath,
  normalizeMediaDelivery,
  resolveImageTarget,
  runSubmitInBackground,
} from "../lib/image-task-runner.ts";
import { resolveMediaParameters } from "../../../core/media/media-parameters.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "generate-image";
export const description = t("toolDef.generateImage.description");
export const promptSnippet =
  "When the user asks to draw, create, generate, or edit an image, call image-gen_generate-image directly without requiring a slash command.";
export const promptGuidelines =
  "Use image-gen_generate-image for natural image creation requests such as draw, paint, create an illustration, make a poster, generate a logo, edit this image, or create variations from reference images. Do not call it for image analysis or for video generation.";

export const parameters = {
  type: "object",
  properties: {
    prompt: { type: "string", description: t("toolDef.generateImage.promptDesc") },
    count: { type: "number", description: t("toolDef.generateImage.countDesc") },
    image: { type: "string", description: t("toolDef.generateImage.imageDesc") },
    images: {
      type: "array",
      items: { type: "string" },
      description: "Ordered reference image paths or URLs for image-to-image; supports multiple images",
    },
    referenceImages: {
      type: "array",
      items: { type: "string" },
      description: "Ordered reference image paths or URLs for image-to-image; supports multiple images",
    },
    ratio: { type: "string", description: t("toolDef.generateImage.ratioDesc") },
    aspect_ratio: { type: "string", description: "Alias for ratio" },
    resolution: { type: "string", description: t("toolDef.generateImage.resolutionDesc") },
    size: { type: "string", description: "Provider size value, e.g. 1024x1024, landscape, square, portrait, 2K, 4K" },
    quality: { type: "string", description: t("toolDef.generateImage.qualityDesc") },
    model: { type: "string", description: t("toolDef.generateImage.modelDesc") },
    provider: { type: "string", description: t("toolDef.generateImage.providerDesc") },
    mode: { type: "string", description: "Generation mode such as text2image or image2image" },
    options: {
      type: "object",
      description: "Provider-specific optional generation parameters. Use media option discovery before filling uncommon keys.",
      additionalProperties: true,
    },
    suggestedFilename: { type: "string", description: t("toolDef.generateImage.suggestedFilenameDesc") },
  },
  required: ["prompt"],
};

export async function execute(input, ctx) {
  const { registry, store, poller } = ctx._mediaGen || {};
  if (!registry || !store || !poller) {
    return mediaError("image", "not_initialized", t("plugin.imageGen.notInitialized"));
  }

  const sessionPath = normalizeSessionPath(ctx);
  const delivery = normalizeMediaDelivery(input);
  const responseDelivery = isResponseDelivery(delivery);
  if (!sessionPath && !responseDelivery) {
    return mediaError("image", "missing_session_path", t("plugin.imageGen.noSessionPath"));
  }

  const config = createScopedConfigAccessor(ctx, ctx.agentId || null);
  const submitCtx = createSubmitContext({ ...ctx, config });

  let target;
  try {
    target = await resolveImageTarget(input, registry, submitCtx);
  } catch (err) {
    return missingModel("image", t("plugin.imageGen.noProvider"));
  }

  const adapter = target?.adapter || null;
  if (!adapter) {
    return missingModel("image", t("plugin.imageGen.noProvider"));
  }

  const preflightError = await runAdapterPreflight(adapter, submitCtx, "image");
  if (preflightError) return preflightError;

  const count = Math.min(Math.max(input.count || 1, 1), 4);
  const batchId = createTaskId();
  const providerDefaults = submitCtx.config?.get?.("providerDefaults")?.[target.providerId] || {};
  let parameterResolution;
  try {
    parameterResolution = resolveMediaParameters({
      kind: "image",
      input,
      providerId: target.providerId,
      model: target.model,
      providerDefaults,
    });
  } catch (err) {
    return mediaError("image", "invalid_parameters", err?.message || String(err));
  }
  const params = {
    ...parameterResolution.resolvedParameters,
    ...buildImageParams(input),
    mode: parameterResolution.modeId,
    resolvedParameters: parameterResolution.resolvedParameters,
    providerId: target.providerId,
    ...(target.modelId ? { modelId: target.modelId, model: target.modelId } : {}),
    ...(target.protocolId ? { protocolId: target.protocolId } : {}),
    ...(target.credentialLaneId ? { credentialLaneId: target.credentialLaneId } : {}),
    ...(target.credentialProviderId ? { credentialProviderId: target.credentialProviderId } : {}),
  };

  const submitted = [];
  const deliveryTarget = responseDelivery ? null : bridgeDeliveryTarget(ctx);
  const deferredMeta = imageDeferredMeta({ prompt: input.prompt, deliveryTarget });

  for (let i = 0; i < count; i++) {
    const taskId = createTaskId();
    store.add({
      taskId,
      adapterId: adapter.id,
      providerId: target.providerId,
      modelId: target.modelId,
      protocolId: target.protocolId,
      credentialLaneId: target.credentialLaneId,
      batchId,
      type: "image",
      prompt: input.prompt,
      params,
      sessionPath,
      deliveryMode: delivery.mode,
      delivery,
      ...(deliveryTarget ? { deliveryTarget } : {}),
      submitState: "submitting",
      adapterTaskId: null,
    });

    if (!responseDelivery) {
      try {
        await ctx.bus.request("deferred:register", {
          taskId,
          sessionPath,
          meta: deferredMeta,
        });
      } catch (err) {
        ctx.log.warn(`deferred:register failed for ${taskId}:`, err);
      }

      try {
        await ctx.bus.request("task:register", {
          taskId,
          type: "media-generation",
          parentSessionPath: sessionPath,
          meta: deferredMeta,
        });
      } catch {
        // TaskRegistry is best-effort visibility; generation delivery still uses deferred results.
      }
    }

    poller.add(taskId);
    submitted.push({ taskId });

    void runSubmitInBackground({
      taskId,
      adapter,
      params,
      submitCtx,
      store,
      poller,
      ctx: { ...ctx, config },
    });
  }

  const aspectRatio = input.aspect_ratio || input.aspectRatio || input.ratio || "1:1";
  return {
    content: [{ type: "text", text: t("toolDef.generateImage.submitted", { count: submitted.length }) }],
    details: {
      mediaGeneration: {
        kind: "image",
        batchId,
        prompt: input.prompt,
        delivery,
        tasks: submitted,
      },
      card: {
        type: "iframe",
        route: `/card?batch=${batchId}`,
        title: t("toolDef.generateImage.cardTitle"),
        description: `${input.prompt.slice(0, 60)} (${submitted.length})`,
        aspectRatio,
      },
    },
  };
}
