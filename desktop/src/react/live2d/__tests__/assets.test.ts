import { describe, expect, it } from 'vitest';
import { resolveCodiaLive2DAssets, resolveModelAsset, validateModelManifest } from '../assets';

describe('Codia packaged Live2D asset paths', () => {
  it('uses embedded assets for file:// regardless of server availability or install location', () => {
    const expected = { modelUrl: 'codia-bundled:/model/Codia.model3.json', shaderPath: 'codia-bundled:/shaders/' };
    for (const port of [undefined, null, 51741, 70000]) {
      expect(resolveCodiaLive2DAssets('file:///C:/Program%20Files/Codia/resources/app.asar/desktop/dist-renderer/index.html', port)).toEqual(expected);
      expect(resolveCodiaLive2DAssets('file:///D:/app/index.html', port)).toEqual(expected);
    }
  });
  it('uses the same packaged model for web/static mounts without network-specific dependencies', () => {
    for (const page of ['http://127.0.0.1:15733/index.html', 'https://codia.test/desktop', 'https://codia.test/mobile']) {
      const resolved = resolveCodiaLive2DAssets(page)!;
      expect(resolved.modelUrl).toBe('codia-bundled:/model/Codia.model3.json');
      expect(resolveModelAsset('Codia.4096/texture_00.png', resolved.modelUrl)).toBe('codia-bundled:/model/Codia.4096/texture_00.png');
    }
    expect(resolveCodiaLive2DAssets('ftp://unsupported/index.html')).toBeNull();
  });
  it('rejects remote/traversal model references and incomplete exports', () => {
    const url = 'http://127.0.0.1:51741/desktop/assets/codia/live2d/model/Codia.model3.json';
    for (const reference of ['../elsewhere.moc3', '%2e%2e/other.moc3', '/root.moc3', '\\server\\model', 'https://other/model.moc3', '//other/model.moc3']) {
      expect(() => resolveModelAsset(reference, url)).toThrow();
    }
    expect(() => validateModelManifest({ Version: 3 })).toThrow();
    expect(() => validateModelManifest({ Version: 3, FileReferences: { Moc: 'not-a-model.png', Textures: ['texture.png'] } })).toThrow();
    expect(validateModelManifest({ Version: 3, FileReferences: { Moc: 'Codia.moc3', Textures: ['texture.png'] } })).toEqual({ moc: 'Codia.moc3', textures: ['texture.png'] });
  });
});
