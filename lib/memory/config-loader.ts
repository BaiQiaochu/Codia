// @ts-nocheck
import fs from "fs";
import YAML from "js-yaml";
import { atomicWriteSync } from "../../shared/safe-fs.ts";

const _cache = new Map();

function resolveApi(block) {
  if (!block) return null;
  return {
    provider: typeof block?.provider === "string" ? block.provider.trim() : "",
    api_key: block?.api_key || "",
    base_url: block?.base_url || "",
    api: block?.api || "",
  };
}

export function loadConfig(configPath) {
  const entry = _cache.get(configPath);
  if (entry) return entry.cached;

  const raw = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
  const cachedRaw = structuredClone(raw);
  const api = resolveApi(raw.api) || { provider: "", api_key: "", base_url: "" };
  const embeddingApi = resolveApi(raw.embedding_api);
  const utilityApi = resolveApi(raw.utility_api);

  const cached = {
    ...raw,
    api,
    embedding_api: embeddingApi,
    utility_api: utilityApi,
  };

  _cache.set(configPath, { cached, cachedRaw });
  return cached;
}

export function clearConfigCache(configPath) {
  if (configPath) {
    _cache.delete(configPath);
  } else {
    _cache.clear();
  }
}

export function getRawConfig(configPath) {
  if (configPath) {
    return _cache.get(configPath)?.cachedRaw ?? null;
  }
  for (const entry of _cache.values()) {
    if (entry.cachedRaw) return entry.cachedRaw;
  }
  return null;
}

export function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    if (sv === null) {
      delete out[key];
      continue;
    }
    const tv = target[key];
    if (sv && typeof sv === "object" && !Array.isArray(sv)
        && tv && typeof tv === "object" && !Array.isArray(tv)) {
      out[key] = deepMerge(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}

export function saveConfig(configPath, partial) {
  const current = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
  const merged = deepMerge(current, partial);
  const header =
    "# G-SAP system configuration\n" +
    "# Managed by the settings UI. Manual edits are supported.\n\n";
  const yamlStr = header + YAML.dump(merged, {
    indent: 2,
    lineWidth: -1,
    sortKeys: false,
    quotingType: "\"",
    forceQuotes: false,
  });

  atomicWriteSync(configPath, yamlStr);
  clearConfigCache(configPath);
}
