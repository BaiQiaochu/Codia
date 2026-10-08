export interface CodiaLive2DAssets { modelUrl: string; shaderPath: string; }

/** Fetch cannot read file:// in a packaged renderer. Only data uses the existing
 * loopback static route; executable SDK code stays in the renderer bundle. */
export function resolveCodiaLive2DAssets(pageUrl: string, localServerPort?: number | null): CodiaLive2DAssets | null {
  const page = new URL(pageUrl);
  let base: URL;
  if (page.protocol === 'file:') {
    if (!Number.isInteger(localServerPort) || !localServerPort || localServerPort < 1 || localServerPort > 65535) return null;
    base = new URL(`http://127.0.0.1:${localServerPort}/desktop/assets/codia/live2d/`);
  } else if (page.protocol === 'http:' || page.protocol === 'https:') {
    if (page.pathname === '/desktop' || page.pathname === '/mobile') page.pathname += '/';
    base = new URL('./assets/codia/live2d/', page);
  } else return null;
  return { modelUrl: new URL('model/Codia.model3.json', base).href, shaderPath: new URL('shaders/', base).href };
}

export function resolveModelAsset(reference: string, modelUrl: string): string {
  // A model may only refer to files below its own directory, without credentials.
  if (!reference || reference.includes('\\') || reference.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(reference)) {
    throw new Error('Live2D model asset must be a relative local resource');
  }
  const decoded = decodeURIComponent(reference);
  if (decoded.split('/').some(part => part === '..' || part === '.') || decoded.includes('\\')) {
    throw new Error('Live2D model asset escapes its directory');
  }
  const base = new URL('./', modelUrl);
  const url = new URL(reference, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash) {
    throw new Error('Live2D model asset escapes its directory');
  }
  return url.href;
}

export function validateModelManifest(value: unknown): { moc: string; textures: string[] } {
  const manifest = value as { Version?: unknown; FileReferences?: { Moc?: unknown; Textures?: unknown } } | null;
  const references = manifest?.FileReferences;
  if (manifest?.Version !== 3 || typeof references?.Moc !== 'string' || !references.Moc.endsWith('.moc3')
    || !Array.isArray(references.Textures) || !references.Textures.length
    || !references.Textures.every(item => typeof item === 'string' && item.length > 0)) {
    throw new Error('Live2D export requires Version 3, a .moc3 and texture files');
  }
  return { moc: references.Moc, textures: references.Textures as string[] };
}
