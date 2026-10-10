export const OPENAI_IMAGE_MODELS = Object.freeze([
  { id: "gpt-image-1", name: "GPT Image 1", aliases: ["1"] },
  { id: "gpt-image-1-mini", name: "GPT Image 1 Mini", aliases: ["1-mini", "mini"] },
  { id: "gpt-image-1.5", name: "GPT Image 1.5", aliases: ["1.5"] },
  { id: "gpt-image-2", name: "GPT Image 2", aliases: ["2", "image-2"] },
  { id: "gpt-image-2-2026-04-21", name: "GPT Image 2 (2026-04-21)" },
  { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", aliases: ["2.5", "2.5-sunburst", "sunburst"] },
  { id: "gpt-image-2.5-sunburst-2026-09-08", name: "GPT Image 2.5 Sunburst (2026-09-08)" },
  { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", aliases: ["2.5-flare", "flare"] },
  { id: "gpt-image-2.5-flare-2026-09-08", name: "GPT Image 2.5 Flare (2026-09-08)" },
  { id: "chatgpt-image-latest", name: "ChatGPT Image Latest", aliases: ["latest"] },
]);

function bareModelId(modelId: unknown) {
  return String(modelId || "").trim().toLowerCase().split("/").pop() || "";
}

export function isGptImageModelId(modelId: unknown) {
  return bareModelId(modelId).startsWith("gpt-image-");
}

export function supportsFlexibleOpenAIImageSize(modelId: unknown) {
  const id = bareModelId(modelId);
  if (id.startsWith("chatgpt-image-")) return true;
  const match = id.match(/^gpt-image-(\d+(?:\.\d+)?)(?:-|$)/);
  return match ? Number(match[1]) >= 2 : false;
}

export function isOpenAIImageModelId(modelId: unknown) {
  const id = bareModelId(modelId);
  return isGptImageModelId(id)
    || id.startsWith("chatgpt-image-")
    || id.startsWith("dall-e-");
}
