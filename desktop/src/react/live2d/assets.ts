export interface CodiaLive2DAssets { modelUrl: string; shaderPath: string; }

/** These virtual paths address data embedded in the renderer's lazy SDK chunk.
 * They are never requested over HTTP or file://, and need no local server. */
export const CODIA_BUNDLED_ASSETS: CodiaLive2DAssets = {
  modelUrl: 'codia-bundled:/model/Codia.model3.json',
  shaderPath: 'codia-bundled:/shaders/',
};
export function resolveCodiaLive2DAssets(pageUrl: string, _localServerPort?: number | null): CodiaLive2DAssets | null {
  const page = new URL(pageUrl);
  if (!['file:', 'http:', 'https:'].includes(page.protocol)) return null;
  return { ...CODIA_BUNDLED_ASSETS };
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
