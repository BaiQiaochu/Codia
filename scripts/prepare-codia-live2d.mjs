import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'third_party/live2d/cubism-web-5-r.5');
const target = path.join(root, 'desktop/src/assets/codia/live2d');
const check = process.argv.includes('--check');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceHashes(directory, prefix = '') {
  const hashes = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) Object.assign(hashes, await sourceHashes(path.join(directory, entry.name), `${relative}/`));
    else hashes[relative] = digest(await readFile(path.join(directory, entry.name)));
  }
  return hashes;
}

// Keep upstream files byte-for-byte. These two narrowly scoped adapter changes
// cancel shader fetches, inject bundled shader text, and dispose per context.
function adaptShader(sourceText) {
  let text = sourceText.replace(/\r\n/g, '\n');
  const replace = (before, after) => {
    if (text.split(before).length !== 2) throw new Error('Cubism 5-r.5 adapter anchor changed');
    text = text.replace(before, after);
  };
  replace('export class CubismShader_WebGL {', 'export class CubismShader_WebGL {\n  private _codiaRequest = new AbortController();\n  public codiaLoadError: Error | null = null;\n  public codiaShaderSources: Record<string, string> | null = null;');
  replace('const response = await fetch(url);', 'if (this.codiaShaderSources) {\n      const source = this.codiaShaderSources[url];\n      if (typeof source !== \'string\') throw new Error(`Missing bundled Cubism shader: ${url}`);\n      return source;\n    }\n    const response = await fetch(url, { signal: this._codiaRequest.signal });\n    if (!response.ok) throw new Error(`Cubism shader HTTP ${response.status}`);');
  replace('console.error(`Error loading ${file.path} shader:`, error);', 'if (!this._codiaRequest.signal.aborted) this.codiaLoadError = error;');
  replace('this.releaseShaderProgram();', 'this._codiaRequest.abort();\n    this.releaseShaderProgram();');
  replace('.then(() => {\n        // NOTE:', '.then(() => {\n        if (this._codiaRequest.signal.aborted || this.codiaLoadError) return;\n        // NOTE:');
  replace('public getShader(gl: WebGLRenderingContext): CubismShader_WebGL {', 'public releaseGlContext(gl: WebGLRenderingContext): void {\n    this._shaderMap.get(gl)?.release();\n    this._shaderMap.delete(gl);\n  }\n\n  public getShader(gl: WebGLRenderingContext): CubismShader_WebGL {');
  return text;
}

const result = await build({
  absWorkingDir: root,
  entryPoints: ['third_party/live2d/framework-entry.ts'],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  legalComments: 'inline', minify: false,
  banner: { js: '// Live2D Cubism SDK for Web 5-r.5, with Codia lifecycle adapter.\n// Reproduce: node scripts/prepare-codia-live2d.mjs. See licenses/ and third_party/live2d/.' },
  plugins: [{
    name: 'codia-cubism-lifecycle',
    setup(build) {
      build.onLoad({ filter: /cubismshader_webgl\.ts$/ }, async args => ({
        contents: adaptShader(await readFile(args.path, 'utf8')), loader: 'ts',
      }));
    },
  }],
});
const outputs = new Map([['framework.js', result.outputFiles[0].contents]]);
for (const name of ['live2dcubismcore.js', 'live2dcubismcore.d.ts']) {
  outputs.set(`core/${name}`, await readFile(path.join(source, 'Core', name)));
}
for (const name of (await readdir(path.join(source, 'Framework/Shaders/WebGL'))).sort()) {
  outputs.set(`shaders/${name}`, await readFile(path.join(source, 'Framework/Shaders/WebGL', name)));
}
for (const [name, relative] of [
  ['SDK-LICENSE.md', 'LICENSE.md'], ['SDK-NOTICE.md', 'NOTICE.md'],
  ['Framework-LICENSE.md', 'Framework/LICENSE.md'], ['Core-LICENSE.md', 'Core/LICENSE.md'],
  ['Core-RedistributableFiles.txt', 'Core/RedistributableFiles.txt'],
]) outputs.set(`licenses/${name}`, await readFile(path.join(source, relative)));
const manifest = {
  sdk: 'Cubism SDK for Web 5-r.5', editorCompatibility: '5.3',
  source: 'https://www.live2d.com/en/sdk/download/web/',
  frameworkSource: 'https://github.com/Live2D/CubismWebFramework',
  adapter: 'Inject bundled shader sources without network; abort shader loading on disposal; release individual WebGL contexts.',
  upstreamFiles: await sourceHashes(source),
  files: Object.fromEntries([...outputs].map(([name, bytes]) => [name, digest(bytes)])),
};
outputs.set('sdk-manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
for (const [name, bytes] of outputs) {
  const destination = path.join(target, name);
  if (check) {
    const previous = await readFile(destination);
    if (!Buffer.from(bytes).equals(previous)) throw new Error(`Live2D resource differs: ${name}`);
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}
console.log(`Codia Live2D SDK ${check ? 'verified' : 'prepared'}: ${outputs.size} local resources`);
