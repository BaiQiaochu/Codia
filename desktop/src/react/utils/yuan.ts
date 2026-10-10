export function normalizeYuanKey(yuan?: string | null): string {
  const raw = String(yuan || '').trim().toLowerCase();
  if (!raw) return 'codia';
  return raw;
}
