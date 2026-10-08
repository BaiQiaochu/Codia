import { describe, expect, it } from 'vitest';
import { resolveCodiaLive2DAssets, resolveModelAsset, validateModelManifest } from '../assets';

describe('Codia packaged Live2D asset paths', () => {
  it('fetches data through the loopback asset route from file://, independent of checkout paths', () => {
    expect(resolveCodiaLive2DAssets('file:///C:/Program%20Files/Codia/resources/app.asar/desktop/dist-renderer/index.html', 51741)).toEqual({
      modelUrl: 'http://127.0.0.1:51741/desktop/assets/codia/live2d/model/Codia.model3.json',
      shaderPath: 'http://127.0.0.1:51741/desktop/assets/codia/live2d/shaders/',
    });
    expect(resolveCodiaLive2DAssets('file:///D:/app/index.html')).toBeNull();
    expect(resolveCodiaLive2DAssets('file:///D:/app/index.html', 70000)).toBeNull();
  });
  it('supports Vite and the existing /desktop and /mobile static mounts', () => {
    for (const prefix of ['', '/desktop', '/mobile']) {
      const resolved = resolveCodiaLive2DAssets(`http://127.0.0.1:15733${prefix}/index.html`)!;
      expect(resolved.modelUrl).toBe(`http://127.0.0.1:15733${prefix}/assets/codia/live2d/model/Codia.model3.json`);
      expect(resolveModelAsset('Codia.2048/texture_00.png', resolved.modelUrl)).toContain('/model/Codia.2048/texture_00.png');
    }
    expect(resolveCodiaLive2DAssets('https://codia.test/mobile')?.modelUrl).toBe('https://codia.test/mobile/assets/codia/live2d/model/Codia.model3.json');
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
