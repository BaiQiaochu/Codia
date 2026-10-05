// @ts-nocheck
import { t } from "../../../lib/i18n.ts";

export const name = "generate-video";
export const description = t("toolDef.generateVideo.description");
export const promptSnippet =
  "When the user asks to generate a provider-model video or animate a reference image, call media_generate-video directly without requiring a slash command.";
export const promptGuidelines =
  "Use media_generate-video for natural short video requests, image-to-video requests, and provider video model tasks.";

const sessionFileReference = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["session_file"] },
    fileId: { type: "string" },
  },
  required: ["kind", "fileId"],
  additionalProperties: true,
};

export const parameters = {
  type: "object",
  properties: {
    prompt: { type: "string", description: t("toolDef.generateVideo.promptDesc") },
    image: {
      ...sessionFileReference,
      description: "Reference image for image-to-video from the current session, for example { kind: \"session_file\", fileId }.",
    },
    duration: { type: "number", description: t("toolDef.generateVideo.durationDesc") },
    ratio: { type: "string", description: t("toolDef.generateVideo.ratioDesc") },
    resolution: { type: "string", description: "Optional video resolution or provider-specific resolution tier." },
    mode: { type: "string", description: "Optional provider mode such as text2video or image2video." },
    model: { type: "string", description: t("toolDef.generateVideo.modelDesc") },
    provider: { type: "string", description: t("toolDef.generateVideo.providerDesc") },
    options: {
      type: "object",
      description: "Provider-specific optional generation parameters. Use media option discovery before filling uncommon keys.",
      additionalProperties: true,
    },
  },
  required: ["prompt"],
};

function present(value) {
  return value !== undefined && value !== null && value !== "";
}

function mediaInput(input: any = {}) {
  return {
    prompt: input.prompt,
    ...(present(input.image) ? { image: input.image } : {}),
    ...(present(input.duration) ? { duration: input.duration } : {}),
    ...(present(input.ratio) ? { ratio: input.ratio } : {}),
    ...(present(input.resolution) ? { resolution: input.resolution } : {}),
    ...(present(input.mode) ? { mode: input.mode } : {}),
    ...(present(input.model) ? { model: input.model } : {}),
    ...(present(input.provider) ? { provider: input.provider } : {}),
    ...(input.options && typeof input.options === "object" && !Array.isArray(input.options) ? { options: input.options } : {}),
  };
}

function sessionPayload(ctx: any = {}, input) {
  return {
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.sessionPath ? { sessionPath: ctx.sessionPath } : {}),
    ...(ctx.sessionRef ? { sessionRef: ctx.sessionRef } : {}),
    input,
    ...(ctx.bridgeContext ? { bridgeContext: ctx.bridgeContext } : {}),
    pluginId: ctx.pluginId || "media",
  };
}

export async function execute(input: any = {}, ctx: any = {}) {
  if (typeof ctx?.bus?.request !== "function") {
    return { content: [{ type: "text", text: t("toolDef.generateVideo.notInitialized") }] };
  }

  let result;
  try {
    result = await ctx.bus.request("media:generate-video", sessionPayload(ctx, mediaInput(input)));
  } catch (err) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailed", { error: err?.message || t("plugin.imageGen.unknownError") }) }],
    };
  }

  const tasks = Array.isArray(result?.tasks)
    ? result.tasks.filter((task) => task && typeof task.taskId === "string" && task.taskId)
    : [];
  if (!result?.ok || tasks.length === 0) {
    return {
      content: [{ type: "text", text: t("toolDef.generateVideo.submitFailedUnknown") }],
    };
  }

  return {
    content: [{ type: "text", text: t("toolDef.generateVideo.submitted") }],
    details: {
      mediaGeneration: {
        kind: "video",
        batchId: result.batchId,
        prompt: result.prompt || input.prompt,
        delivery: result.delivery,
        tasks,
      },
    },
  };
}
