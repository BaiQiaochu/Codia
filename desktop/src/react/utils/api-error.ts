export function getApiErrorMessage(data: unknown, fallback = 'Request failed'): string {
  const source = data && typeof data === 'object' && 'error' in data
    ? (data as { error?: unknown }).error
    : data;
  if (!source) return fallback;
  if (typeof source === 'string') return source || fallback;
  if (source && typeof source === 'object') {
    const error = source as { message?: unknown; code?: unknown };
    if (typeof error.message === 'string' && error.message.trim()) return error.message;
    if (typeof error.code === 'string' && error.code.trim()) return error.code;
  }
  return fallback;
}
