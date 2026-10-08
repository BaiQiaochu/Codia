import manifestText from '../../assets/codia/live2d/model/Codia.model3.json?raw';
// Explicit inline imports keep binary assets inside the lazy renderer chunk.
// Decoding does not use fetch(data:), so file:// needs no service or CSP change.
import mocData from '../../assets/codia/live2d/model/Codia.moc3?inline&url';
import textureData from '../../assets/codia/live2d/model/Codia.4096/texture_00.png?inline&url';
import { CODIA_BUNDLED_ASSETS, resolveModelAsset, validateModelManifest } from './assets';
import shader0 from '../../assets/codia/live2d/shaders/fragshadersrcalphablend.frag?raw';
import shader1 from '../../assets/codia/live2d/shaders/fragshadersrccolorblend.frag?raw';
import shader2 from '../../assets/codia/live2d/shaders/fragshadersrccopy.frag?raw';
import shader3 from '../../assets/codia/live2d/shaders/fragshadersrcmaskinvertedpremultipliedalpha.frag?raw';
import shader4 from '../../assets/codia/live2d/shaders/fragshadersrcmaskpremultipliedalpha.frag?raw';
import shader5 from '../../assets/codia/live2d/shaders/fragshadersrcpremultipliedalpha.frag?raw';
import shader6 from '../../assets/codia/live2d/shaders/fragshadersrcpremultipliedalphablend.frag?raw';
import shader7 from '../../assets/codia/live2d/shaders/fragshadersrcsetupmask.frag?raw';
import shader8 from '../../assets/codia/live2d/shaders/vertshadersrc.vert?raw';
import shader9 from '../../assets/codia/live2d/shaders/vertshadersrcblend.vert?raw';
import shader10 from '../../assets/codia/live2d/shaders/vertshadersrccopy.vert?raw';
import shader11 from '../../assets/codia/live2d/shaders/vertshadersrcmasked.vert?raw';
import shader12 from '../../assets/codia/live2d/shaders/vertshadersrcsetupmask.vert?raw';

const manifest = validateModelManifest(JSON.parse(manifestText));
if (manifest.moc !== 'Codia.moc3' || manifest.textures.length !== 1 || manifest.textures[0] !== 'Codia.4096/texture_00.png') {
  throw new Error('Codia export changed; update the bundled model asset map before release');
}
const modelFiles = new Map([
  [resolveModelAsset(manifest.moc, CODIA_BUNDLED_ASSETS.modelUrl), mocData],
  [resolveModelAsset(manifest.textures[0], CODIA_BUNDLED_ASSETS.modelUrl), textureData],
]);
export const bundledShaderSources: Record<string, string> = {
  ['codia-bundled:/shaders/fragshadersrcalphablend.frag']: shader0,
  ['codia-bundled:/shaders/fragshadersrccolorblend.frag']: shader1,
  ['codia-bundled:/shaders/fragshadersrccopy.frag']: shader2,
  ['codia-bundled:/shaders/fragshadersrcmaskinvertedpremultipliedalpha.frag']: shader3,
  ['codia-bundled:/shaders/fragshadersrcmaskpremultipliedalpha.frag']: shader4,
  ['codia-bundled:/shaders/fragshadersrcpremultipliedalpha.frag']: shader5,
  ['codia-bundled:/shaders/fragshadersrcpremultipliedalphablend.frag']: shader6,
  ['codia-bundled:/shaders/fragshadersrcsetupmask.frag']: shader7,
  ['codia-bundled:/shaders/vertshadersrc.vert']: shader8,
  ['codia-bundled:/shaders/vertshadersrcblend.vert']: shader9,
  ['codia-bundled:/shaders/vertshadersrccopy.vert']: shader10,
  ['codia-bundled:/shaders/vertshadersrcmasked.vert']: shader11,
  ['codia-bundled:/shaders/vertshadersrcsetupmask.vert']: shader12,
};

export function readBundledCodiaAsset(url: string): ArrayBuffer {
  if (url === CODIA_BUNDLED_ASSETS.modelUrl) return new TextEncoder().encode(manifestText).buffer;
  const dataUrl = modelFiles.get(url);
  if (!dataUrl || !/^data:[^,]*;base64,/.test(dataUrl)) throw new Error(`Missing bundled Codia asset: ${url}`);
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
}
