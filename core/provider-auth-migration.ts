import fs from "fs";
import path from "path";
import YAML from "js-yaml";
import { safeReadYAMLSync } from "../shared/safe-fs.ts";
import { getInvalidProviderModelIds } from "../shared/provider-model-validation.ts";
import { providerCredentialAllowsMissingApiKey } from "../shared/provider-auth.ts";

type AnyRecord = Record<string, any>;

function isPlainObject(value: unknown): value is AnyRecord {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj: unknown, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function readJson(filePath: string): AnyRecord {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) || {};
  } catch {
    return {};
  }
}

function writeProvidersYaml(filePath: string, raw: AnyRecord, providers: AnyRecord) {
  const header =
    "# G-SAP provider configuration (global, shared across agents)\n" +
    "# Managed by Settings.\n\n";
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    header + YAML.dump({ ...raw, providers }, {
      indent: 2,
      lineWidth: -1,
      sortKeys: false,
      quotingType: "\"",
      forceQuotes: false,
    }),
    "utf-8",
  );
  fs.renameSync(tmpPath, filePath);
}

function extractLegacyApiKey(credential: unknown): string {
  if (typeof credential === "string") return credential.trim();
  if (!isPlainObject(credential)) return "";
  if (credential.type === "oauth") return "";
  if (credential.type && credential.type !== "api_key") return "";
  return String(
    credential.key
      || credential.apiKey
      || (credential.type === "api_key" ? credential.access : "")
      || (credential.type === "api_key" ? credential.token : "")
      || "",
  ).trim();
}

function extractProjectedApiKey(providerConfig: unknown): string {
  if (!isPlainObject(providerConfig)) return "";
  return String(providerConfig.apiKey || providerConfig.api_key || "").trim();
}

function isSyntheticLocalApiKey(apiKey: string, entry: AnyRecord | null, providerConfig: AnyRecord | null): boolean {
  if (apiKey !== "local") return false;
  return providerCredentialAllowsMissingApiKey({
    authType: entry?.authType,
    baseUrl: providerConfig?.baseUrl || entry?.baseUrl || "",
  });
}

function getLegacyApiKey(auth: unknown, providerId: string, providerKey: string, authJsonKey: string | undefined): string {
  if (!isPlainObject(auth)) return "";
  const keys = [...new Set([providerKey, authJsonKey, providerId].filter(Boolean))];
  for (const key of keys) {
    if (!hasOwn(auth, key)) continue;
    const apiKey = extractLegacyApiKey(auth[key]);
    if (apiKey) return apiKey;
  }
  return "";
}

function resolveProviderEntry(providerRegistry: AnyRecord | null | undefined, authKey: string): AnyRecord | null {
  try {
    return providerRegistry?.get?.(authKey) || null;
  } catch {
    return null;
  }
}

function getModelsJsonProvider(modelsProviders: unknown, providerId: string, authKey: string, authJsonKey: string | undefined): AnyRecord | null {
  if (!isPlainObject(modelsProviders)) return null;
  return modelsProviders[providerId]
    || modelsProviders[authKey]
    || (authJsonKey ? modelsProviders[authJsonKey] : null)
    || null;
}

function modelIdsFromModelsJsonProvider(providerConfig: AnyRecord | null): string[] {
  const ids: string[] = [];
  if (Array.isArray(providerConfig?.models)) {
    for (const model of providerConfig.models) {
      const id = typeof model === "string" ? model : model?.id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
  }
  if (isPlainObject(providerConfig?.modelOverrides)) {
    ids.push(...Object.keys(providerConfig.modelOverrides).filter(Boolean));
  }
  return [...new Set(ids)];
}

function defaultModels(providerRegistry: AnyRecord | null | undefined, providerId: string): string[] {
  try {
    const models = providerRegistry?.getDefaultModels?.(providerId);
    return Array.isArray(models) ? models.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function filterInvalidProviderModels(providerId: string, models: string[], baseUrl: string): string[] {
  if (!models.length) return models;
  const invalid = new Set(
    getInvalidProviderModelIds(providerId, models, { baseUrl })
      .map((id) => String(id).trim().toLowerCase()),
  );
  if (invalid.size === 0) return models;
  return models.filter((id) => !invalid.has(String(id).trim().toLowerCase()));
}

export function migrateLegacyApiKeyAuthToProviders({
  gsapHome,
  providerRegistry,
  log = () => {},
}: {
  gsapHome?: string;
  providerRegistry?: AnyRecord;
  log?: (message: string) => void;
}) {
  if (!gsapHome) return { migrated: 0, providers: [] };

  const authPath = path.join(gsapHome, "auth.json");
  const providersPath = path.join(gsapHome, "added-models.yaml");
  const auth = readJson(authPath);

  providerRegistry?.reload?.();
  const raw = safeReadYAMLSync(providersPath, {}, YAML) || {};
  const providers: AnyRecord = isPlainObject(raw.providers) ? { ...raw.providers } : {};
  const modelsJsonProvidersRaw = readJson(path.join(gsapHome, "models.json")).providers || {};
  const modelsJsonProviders = isPlainObject(modelsJsonProvidersRaw) ? modelsJsonProvidersRaw : {};
  const providerKeys = new Set([
    ...(isPlainObject(auth) ? Object.keys(auth) : []),
    ...Object.keys(modelsJsonProviders),
  ]);
  if (providerKeys.size === 0) {
    return { migrated: 0, providers: [] };
  }

  const migratedProviders: string[] = [];

  for (const providerKey of providerKeys) {
    const entry = resolveProviderEntry(providerRegistry, providerKey);
    if (entry?.authType === "oauth") continue;

    const providerId = entry?.id || providerKey;
    const current: AnyRecord = isPlainObject(providers[providerId]) ? providers[providerId] : {};
    if (hasOwn(current, "api_key")) continue;

    const modelsJsonProvider = getModelsJsonProvider(
      modelsJsonProviders,
      providerId,
      providerKey,
      entry?.authJsonKey,
    );
    const projectedApiKey = extractProjectedApiKey(modelsJsonProvider);
    const apiKey = (
      projectedApiKey && !isSyntheticLocalApiKey(projectedApiKey, entry, modelsJsonProvider)
        ? projectedApiKey
        : ""
    ) || getLegacyApiKey(auth, providerId, providerKey, entry?.authJsonKey);
    if (!apiKey) continue;

    const next: AnyRecord = { ...current, api_key: apiKey };

    const baseUrl = current.base_url || modelsJsonProvider?.baseUrl || entry?.baseUrl || "";
    if (baseUrl && !hasOwn(current, "base_url")) next.base_url = baseUrl;

    const api = current.api || modelsJsonProvider?.api || entry?.api || "";
    if (api && !hasOwn(current, "api")) next.api = api;

    if (entry?.source?.kind === "local-provider-plugin") {
      // Local provider plugin definition owns model metadata. Avoid writing
      // models.json ids into the catalog overlay, where a bare id can erase
      // model capability fields during provider merge.
    } else if (!hasOwn(current, "models") || !Array.isArray(current.models)) {
      const modelIds = modelIdsFromModelsJsonProvider(modelsJsonProvider);
      const seededModels = modelIds.length > 0 ? modelIds : defaultModels(providerRegistry, providerId);
      const validModels = filterInvalidProviderModels(providerId, seededModels, baseUrl);
      if (validModels.length > 0) next.models = validModels;
    }

    providers[providerId] = next;
    migratedProviders.push(providerId);
  }

  if (migratedProviders.length === 0) {
    return { migrated: 0, providers: [] };
  }

  fs.mkdirSync(path.dirname(providersPath), { recursive: true });
  writeProvidersYaml(providersPath, raw, providers);
  if (typeof providerRegistry?._saveAddedModels === "function") {
    providerRegistry._saveAddedModels(providers, {
      legacyApiKeyAuthMigratedAt: new Date().toISOString(),
    });
  }
  providerRegistry?.reload?.();
  log(`[migrations] legacy API-key auth moved to added-models.yaml (${migratedProviders.join(", ")})`);
  return { migrated: migratedProviders.length, providers: migratedProviders };
}
