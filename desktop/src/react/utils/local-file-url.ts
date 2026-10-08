export function localFilePathToUrl(filePath: string): string {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized.startsWith('//')) return `file:${encodeURI(normalized)}`;
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${encodeURI(normalized)}`;
  if (normalized.startsWith('/')) return `file://${encodeURI(normalized)}`;
  return encodeURI(normalized);
}
