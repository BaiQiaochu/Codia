import path from "path";
import YAML from "js-yaml";
import { atomicWriteSync, safeReadYAMLSync } from "../shared/safe-fs.ts";
import { lookupKnown } from "../shared/known-models.ts";
import { inferMediaProtocolId } from "./media-protocols.ts";

type AnyRecord = Record<string, any>;

function isPlainObject(value: unknown): value is AnyRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function modelId(model: unknown) {
  return isPlainObject(model) ? model.id : model;
}

function modelType(providerId: string, model: unknown) {
  if (!isPlainObject(model)) return lookupKnown(providerId, model)?.type || "chat";
  return model.type || lookupKnown(providerId, model.id)?.type || "chat";
}

export function inferImageProtocolId(providerId: string, modelId: unknown): string {
  return inferMediaProtocolId(providerId, "image_generation", modelId);
}

function normalizeMediaModelEntry(providerId: string, model: unknown): AnyRecord | null {
  const id = isPlainObject(model) ? (typeof model.id === "string" ? model.id.trim() : "") : String(model || "").trim();
  if (!id) return null;
  if (!isPlainObject(model)) {
    const next: AnyRecord = { id };
    const protocolId = inferImageProtocolId(providerId, id);
    if (protocolId) next.protocolId = protocolId;
    return next;
  }
  const { type: _type, display_name: displayName, ...rest } = model;
  const next: AnyRecord = { ...rest, id };
  if (displayName !== undefined && next.displayName === undefined && next.name === undefined) {
    next.name = displayName;
  }
  if (!next.protocolId && !next.protocol_id) {
    const protocolId = inferImageProtocolId(providerId, id);
    if (protocolId) next.protocolId = protocolId;
  }
  return next;
}

function appendUniqueMediaModels(existing: unknown, additions: AnyRecord[]) {
  const result = Array.isArray(existing) ? [...existing] : [];
  const seen = new Set(result.map(modelId).filter(Boolean));
  let changed = false;
  for (const model of additions) {
    const id = modelId(model);
    if (!id || seen.has(id)) continue;
    result.push(model);
    seen.add(id);
    changed = true;
  }
  return { models: result, changed };
}

export function normalizeProviderMediaConfigMap(rawProviders: unknown) {
  if (!isPlainObject(rawProviders)) return { providers: {}, changed: false };
  const providers: AnyRecord = {};
  let changed = false;

  for (const [providerId, config] of Object.entries(rawProviders)) {
    if (!isPlainObject(config)) {
      providers[providerId] = config;
      continue;
    }
    const next: AnyRecord = { ...config };
    const models = Array.isArray(config.models) ? config.models : [];
    const chatModels: unknown[] = [];
    const imageModels: AnyRecord[] = [];

    for (const model of models) {
      if (modelType(providerId, model) === "image") {
        const mediaModel = normalizeMediaModelEntry(providerId, model);
        if (mediaModel) imageModels.push(mediaModel);
        changed = true;
      } else {
        chatModels.push(model);
      }
    }

    if (imageModels.length > 0) {
      next.models = chatModels;
      const media = isPlainObject(next.media) ? { ...next.media } : {};
      const imageGeneration = isPlainObject(media.image_generation) ? { ...media.image_generation } : {};
      const appended = appendUniqueMediaModels(imageGeneration.models, imageModels);
      imageGeneration.models = appended.models;
      media.image_generation = imageGeneration;
      next.media = media;
      changed = changed || appended.changed;
    }

    providers[providerId] = next;
  }

  return { providers, changed };
}

export function migrateProviderMediaConfig(codiaHome: string, log: (message: string) => void = () => {}) {
  const ymlPath = path.join(codiaHome, "added-models.yaml");
  const existing = safeReadYAMLSync(ymlPath, null, YAML);
  if (!existing || !isPlainObject(existing.providers)) return false;

  const { providers, changed } = normalizeProviderMediaConfigMap(existing.providers);
  if (!changed) return false;

  const header =
    "# Codia provider config (global, shared across agents)\n" +
    "# Managed by the settings page\n\n";
  const data = { ...existing, providers };
  const yamlStr = header + YAML.dump(data, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });
  atomicWriteSync(ymlPath, yamlStr);
  log("[migrate] provider image models migrated to media.image_generation");
  return true;
}
