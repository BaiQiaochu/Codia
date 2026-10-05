type UnknownRecord = Record<string, unknown>;

type SchemaType = string | string[];

type MediaParameterSchema = UnknownRecord & {
  type?: SchemaType;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, MediaParameterSchema>;
};

type MediaMode = UnknownRecord & {
  id?: string;
  defaults?: UnknownRecord;
  inputLimits?: UnknownRecord;
  parameterSchema?: MediaParameterSchema;
};

type MediaModel = UnknownRecord & {
  id?: string;
  inputLimits?: UnknownRecord;
  modes?: MediaMode[];
  parameterSchema?: MediaParameterSchema;
};

type MediaInput = UnknownRecord & {
  aspect_ratio?: unknown;
  aspectRatio?: unknown;
  duration?: unknown;
  frame_rate?: unknown;
  frameRate?: unknown;
  image?: unknown;
  images?: unknown;
  mode?: unknown;
  model?: unknown;
  modelId?: unknown;
  num_frames?: unknown;
  numFrames?: unknown;
  options?: unknown;
  prompt?: unknown;
  quality?: unknown;
  ratio?: unknown;
  referenceImages?: unknown;
  resolution?: unknown;
  resolution_type?: unknown;
  resolutionType?: unknown;
  seconds?: unknown;
  seed?: unknown;
  size?: unknown;
  video_resolution?: unknown;
  videoResolution?: unknown;
};

type MediaParameterResolutionInput = {
  kind?: string;
  input?: MediaInput;
  providerId?: string;
  model?: MediaModel | null;
  providerDefaults?: UnknownRecord;
};

function isObject(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function objectOrEmpty(value: unknown): UnknownRecord {
  return isObject(value) ? value : {};
}

function objectProperty(value: unknown, key: string): UnknownRecord {
  const record = objectOrEmpty(value);
  return objectOrEmpty(record[key]);
}

function clone<T>(value: T): T | undefined {
  return value === undefined ? undefined : structuredClone(value);
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function compactObject(value: UnknownRecord = {}): UnknownRecord {
  const out: UnknownRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null && item !== "") out[key] = item;
  }
  return out;
}

function imageCount(input: MediaInput = {}): number {
  const raw = input.referenceImages || input.images || input.image;
  if (!raw) return 0;
  const images = Array.isArray(raw) ? raw : [raw];
  return images.filter((item) => {
    if (typeof item === "string") return item.trim();
    return isObject(item);
  }).length;
}

export function inferMediaMode(kind: string, input: MediaInput = {}): string {
  const options = objectOrEmpty(input.options);
  const requested = text(input.mode) || text(options.mode);
  if (requested) return requested;
  const count = imageCount(input);
  if (kind === "video") {
    if (count > 1) return "multiframe2video";
    if (count === 1) return "image2video";
    return "text2video";
  }
  if (count > 0) return "image2image";
  return "text2image";
}

function findMode(model: MediaModel = {}, modeId: string): MediaMode | null {
  if (!Array.isArray(model.modes) || model.modes.length === 0) return null;
  return model.modes.find((mode) => mode?.id === modeId) || null;
}

function resolveInputLimits(model: MediaModel = {}, mode: MediaMode | null = null): UnknownRecord | null {
  if (isObject(mode?.inputLimits)) return mode.inputLimits;
  if (isObject(model?.inputLimits)) return model.inputLimits;
  return null;
}

function withoutNestedDefaults(value: UnknownRecord = {}): UnknownRecord {
  const out: UnknownRecord = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "models" || key === "modes" || key === "options") continue;
    out[key] = item;
  }
  return out;
}

function providerDefaultsForMode(
  providerDefaults: UnknownRecord = {},
  modelId: string,
  modeId: string,
): UnknownRecord {
  const models = objectProperty(providerDefaults, "models");
  const modes = objectProperty(providerDefaults, "modes");
  const modelDefaults = objectOrEmpty(models[modelId]);
  const modeDefaults = isObject(objectProperty(modelDefaults, "modes")[modeId])
    ? objectProperty(modelDefaults, "modes")[modeId] as UnknownRecord
    : objectOrEmpty(modes[modeId]);
  return {
    ...withoutNestedDefaults(providerDefaults),
    ...objectOrEmpty(providerDefaults.options),
    ...withoutNestedDefaults(modelDefaults),
    ...objectOrEmpty(modelDefaults.options),
    ...withoutNestedDefaults(modeDefaults),
    ...objectOrEmpty(modeDefaults.options),
  };
}

function explicitParameters(kind: string, input: MediaInput = {}, schema: MediaParameterSchema = {}): UnknownRecord {
  const props = isObject(schema.properties) ? schema.properties : {};
  const out: UnknownRecord = {};
  const add = (key: string, value: unknown) => {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  };
  add("duration", input.duration ?? input.seconds);
  add("ratio", input.ratio ?? input.aspect_ratio ?? input.aspectRatio);
  add("quality", input.quality);
  add("frame_rate", input.frame_rate ?? input.frameRate);
  add("num_frames", input.num_frames ?? input.numFrames);
  add("seed", input.seed);
  if (kind === "video") {
    add("video_resolution", input.video_resolution ?? input.videoResolution);
    if (input.resolution !== undefined) {
      if (props.video_resolution) add("video_resolution", input.resolution);
      else add("resolution", input.resolution);
    }
  } else {
    add("resolution", input.resolution);
    add("resolution_type", input.resolution_type ?? input.resolutionType);
    add("size", input.size);
    add("format", input.format);
  }
  return out;
}

function typeMatches(type: SchemaType | undefined, value: unknown): boolean {
  if (!type) return true;
  if (Array.isArray(type)) return type.some((item) => typeMatches(item, value));
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  return true;
}

function validateSchemaValue(key: string, value: unknown, schema: MediaParameterSchema = {}) {
  if (value === undefined || value === null) return;
  if (!typeMatches(schema.type, value)) {
    throw new Error(`Media parameter "${key}" must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`Media parameter "${key}" must be one of: ${schema.enum.join(", ")}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      throw new Error(`Media parameter "${key}" must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      throw new Error(`Media parameter "${key}" must be <= ${schema.maximum}`);
    }
  }
}

export function validateMediaParameters(parameters: UnknownRecord = {}, schema: MediaParameterSchema = {}) {
  if (!isObject(schema) || !isObject(schema.properties)) return;
  for (const [key, value] of Object.entries(parameters)) {
    const propertySchema = schema.properties[key];
    if (!propertySchema) continue;
    validateSchemaValue(key, value, propertySchema);
  }
}

function validateReferenceImageLimits({
  input = {},
  inputLimits = null,
  providerId = "",
  modelId = "",
  modeId = "",
}: {
  input?: MediaInput;
  inputLimits?: UnknownRecord | null;
  providerId?: string;
  modelId?: string;
  modeId?: string;
} = {}) {
  const referenceLimits = objectProperty(inputLimits, "referenceImages");
  if (!isObject(referenceLimits)) return;
  const count = imageCount(input);
  const label = `${providerId}/${modelId}`.replace(/^\/|\/$/g, "") || "selected media model";
  if (typeof referenceLimits.max === "number" && count > referenceLimits.max) {
    if (referenceLimits.max === 0) {
      throw new Error(`Media model "${label}" mode "${modeId}" does not support reference images`);
    }
    throw new Error(`Media model "${label}" mode "${modeId}" supports at most ${referenceLimits.max} reference images`);
  }
  if (typeof referenceLimits.min === "number" && count < referenceLimits.min) {
    throw new Error(`Media model "${label}" mode "${modeId}" requires at least ${referenceLimits.min} reference images`);
  }
}

export function resolveMediaParameters({
  kind = "image",
  input = {},
  providerId = "",
  model = null,
  providerDefaults = {},
}: MediaParameterResolutionInput = {}) {
  const modelId = text(model?.id) || text(input.modelId) || text(input.model);
  const modeId = inferMediaMode(kind, input);
  const resolvedModel = model || {};
  const mode = findMode(resolvedModel, modeId);
  if (Array.isArray(resolvedModel.modes) && resolvedModel.modes.length > 0 && !mode) {
    throw new Error(`Media model "${providerId}/${modelId}" does not support mode "${modeId}"`);
  }
  const parameterSchema = mode?.parameterSchema || resolvedModel.parameterSchema || null;
  const inputLimits = resolveInputLimits(resolvedModel, mode);
  validateReferenceImageLimits({ input, inputLimits, providerId, modelId, modeId });
  const options = objectOrEmpty(input.options);
  const resolvedParameters = compactObject({
    ...(isObject(mode?.defaults) ? clone(mode.defaults) : {}),
    ...providerDefaultsForMode(providerDefaults, modelId, modeId),
    ...options,
    ...explicitParameters(kind, input, parameterSchema || {}),
  });
  const hasExplicitImageResolution = kind === "image" && input.resolution !== undefined && input.resolution !== null && input.resolution !== "";
  const hasExplicitImageSize = kind === "image" && (
    (input.size !== undefined && input.size !== null && input.size !== "")
    || (options.size !== undefined && options.size !== null && options.size !== "")
  );
  if (hasExplicitImageResolution && !hasExplicitImageSize) {
    delete resolvedParameters.size;
  }
  validateMediaParameters(resolvedParameters, parameterSchema || {});
  return {
    modeId,
    mode: mode ? clone(mode) : null,
    parameterSchema: clone(parameterSchema),
    inputLimits: clone(inputLimits),
    resolvedParameters,
  };
}
