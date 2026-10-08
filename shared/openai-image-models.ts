export const OPENAI_IMAGE_MODELS = Object.freeze([
  { id: "gpt-image-1", name: "GPT Image 1" },
  { id: "gpt-image-1-mini", name: "GPT Image 1 Mini" },
  { id: "gpt-image-1.5", name: "GPT Image 1.5" },
  { id: "gpt-image-2", name: "GPT Image 2" },
  { id: "gpt-image-2-2026-04-21", name: "GPT Image 2 (2026-04-21)" },
  { id: "gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst" },
  { id: "gpt-image-2.5-sunburst-2026-09-08", name: "GPT Image 2.5 Sunburst (2026-09-08)" },
  { id: "gpt-image-2.5-flare", name: "GPT Image 2.5 Flare" },
  { id: "gpt-image-2.5-flare-2026-09-08", name: "GPT Image 2.5 Flare (2026-09-08)" },
  { id: "chatgpt-image-latest", name: "ChatGPT Image Latest" },
]);

export function isOpenAIImageModelId(modelId: unknown) {
  const id = String(modelId || "").trim().toLowerCase();
  return id.startsWith("gpt-image-")
    || id === "chatgpt-image-latest"
    || id.startsWith("dall-e-");
}
