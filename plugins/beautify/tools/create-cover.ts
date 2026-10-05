// @ts-nocheck
import path from "node:path";
import { applyMarkdownCoverFromGeneratedFile } from "../lib/markdown-cover-service.ts";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "create-cover";
export const description = t("toolDef.createCover.description");

export const promptGuidelines = [
  "Use beautify_create-cover only after an image already exists on disk.",
  "The image may come from image-gen, a built-in cover asset, or a user-selected local image.",
  "This tool does not read the article to design prompts, does not call any language model, and does not generate images.",
  "When the user asks to create/generate/replace/improve a Markdown cover from chat, first call beautify_get-cover-style-guide and read the target Markdown file before writing the image prompt.",
  "For a new Markdown cover, write the image prompt yourself using the style guide, call media_generate-image with ratio 3:2, then call check_pending_tasks once to inspect whether a generated SessionFile is already available.",
  "After image generation resolves, pass the generated SessionFile filePath as generatedFilePath and the Markdown path as targetFilePath.",
  "If the target Markdown file path is not explicit and cannot be inferred from attached file metadata, ask the user to confirm the path before calling this tool.",
  "When called from an editor button, the file path is explicit; use it directly.",
  "For follow-up requests like 再生成一张 or 调整方向, call media_generate-image again first, then call this tool with the new generated image path.",
].join("\n");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const parameters = {
  type: "object",
  properties: {
    targetFilePath: { type: "string", description: t("toolDef.createCover.targetFilePathDesc") },
    filePath: { type: "string", description: t("toolDef.createCover.filePathDesc") },
    generatedFilePath: { type: "string", description: t("toolDef.createCover.generatedFilePathDesc") },
    imageFilePath: { type: "string", description: t("toolDef.createCover.imageFilePathDesc") },
    pixelWidth: { type: "number", description: t("toolDef.createCover.pixelWidthDesc") },
    pixelHeight: { type: "number", description: t("toolDef.createCover.pixelHeightDesc") },
  },
  required: ["targetFilePath", "generatedFilePath"],
};

function resolveTargetFilePath(input) {
  return input.targetFilePath || input.filePath || input.target?.filePath || null;
}

function resolveGeneratedFilePath(input) {
  return input.generatedFilePath || input.imageFilePath || input.generated?.filePath || input.sessionFile?.filePath || null;
}

function textResult(text, details = undefined) {
  return {
    content: [{ type: "text", text }],
    ...(details ? { details } : {}),
  };
}

function emitMarkdownCoverUpdated(ctx, filePath) {
  try {
    ctx?.bus?.emit?.({
      type: "app_event",
      event: {
        type: "markdown-cover-updated",
        payload: { filePath },
        source: "server",
      },
    }, null);
  } catch (err) {
    ctx?.log?.warn?.(`markdown cover refresh event failed: ${err?.message || err}`);
  }
}

export async function execute(input, ctx) {
  const targetFilePath = resolveTargetFilePath(input);
  if (!targetFilePath || !path.isAbsolute(targetFilePath)) {
    return textResult(t("toolDef.createCover.targetFilePathRequired"));
  }
  if (path.extname(targetFilePath).toLowerCase() !== ".md") {
    return textResult(t("toolDef.createCover.mustBeMarkdown"));
  }

  const generatedFilePath = resolveGeneratedFilePath(input);
  if (!generatedFilePath || !path.isAbsolute(generatedFilePath)) {
    return textResult(t("toolDef.createCover.generatedFilePathRequired"));
  }

  try {
    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: targetFilePath,
      generatedFilePath,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
    });
    emitMarkdownCoverUpdated(ctx, targetFilePath);
    return textResult(t("toolDef.createCover.applied"), {
      beautifyCover: result,
    });
  } catch (err) {
    return textResult(t("toolDef.createCover.failed", { error: err?.message || err }));
  }
}
