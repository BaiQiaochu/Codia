import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(root, 'scripts/fixtures/codia-live2d');
const outputRoot = path.join(root, '.local-tools/live2d/react-fixture');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const modelFile = path.resolve(root, option('--model', 'desktop/src/assets/codia/live2d/model/Codia.model3.json'));
await mkdir(outputRoot, { recursive: true });
await build({
  configFile: false, root: fixtureRoot, base: './', logLevel: 'warn', plugins: [react()],
  build: { outDir: outputRoot, emptyOutDir: false, target: 'es2022', sourcemap: true },
});
if (args.includes('--build-only')) {
  console.log(`Codia React fixture built: ${outputRoot}`);
} else {
  await stat(modelFile);
  const mounts = [
    ['/fixture-model/', path.dirname(modelFile)],
    ['/fixture-shaders/', path.join(root, 'desktop/src/assets/codia/live2d/shaders')],
    ['/', outputRoot],
  ];
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.frag': 'text/plain', '.vert': 'text/plain' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      // Allows an Electron file:// fixture to fetch these read-only local files.
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (pathname === '/fixture-config.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ modelUrl: `/fixture-model/${encodeURIComponent(path.basename(modelFile))}`, shaderPath: '/fixture-shaders/' }));
        return;
      }
      const [prefix, directory] = mounts.find(([prefix]) => pathname.startsWith(prefix));
      const base = await realpath(directory);
      const file = await realpath(path.resolve(base, pathname === '/' ? 'index.html' : pathname.slice(prefix.length)));
      const relative = path.relative(base, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
      response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Fixture resource unavailable'); }
  });
  server.listen(Number(option('--port', '0')), '127.0.0.1', async () => {
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;
    const fileUrl = `${pathToFileURL(path.join(outputRoot, 'index.html')).href}?assetPort=${port}`;
    await writeFile(path.join(outputRoot, 'server.json'), JSON.stringify({ url, fileUrl, modelFile, pid: process.pid }, null, 2));
    console.log(`Codia React WebGL2 fixture: ${url}\nElectron file URL: ${fileUrl}\nModel: ${modelFile}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
