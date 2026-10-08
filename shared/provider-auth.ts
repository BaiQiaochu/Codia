import { isLocalBaseUrl } from "./net-utils.ts";
import { isMaskedSecretValue, maskSecretValue } from "./secret-custody.ts";

const AUTH_TYPES_ALLOWING_MISSING_API_KEY = new Set(["none", "optional"]);
const KNOWN_AUTH_TYPES = new Set(["api-key", "oauth", "none", "optional"]);
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const PRINTABLE_ASCII_VALUE = /^[\x20-\x7E]*$/;
const INVALID_PROVIDER_CREDENTIAL_VALUE = "invalid_provider_credential_value";
const FORBIDDEN_PROVIDER_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "expect",
  "host",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type ProviderHeaders = Record<string, string>;
type UnknownRecord = Record<string, unknown>;

export class ProviderCredentialValidationError extends Error {
  statusCode = 400;
  code = INVALID_PROVIDER_CREDENTIAL_VALUE;
  field: string;

  constructor(field: string) {
    super(`${field} must contain printable ASCII characters only`);
    this.name = "ProviderCredentialValidationError";
    this.field = field;
  }
}

export function normalizeProviderAuthType(authType: unknown): string {
  const normalized = typeof authType === "string" ? authType : "";
  return KNOWN_AUTH_TYPES.has(normalized) ? normalized : "api-key";
}

export function providerAuthTypeAllowsMissingApiKey(authType: unknown): boolean {
  return AUTH_TYPES_ALLOWING_MISSING_API_KEY.has(normalizeProviderAuthType(authType));
}

export function providerCredentialAllowsMissingApiKey({
  authType,
  baseUrl,
}: { authType?: string; baseUrl?: string } = {}): boolean {
  return providerAuthTypeAllowsMissingApiKey(authType) || isLocalBaseUrl(baseUrl);
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function headerKeyForName(name: unknown): string {
  return String(name || "").trim().toLowerCase();
}

function isValidProviderHeaderName(name: unknown): boolean {
  const key = headerKeyForName(name);
  return !!key && HTTP_HEADER_NAME.test(key) && !FORBIDDEN_PROVIDER_HEADERS.has(key);
}

function isValidProviderCredentialValue(value: unknown): boolean {
  return PRINTABLE_ASCII_VALUE.test(String(value ?? ""));
}

export function normalizeProviderApiKey(value: unknown): string {
  if (value === null || value === undefined) return "";
  const normalized = String(value);
  return isValidProviderCredentialValue(normalized) ? normalized : "";
}

export function assertValidProviderCredentialValue(
  value: unknown,
  field: string,
  { allowMasked = false }: { allowMasked?: boolean } = {},
): void {
  if (value === null || value === undefined) return;
  const normalized = String(value);
  if (allowMasked && isMaskedSecretValue(normalized)) return;
  if (!isValidProviderCredentialValue(normalized)) {
    throw new ProviderCredentialValidationError(field);
  }
}

export function assertValidProviderCredentialPatch(
  patch: unknown,
  prefix = "provider",
  options: { allowMasked?: boolean } = {},
): void {
  if (!isPlainObject(patch)) return;
  if (Object.prototype.hasOwnProperty.call(patch, "api_key")) {
    assertValidProviderCredentialValue(patch.api_key, `${prefix}.api_key`, options);
  }
  if (!isPlainObject(patch.headers)) return;
  for (const [name, value] of Object.entries(patch.headers)) {
    assertValidProviderCredentialValue(value, `${prefix}.headers.${name}`, options);
  }
}

function findExistingHeaderValue(existing: UnknownRecord, name: unknown): string {
  const key = headerKeyForName(name);
  for (const [existingName, value] of Object.entries(existing || {})) {
    if (headerKeyForName(existingName) === key) return String(value || "");
  }
  return "";
}

export function normalizeProviderHeaders(headers: unknown): ProviderHeaders {
  if (!isPlainObject(headers)) return {};
  const byLowerName = new Map();
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = String(rawName || "").trim();
    if (!isValidProviderHeaderName(name)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue);
    if (!value || !isValidProviderCredentialValue(value)) continue;
    byLowerName.set(headerKeyForName(name), { name, value });
  }
  return Object.fromEntries([...byLowerName.values()].map(({ name, value }) => [name, value]));
}

export function maskProviderHeaders(headers: unknown): ProviderHeaders {
  const normalized = normalizeProviderHeaders(headers);
  const masked: ProviderHeaders = {};
  for (const [name, value] of Object.entries(normalized)) {
    masked[name] = maskSecretValue(value);
  }
  return masked;
}

export function resolveProviderHeadersPatch({
  patch,
  existing = {},
}: { patch?: unknown; existing?: unknown } = {}): ProviderHeaders {
  if (!isPlainObject(patch)) return {};
  const resolved: ProviderHeaders = {};
  const saved = normalizeProviderHeaders(existing);
  for (const [rawName, rawValue] of Object.entries(patch)) {
    const name = String(rawName || "").trim();
    if (!isValidProviderHeaderName(name)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    const value = String(rawValue);
    if (!value) continue;
    resolved[name] = isMaskedSecretValue(value)
      ? findExistingHeaderValue(saved, name)
      : value;
  }
  return normalizeProviderHeaders(resolved);
}

export function collectProviderHeaderSecretPatchPaths(headers: unknown, prefix = "headers"): string[] {
  if (!isPlainObject(headers)) return [];
  const paths = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === null || value === undefined || isMaskedSecretValue(String(value))) continue;
    paths.push(`${prefix}.${name}`);
  }
  return paths;
}

export function collectProviderHeaderSecretPatchPathsFromConfig(partial: UnknownRecord | null | undefined): string[] {
  const providers = isPlainObject(partial?.providers) ? partial.providers : {};
  const paths = [];
  for (const [providerId, patch] of Object.entries(providers)) {
    if (!isPlainObject(patch) || !Object.prototype.hasOwnProperty.call(patch, "headers")) continue;
    paths.push(...collectProviderHeaderSecretPatchPaths(
      patch.headers,
      `providers.${providerId}.headers`,
    ));
  }
  return paths;
}
