import crypto from "node:crypto";

export const CACHE_PREFIX_CONTRACT_VERSION = 1;

function normalizeValue(value) {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => {
    const normalized = normalizeValue(item);
    return normalized === undefined ? null : normalized;
  });

  const out = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeValue(value[key]);
    if (normalized !== undefined) out[key] = normalized;
  }
  return out;
}

export function stableSerialize(value) {
  const serialized = JSON.stringify(normalizeValue(value));
  return serialized === undefined ? "null" : serialized;
}

export function hashCacheContractValue(value) {
  return crypto.createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function normalizeModel(model) {
  if (!model || typeof model !== "object") return null;
  return {
    id: model.id ?? model.modelId ?? null,
    provider: model.provider ?? null,
    api: model.api ?? null,
    baseUrl: model.baseUrl ?? model.base_url ?? null,
  };
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  return {
    name: tool.name ?? null,
    description: tool.description ?? null,
    parameters: tool.parameters ?? tool.input_schema ?? tool.schema ?? null,
  };
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map(normalizeTool)
    .filter((tool) => tool?.name)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || stableSerialize(a).localeCompare(stableSerialize(b)));
}

export function buildLlmContextCachePrefixContract({
  model = null,
  systemPrompt = "",
  tools = [],
} = {}) {
  const modelContract = normalizeModel(model);
  const systemPromptText = typeof systemPrompt === "string" ? systemPrompt : String(systemPrompt ?? "");
  const toolContracts = normalizeTools(tools);
  const source = {
    version: CACHE_PREFIX_CONTRACT_VERSION,
    model: modelContract,
    systemPrompt: systemPromptText,
    tools: toolContracts,
  };

  return {
    version: CACHE_PREFIX_CONTRACT_VERSION,
    modelHash: hashCacheContractValue(modelContract),
    systemPromptHash: hashCacheContractValue(systemPromptText),
    toolSchemaHash: hashCacheContractValue(toolContracts),
    cachePrefixHash: hashCacheContractValue(source),
    model: modelContract,
    toolNames: toolContracts.map((tool) => tool.name).filter(Boolean),
    toolCount: toolContracts.length,
    systemPromptBytes: Buffer.byteLength(systemPromptText, "utf8"),
  };
}

export function summarizeCachePrefixContract(contract) {
  if (!contract || typeof contract !== "object") return null;
  return {
    version: contract.version,
    cachePrefixHash: contract.cachePrefixHash,
    modelHash: contract.modelHash,
    systemPromptHash: contract.systemPromptHash,
    toolSchemaHash: contract.toolSchemaHash,
    model: contract.model ?? null,
    toolNames: Array.isArray(contract.toolNames) ? [...contract.toolNames] : [],
    toolCount: contract.toolCount ?? 0,
    systemPromptBytes: contract.systemPromptBytes ?? 0,
  };
}

export function diffCachePrefixContracts(expected, actual) {
  const diffs = [];
  for (const field of ["modelHash", "systemPromptHash", "toolSchemaHash", "cachePrefixHash"]) {
    if (expected?.[field] !== actual?.[field]) {
      diffs.push({
        field,
        expected: expected?.[field] ?? null,
        actual: actual?.[field] ?? null,
      });
    }
  }
  return diffs;
}
