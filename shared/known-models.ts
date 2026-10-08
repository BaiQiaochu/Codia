/**
 * known-models.ts -模型词典查询
 *
  *
  *
  * */
import { readFileSync } from "fs";
import { fromRoot } from "./app-root.ts";

let _raw = null;
let _fallbacks = null;
let _rawCaseInsensitive = null;
let _fallbacksCaseInsensitive = null;

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function _isModelDict(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function _buildCaseInsensitiveIndex(dict) {
  const index = Object.create(null);
  for (const [key, value] of Object.entries(dict || {})) {
    const normalized = key.toLowerCase();
    if (!hasOwn(index, normalized)) index[normalized] = value;
  }
  return index;
}

function _ensureLoaded() {
  if (_raw) return;
  _raw = JSON.parse(readFileSync(fromRoot("lib", "known-models.json"), "utf-8"));
  _fallbacks = JSON.parse(readFileSync(fromRoot("lib", "known-model-fallbacks.json"), "utf-8"));
  _rawCaseInsensitive = Object.create(null);
  for (const [provider, models] of Object.entries(_raw)) {
    if (!_isModelDict(models)) continue;
    _rawCaseInsensitive[provider.toLowerCase()] = _buildCaseInsensitiveIndex(models);
  }
  _fallbacksCaseInsensitive = _buildCaseInsensitiveIndex(_fallbacks);
}

function _lookupExact(dict, key) {
  if (!dict || typeof key !== "string") return null;
  return hasOwn(dict, key) ? dict[key] : null;
}

function _lookupCaseInsensitive(index, key) {
  if (!index || typeof key !== "string") return null;
  const normalized = key.toLowerCase();
  return hasOwn(index, normalized) ? index[normalized] : null;
}

/**
  *
 * @param {string} provider
 * @param {string} modelId
 * @returns {object|null}
 */
export function lookupKnown(provider, modelId) {
  if (typeof modelId !== "string" || modelId.length === 0) return null;
  _ensureLoaded();
  const providerKey = typeof provider === "string" ? provider : "";
  const normalizedProviderKey = providerKey.toLowerCase();
  const bare = modelId.includes("/") ? modelId.split("/").pop() : null;
  const providerModels = providerKey && _isModelDict(_raw[providerKey])
    ? _raw[providerKey]
    : (_isModelDict(_raw[normalizedProviderKey]) ? _raw[normalizedProviderKey] : null);
  const providerIndex = normalizedProviderKey ? _rawCaseInsensitive[normalizedProviderKey] : null;

  return _lookupExact(providerModels, modelId)
    || (bare ? _lookupExact(providerModels, bare) : null)
    || _lookupCaseInsensitive(providerIndex, modelId)
    || (bare ? _lookupCaseInsensitive(providerIndex, bare) : null)
    || _lookupExact(_fallbacks, modelId)
    || (bare ? _lookupExact(_fallbacks, bare) : null)
    || _lookupCaseInsensitive(_fallbacksCaseInsensitive, modelId)
    || (bare ? _lookupCaseInsensitive(_fallbacksCaseInsensitive, bare) : null)
    || null;
}

export function listKnownProviderModels(provider) {
  if (typeof provider !== "string" || provider.length === 0) return [];
  _ensureLoaded();
  const providerKey = provider.toLowerCase();
  const providerModels = _isModelDict(_raw[provider])
    ? _raw[provider]
    : (_isModelDict(_raw[providerKey]) ? _raw[providerKey] : null);
  return providerModels ? Object.keys(providerModels) : [];
}
