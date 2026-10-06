import { createServer } from 'node:http';
import { readFile, stat, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { handleEvidence } from './evidence-store.mjs';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(sourceRoot, '../../../..');
const sdkRoot = path.join(repoRoot, '.local-tools/live2d/sdk/CubismSdkForWeb-5-r.5');
const outputRoot = path.join(repoRoot, '.local-tools/live2d/preview-build');
const args = process.argv.slice(2);
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const modelFile = path.resolve(repoRoot, argument('--model', 'design/codia/live2d/export/Codia.model3.json'));
const modelRoot = path.dirname(modelFile);
await stat(path.join(sdkRoot, 'Core/live2dcubismcore.min.js')).catch(() => {
  throw new Error('缺少本地官方 SDK，请先下载并解压 Cubism SDK for Web R5。');
});
await mkdir(outputRoot, { recursive: true });
await build({
  absWorkingDir: sourceRoot,
  entryPoints: ['app.ts'], outfile: path.join(outputRoot, 'app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true,
  alias: { '@cubism': path.join(sdkRoot, 'Framework/src') },
  tsconfig: path.join(sourceRoot, 'tsconfig.json'),
});
if (args.includes('--build-only')) {
  console.log(`Preview built: ${outputRoot}`);
} else {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.frag': 'text/plain', '.vert': 'text/plain', '.map': 'application/json' };
  const mounts = [
    ['/sdk-core/', path.join(sdkRoot, 'Core')],
    ['/shaders/', path.join(sdkRoot, 'Framework/Shaders/WebGL')],
    ['/model/', modelRoot],
  ];
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'");
      if (await handleEvidence(request, response, { pathname,
        origin: `http://127.0.0.1:${server.address().port}`,
        directory: path.join(repoRoot, 'design/codia/live2d/validation/visual'), modelFile,
      })) return;
      if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (pathname === '/preview-config.json') {
        const exists = await stat(modelFile).then(value => value.isFile()).catch(() => false);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ modelExists: exists, modelUrl: `/model/${encodeURIComponent(path.basename(modelFile))}` }));
        return;
      }
      let filename;
      if (pathname === '/' || pathname === '/index.html') filename = path.join(sourceRoot, 'index.html');
      else if (pathname === '/review.html' || pathname === '/review.js') filename = path.join(sourceRoot, pathname.slice(1));
      else if (pathname === '/app.js' || pathname === '/app.js.map') filename = path.join(outputRoot, pathname.slice(1));
      else {
        const mount = mounts.find(([prefix]) => pathname.startsWith(prefix));
        if (!mount) { response.writeHead(404).end('Not found'); return; }
        const base = await realpath(mount[1]);
        filename = await realpath(path.resolve(base, pathname.slice(mount[0].length)));
        const relative = path.relative(base, filename);
        if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end('Forbidden'); return; }
      }
      const contents = await readFile(filename);
      response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
      response.end(contents);
    } catch (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Local asset unavailable');
    }
  });
  const port = Number(argument('--port', '0'));
  server.listen(port, '127.0.0.1', async () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    await writeFile(path.join(outputRoot, 'server.json'), JSON.stringify({ url, modelFile, pid: process.pid }, null, 2));
    console.log(`Codia Live2D preview: ${url}\nModel: ${modelFile}\nAll assets are local. No model provider requests are made.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
