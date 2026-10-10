export function isPwaRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as typeof window & { __CODIA_PWA__?: unknown }).__CODIA_PWA__) return true;
  try {
    return (window.localStorage?.getItem('codia-token') || '').startsWith('pwa.');
  } catch {
    return false;
  }
}

export function readPwaAccessToken(): string {
  if (typeof window === 'undefined') return '';
  try {
    const token = window.localStorage?.getItem('codia-token') || '';
    return token.startsWith('pwa.') ? token : '';
  } catch {
    return '';
  }
}

export function appendPwaAccessTokenQuery(url: string): string {
  const token = readPwaAccessToken();
  if (!token) return url;

  const hashIndex = url.indexOf('#');
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}token=${encodeURIComponent(token)}${hash}`;
}
