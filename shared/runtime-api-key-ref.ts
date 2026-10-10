export const RUNTIME_API_KEY_PREFIX = "codia-runtime-api-key:";

export function buildRuntimeApiKeyRef(providerId: string) {
  return `${RUNTIME_API_KEY_PREFIX}${providerId}`;
}

export function runtimeApiKeyRefProvider(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith(RUNTIME_API_KEY_PREFIX)) return null;
  const providerId = value.slice(RUNTIME_API_KEY_PREFIX.length).trim();
  return providerId || null;
}

export function isRuntimeApiKeyRef(value: unknown): value is string {
  return runtimeApiKeyRefProvider(value) !== null;
}
