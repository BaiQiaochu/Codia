import {
  KNOWN_IMAGE_MODELS,
  resolveKnownModelId,
} from "./provider-utils.ts";

export const MODEL_CATALOG = Object.fromEntries(
  Object.entries(KNOWN_IMAGE_MODELS).map(([providerId, models]) => [
    providerId,
    models.map((model) => ({
      id: model.id,
      name: model.name || model.id,
      ...(model.aliases ? { aliases: model.aliases } : {}),
      ...(model.default ? { default: true } : {}),
    })),
  ]),
);

const IMAGE_MODEL_ALIASES = {
  volcengine: {
    "3.0": "doubao-seedream-3-0-t2i",
    "4.0": "doubao-seedream-4-0-250828",
    "4.5": "doubao-seedream-4-5-251128",
    "5.0": "doubao-seedream-5-0",
    "5.0-pro": "doubao-seedream-5-0-pro",
    "5.0-lite": "doubao-seedream-5-0-lite-260128",
  },
  openai: {
    "1": "gpt-image-1",
    "1.5": "gpt-image-1.5",
    "1-mini": "gpt-image-1-mini",
    mini: "gpt-image-1-mini",
    "2": "gpt-image-2",
    dalle3: "dall-e-3",
    "dall-e-3": "dall-e-3",
  },
  "openai-codex-oauth": {
    "2": "gpt-image-2",
  },
};

function getDefaultEntry(catalog) {
  return catalog.find((entry) => entry.default) || catalog[catalog.length - 1];
}

export function resolveModelId(provider, raw) {
  const resolved = resolveKnownModelId(provider, raw, "image");
  if (resolved) return resolved;

  const catalog = MODEL_CATALOG[provider] || [];
  if (!catalog.length) return raw || "";

  const alias = String(raw || "").trim().toLowerCase();
  const aliasId = IMAGE_MODEL_ALIASES[provider]?.[alias];
  if (aliasId) return aliasId;

  return getDefaultEntry(catalog).id;
}

export function getKnownModels(provider) {
  return (MODEL_CATALOG[provider] || []).map(({ id, name }) => ({ id, name }));
}

export function getDefaultModelId(provider) {
  const catalog = MODEL_CATALOG[provider] || [];
  return catalog.length ? getDefaultEntry(catalog).id : null;
}
