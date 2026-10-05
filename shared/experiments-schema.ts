export const EXPERIMENT_STATUSES = new Set(["alpha", "beta", "deprecated", "retired"]);
export const EXPERIMENT_SCOPES = new Set(["global", "agent", "session"]);
export const EXPERIMENT_VALUE_SCHEMA_TYPES = new Set(["boolean", "enum", "number"]);
export const EXPERIMENT_PRESENTATION_TYPES = new Set(["toggle", "select", "segmented", "paired_toggles"]);

type ExperimentOption = {
  label?: string;
  value: unknown;
};

type ExperimentValueSchema = {
  type?: string;
  options?: ExperimentOption[];
  presentation?: {
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type ExperimentDefinition = {
  id: string;
  scope: string;
  status: string;
  defaultValue?: unknown;
  valueSchema?: ExperimentValueSchema;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function cloneExperiment<T>(value: T): T {
  return structuredClone(value);
}

export function normalizeExperimentDefinition(raw: unknown): ExperimentDefinition {
  if (!isRecord(raw)) {
    throw new Error("experiment definition must be an object");
  }
  if (!raw.id || typeof raw.id !== "string") throw new Error("experiment definition requires id");
  if (!EXPERIMENT_SCOPES.has(String(raw.scope))) throw new Error(`invalid experiment scope: ${raw.id}`);
  if (!EXPERIMENT_STATUSES.has(String(raw.status))) throw new Error(`invalid experiment status: ${raw.id}`);

  const valueSchema: ExperimentValueSchema = isRecord(raw.valueSchema) ? raw.valueSchema : {
    type: typeof raw.defaultValue === "boolean" ? "boolean" : "enum",
  };
  if (!EXPERIMENT_VALUE_SCHEMA_TYPES.has(String(valueSchema.type))) {
    throw new Error(`invalid experiment value schema: ${raw.id}`);
  }
  if (valueSchema.presentation && !EXPERIMENT_PRESENTATION_TYPES.has(String(valueSchema.presentation.type))) {
    throw new Error(`invalid experiment presentation: ${raw.id}`);
  }
  if (valueSchema.type === "enum") {
    const options = Array.isArray(valueSchema.options) ? valueSchema.options : [];
    if (options.length === 0) throw new Error(`enum experiment requires options: ${raw.id}`);
    if (!options.some((opt) => opt.value === raw.defaultValue)) {
      throw new Error(`enum default must be in options: ${raw.id}`);
    }
  }

  return cloneExperiment({
    ...raw,
    id: raw.id,
    scope: String(raw.scope),
    status: String(raw.status),
    valueSchema,
  });
}

export function normalizeExperimentValue(definition: ExperimentDefinition, value: unknown): unknown {
  const schema = definition.valueSchema || {};
  if (schema.type === "boolean") return value === true;
  if (schema.type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) throw new Error(`invalid experiment value for ${definition.id}`);
    return num;
  }
  if (schema.type === "enum") {
    const allowed = new Set((schema.options || []).map((opt) => opt.value));
    if (!allowed.has(value)) throw new Error(`invalid experiment value for ${definition.id}`);
    return value;
  }
  throw new Error(`invalid experiment value schema for ${definition.id}`);
}
