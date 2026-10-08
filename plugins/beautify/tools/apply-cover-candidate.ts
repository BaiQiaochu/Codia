// @ts-nocheck
import path from "node:path";
import { applyMarkdownCoverFromGeneratedFile } from "../lib/markdown-cover-service.ts";
import { isBeautifyEnabledForAgentConfig } from "../lib/availability.ts";
import { t } from "../../../lib/i18n.ts";

export const name = "apply-cover-candidate";
export const description = t("toolDef.applyCoverCandidate.description");

export { isBeautifyEnabledForAgentConfig as isEnabledForAgentConfig };

export const parameters = {
  type: "object",
  properties: {
    targetFilePath: { type: "string", description: t("toolDef.applyCoverCandidate.targetFilePathDesc") },
    generatedFilePath: { type: "string", description: t("toolDef.applyCoverCandidate.generatedFilePathDesc") },
    pixelWidth: { type: "number", description: t("toolDef.applyCoverCandidate.pixelWidthDesc") },
    pixelHeight: { type: "number", description: t("toolDef.applyCoverCandidate.pixelHeightDesc") },
  },
  required: ["targetFilePath", "generatedFilePath"],
};

export async function execute(input) {
  if (!input.targetFilePath || !path.isAbsolute(input.targetFilePath)) {
    return { content: [{ type: "text", text: t("toolDef.applyCoverCandidate.targetFilePathRequired") }] };
  }
  if (!input.generatedFilePath || !path.isAbsolute(input.generatedFilePath)) {
    return { content: [{ type: "text", text: t("toolDef.applyCoverCandidate.generatedFilePathRequired") }] };
  }

  try {
    const result = await applyMarkdownCoverFromGeneratedFile({
      markdownFilePath: input.targetFilePath,
      generatedFilePath: input.generatedFilePath,
      pixelWidth: input.pixelWidth,
      pixelHeight: input.pixelHeight,
    });
    return {
      content: [{ type: "text", text: t("toolDef.applyCoverCandidate.applied") }],
      details: { beautifyCover: result },
    };
  } catch (err) {
    return { content: [{ type: "text", text: t("toolDef.applyCoverCandidate.failed", { error: err?.message || err }) }] };
  }
}
