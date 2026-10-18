import { createHash } from 'node:crypto';

/** Canonical JSON binds approvals to an action's complete parameter values. */
export function approvalDigest(toolName: string, params: unknown, sessionPath: string | null): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical({ toolName, params, sessionPath }))).digest('hex');
}
