function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function asHttpUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function firstUriListUrl(uriList: string): string | null {
  for (const rawLine of uriList.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const url = asHttpUrl(line);
    if (url) return url;
  }
  return null;
}

function singleRichLinkUrl(html: string, plainText: string): string | null {
  const trimmedHtml = html.trim();
  if (!trimmedHtml) return null;

  if (typeof DOMParser === 'undefined') {
    const match = trimmedHtml.match(/^<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*)<\/a>$/i);
    if (!match) return null;
    const href = asHttpUrl(match[1] || '');
    const anchorText = normalizeWhitespace((match[2] || '').replace(/<[^>]+>/g, ''));
    const pastedText = normalizeWhitespace(plainText);
    if (!href || (pastedText && anchorText && pastedText !== anchorText)) return null;
    return href;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map((anchor) => ({
      href: asHttpUrl(anchor.getAttribute('href') || ''),
      text: normalizeWhitespace(anchor.textContent || ''),
    }))
    .filter((anchor) => anchor.href);

  if (anchors.length !== 1) return null;

  const bodyText = normalizeWhitespace(doc.body?.textContent || '');
  const anchorText = anchors[0].text;

  if (bodyText && anchorText && bodyText !== anchorText) return null;

  return anchors[0].href;
}

export function extractPlainUrlPaste(clipboardData: Pick<DataTransfer, 'getData'> | null | undefined): string | null {
  if (!clipboardData) return null;

  const plainText = clipboardData.getData('text/plain') || '';
  const plainUrl = asHttpUrl(plainText);
  if (plainUrl) return plainUrl;

  const uriListUrl = firstUriListUrl(clipboardData.getData('text/uri-list') || '');
  if (uriListUrl) return uriListUrl;

  return singleRichLinkUrl(clipboardData.getData('text/html') || '', plainText);
}
