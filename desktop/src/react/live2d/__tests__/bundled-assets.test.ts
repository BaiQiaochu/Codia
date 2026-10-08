import { describe, expect, it } from 'vitest';
import { CODIA_BUNDLED_ASSETS, resolveModelAsset, validateModelManifest } from '../assets';
import { bundledShaderSources, readBundledCodiaAsset } from '../bundled-assets';

describe('self-contained Codia assets', () => {
  it('decodes the real manifest, MOC3 binary and PNG atlas without any fetch', () => {
    const json = readBundledCodiaAsset(CODIA_BUNDLED_ASSETS.modelUrl);
    const manifest = validateModelManifest(JSON.parse(new TextDecoder().decode(json)));
    const moc = readBundledCodiaAsset(resolveModelAsset(manifest.moc, CODIA_BUNDLED_ASSETS.modelUrl));
    expect(new TextDecoder().decode(moc.slice(0, 4))).toBe('MOC3');
    expect(moc.byteLength).toBeGreaterThan(40_000);
    expect(manifest.textures).toHaveLength(1);
    const atlas = readBundledCodiaAsset(resolveModelAsset(manifest.textures[0], CODIA_BUNDLED_ASSETS.modelUrl));
    expect([...new Uint8Array(atlas.slice(0, 8))]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(atlas.byteLength).toBeGreaterThan(1_000_000);
    expect(() => readBundledCodiaAsset('codia-bundled:/missing')).toThrow('Missing bundled');
  });
  it('embeds each of the SDK shaders', () => {
    expect(Object.keys(bundledShaderSources)).toHaveLength(13);
    for (const [name, source] of Object.entries(bundledShaderSources)) {
      expect(name).toMatch(/^codia-bundled:\/shaders\/.+\.(vert|frag)$/);
      expect(source.length).toBeGreaterThan(200);
      expect(source).toContain('Live2D');
    }
  });
});
