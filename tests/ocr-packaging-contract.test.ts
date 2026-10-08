import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('OCR packaging contract', () => {
  it('declares PaddleOCR.js as the embedded OCR runtime', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

    expect(pkg.dependencies).toHaveProperty('@paddleocr/paddleocr-js');
  });

  it('ships OCR models and ONNX Runtime wasm as local app resources', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    const resources = JSON.stringify(pkg.build?.extraResources || []);
    const winResources = JSON.stringify([
      ...(pkg.build?.extraResources || []),
      ...(pkg.build?.win?.extraResources || []),
    ]);
    const files = JSON.stringify(pkg.build?.files || []);

    expect(`${resources} ${files}`).toMatch(/ocr-runtime/i);
    expect(winResources).toMatch(/ocr-runtime/i);
    expect(winResources).toMatch(/dist-server/i);
    expect(`${resources} ${files}`).toMatch(/ocr/i);
    expect(files).not.toMatch(/vendor\/ocr-runtime/i);
    expect(pkg.scripts['build:win-release-resources']).toContain('node scripts/prepare-ocr-runtime.mjs');
    expect(fs.existsSync(path.resolve('scripts/prepare-ocr-runtime.mjs'))).toBe(true);
  });

  it('exposes a local HTTP OCR asset root through preload', () => {
    const preload = fs.readFileSync(path.resolve('desktop/preload.cjs'), 'utf8');

    expect(preload).toContain('getOcrAssetRoot');
    expect(preload).toContain('get-server-port');
    expect(preload).toContain('127.0.0.1');
    expect(preload).toContain('/ocr-runtime/');
    expect(preload).not.toContain('pathToFileUrl(root)');
    expect(preload).not.toContain('require("path")');
  });

  it('serves embedded OCR assets from the local server and keeps them public-static only', () => {
    const serverEntryPath = fs.existsSync(path.resolve('server/index.ts'))
      ? path.resolve('server/index.ts')
      : path.resolve('server/index.js');
    const routeSecurityPath = fs.existsSync(path.resolve('server/http/route-security.ts'))
      ? path.resolve('server/http/route-security.ts')
      : path.resolve('server/http/route-security.js');
    const server = fs.readFileSync(serverEntryPath, 'utf8');
    const routeSecurity = fs.readFileSync(routeSecurityPath, 'utf8');
    const route = fs.readFileSync(path.resolve('server/routes/ocr-runtime.ts'), 'utf8');

    expect(server).toContain('createOcrRuntimeRoute');
    expect(server).toContain('app.route("", createOcrRuntimeRoute');
    expect(routeSecurity).toContain('isOcrRuntimeRoute');
    expect(routeSecurity).toContain('/ocr-runtime/');
    expect(route).toContain('resolveExistingInside');
    expect(route).toContain('application/wasm');
    expect(route).toContain('application/x-tar');
  });

  it('patches PaddleOCR.js so Electron file windows can use local HTTP OCR assets', () => {
    const vite = fs.readFileSync(path.resolve('vite.config.ts'), 'utf8');

    expect(vite).toContain('patchPaddleOcrRendererRuntime');
    expect(vite).toContain('PaddleOCR.js file-origin guard is bypassed');
    expect(vite).toContain('globalThis.location.protocol === "file:"');
  });
});
