// @ts-nocheck
import path from "node:path";
import { MindMapStore } from "../lib/mind-map-store.ts";
import {
  collectExplicitMindmapInput,
  generateMindmapFromDocument,
  resolveMindMapOutputDir,
  sanitizeXmindName,
  uniqueFileName,
} from "../lib/mind-map-operations.ts";

export const name = "build-mind-map";
export const description =
  "Create a local XMind mind map from explicitly provided text, documents, or a file path, then return an editable preview card.";
export const promptSnippet =
  "Use mind-map_build-mind-map only when the user explicitly asks to create a mind map from provided text, documents, or the current file path. Do not infer or read other session history.";

export const parameters = {
  type: "object",
  properties: {
    text: { type: "string", description: "Explicit text to convert into a mind map." },
    documents: {
      type: "array",
      description: "Explicit document payloads to convert. Each item may be a string or {title,text}.",
      items: {
        oneOf: [
          { type: "string" },
          {
            type: "object",
            properties: {
              title: { type: "string" },
              text: { type: "string" },
            },
            required: ["text"],
          },
        ],
      },
    },
    filePath: { type: "string", description: "Explicit local file path to read and convert." },
    title: { type: "string", description: "Mind map title." },
    outputDir: { type: "string", description: "Optional directory for the generated .xmind file." },
    name: { type: "string", description: "Optional output file name." },
  },
  required: [],
};

function ensureStore(ctx) {
  if (ctx._mindMap?.store) return ctx._mindMap.store;
  const store = new MindMapStore(ctx.dataDir);
  ctx._mindMap = { ...(ctx._mindMap || {}), store };
  return store;
}

export async function execute(input, ctx) {
  const explicit = await collectExplicitMindmapInput(input);
  if (!explicit) {
    return {
      content: [{ type: "text", text: "Please provide explicit text, documents, or filePath to build a mind map." }],
    };
  }

  const store = ensureStore(ctx);
  const outputDir = resolveMindMapOutputDir(input, ctx, { fallbackSubdir: "generated" });
  const sourceBase = explicit.sourcePath
    ? path.basename(explicit.sourcePath)
    : String(input?.name || explicit.title || "Mind Map");
  const fileName = uniqueFileName(outputDir, sanitizeXmindName(input?.name || sourceBase));
  const filePath = path.join(outputDir, fileName);
  const root = await generateMindmapFromDocument(ctx, explicit.title, explicit.text, { log: ctx.log });
  store.createFromTree(filePath, root);

  return {
    content: [{
      type: "text",
      text: `Created mind map: ${fileName}`,
    }],
    details: {
      card: {
        type: "iframe",
        route: `/card?path=${encodeURIComponent(filePath)}`,
        title: "Mind Map",
        description: fileName,
        aspectRatio: "16:10",
        pluginId: "mind-map",
      },
      mindMap: {
        filePath,
        fileName,
        title: root.title,
      },
    },
  };
}