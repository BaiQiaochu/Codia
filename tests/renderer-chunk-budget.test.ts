import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { auditRendererChunkBudgets, rendererHtmlEntries } from "./helpers/renderer-chunk-budget.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ASSETS_DIR = path.join(ROOT, "desktop", "dist-renderer", "assets");
const MAX_RENDERER_JS_CHUNK_BYTES = 500 * 1024;
const KNOWN_LAZY_CHUNK_LIMITS = [
  { pattern: /^editor-markdown-support-[\w-]+\.js$/, maxBytes: 650 * 1024 },
  { pattern: /^mermaid-parser-vendor-[\w-]+\.js$/, maxBytes: 650 * 1024 },
  { pattern: /^ocr-opencv-vendor-[\w-]+\.js$/, maxBytes: 11 * 1024 * 1024 },
  { pattern: /^settings-core-[\w-]+\.js$/, maxBytes: 600 * 1024 },
];

function getChunkBudget(name) {
  const knownLazyChunk = KNOWN_LAZY_CHUNK_LIMITS.find(({ pattern }) => pattern.test(name));
  return knownLazyChunk?.maxBytes ?? MAX_RENDERER_JS_CHUNK_BYTES;
}

describe("renderer chunk budget", () => {
  it("keeps built renderer JavaScript chunks below the Vite warning threshold", () => {
    if (!fs.existsSync(ASSETS_DIR)) {
      console.warn("[renderer-chunk-budget] dist-renderer assets missing; run npm run build:renderer for a strict check.");
      return;
    }

    const chunks = new Map(fs.readdirSync(ASSETS_DIR)
      .filter(name => name.endsWith('.js'))
      .map(name => [name, fs.readFileSync(path.join(ASSETS_DIR, name), 'utf8')]));
    const rendererDir = path.dirname(ASSETS_DIR);
    const htmlFiles = fs.readdirSync(rendererDir).filter(name => name.endsWith('.html'))
      .map(name => fs.readFileSync(path.join(rendererDir, name), 'utf8'));
    const modelDir = path.join(ROOT, 'desktop/src/assets/codia/live2d/model');
    const result = auditRendererChunkBudgets({
      chunks,
      entryChunks: rendererHtmlEntries(htmlFiles, chunks),
      defaultBudget: MAX_RENDERER_JS_CHUNK_BYTES,
      getBudget: getChunkBudget,
      modelAssets: [
        { source: fs.readFileSync(path.join(modelDir, 'Codia.moc3')), mime: 'application/octet-stream', maxSourceBytes: 44 * 1024 },
        { source: fs.readFileSync(path.join(modelDir, 'Codia.4096/texture_00.png')), mime: 'image/png', maxSourceBytes: 2 * 1024 * 1024 },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.oversized).toEqual([]);
    expect(result.live2d).toHaveLength(1);
  });
});


// These controls run even before a renderer build exists. They prove the asset
// accounting cannot become a broad runtime-name exception or hide code bloat.
describe('offline Live2D renderer budget accounting', () => {
  const assets = [
    { source: Buffer.from('MOC3 synthetic model'), mime: 'application/octet-stream', maxSourceBytes: 128 },
    { source: Buffer.from('synthetic PNG bytes'), mime: 'image/png', maxSourceBytes: 128 },
  ];
  const payload = assets.map((asset, index) => `const data${index}="data:${asset.mime};base64,${asset.source.toString('base64')}";`).join('');
  const runtime = `${payload}export function createCodiaLive2D() { return [data0, data1]; }`;
  function check(source = runtime, entry = 'export const load=()=>import("./runtime-fixture.js");', extraChunks: Array<[string, string]> = [], modelAssets = assets) {
    return auditRendererChunkBudgets({
      chunks: new Map([['entry.js', entry], ['runtime-fixture.js', source], ...extraChunks]),
      entryChunks: ['entry.js'], modelAssets, defaultBudget: 512, getBudget: () => 512,
    });
  }
  it('accounts only the exact base64 payload lengths of a genuinely lazy model runtime', () => {
    const result = check();
    expect(result.errors).toEqual([]);
    expect(result.oversized).toEqual([]);
    expect(result.live2d[0].codeBytes).toBe(Buffer.byteLength(runtime) - assets.reduce((sum, asset) => sum + asset.source.toString('base64').length, 0));
  });
  it('rejects changed or additional data URIs instead of subtracting them', () => {
    expect(check(runtime.replace(assets[0].source.toString('base64'), Buffer.from('unknown model').toString('base64'))).errors).not.toEqual([]);
    expect(check(`${runtime}const extra="data:text/plain;base64,YmxvYXQ=";`).errors).not.toEqual([]);
    expect(check(`${runtime}const duplicate="data:${assets[0].mime};base64,${assets[0].source.toString('base64')}";`).errors).not.toEqual([]);
  });
  it('rejects authoritative assets above their explicit raw-byte bound', () => {
    expect(check(runtime, undefined, [], assets.map(asset => ({ ...asset, maxSourceBytes: 1 }))).errors).toContain('runtime-fixture.js: authoritative offline model exceeds its explicit asset bound');
  });
  it('keeps the original code budget after subtracting only the known payload bytes', () => {
    expect(check(`${runtime}const unexpected="${'x'.repeat(600)}";`).oversized).toHaveLength(1);
  });
  it('rejects startup imports even if a redundant dynamic import also exists', () => {
    expect(check(runtime, 'import "./runtime-fixture.js"; export const load=()=>import("./runtime-fixture.js");').errors).toContain('runtime-fixture.js: Live2D model must not be in the initial static/modulepreload graph');
    expect(check(runtime, 'import "./bridge.js"; export const load=()=>import("./runtime-fixture.js");', [['bridge.js', 'import "./runtime-fixture.js";']]).errors).toContain('runtime-fixture.js: Live2D model must not be in the initial static/modulepreload graph');
    for (const reference of ['/assets/runtime-fixture.js', './runtime-fixture.js?version=1', './runtime-fixture.js#asset', './runtime%2Dfixture.js']) {
      expect(check(runtime, `import "${reference}"; export const load=()=>import("./runtime-fixture.js");`).errors).toContain('runtime-fixture.js: Live2D model must not be in the initial static/modulepreload graph');
    }
  });
  it('treats modulepreload links as startup inclusion', () => {
    const chunks = new Map([['entry.js', ''], ['runtime-fixture.js', runtime]]);
    expect(rendererHtmlEntries('<script type="module" src="./assets/entry.js"></script><link rel="modulepreload" href="./assets/runtime-fixture.js">'.split('\n'), chunks)).toEqual(['entry.js', 'runtime-fixture.js']);
    expect(rendererHtmlEntries(['<link rel="MODULEPRELOAD" href="./assets/runtime-fixture.js">'], chunks)).toEqual(['runtime-fixture.js']);
  });
  it('does not confuse data-src/data-href with actual HTML startup references', () => {
    const chunks = new Map([['entry.js', ''], ['runtime-fixture.js', runtime]]);
    const html = '<script data-src="./assets/runtime-fixture.js" src=./assets/entry.js></script><link data-href="./assets/runtime-fixture.js" rel="modulepreload" href="./assets/entry.js">';
    expect(rendererHtmlEntries([html], chunks)).toEqual(['entry.js']);
  });
  it('rejects an orphan or merely static-only runtime without a real lazy edge', () => {
    expect(check(runtime, 'export const entry=true;').errors).toContain('runtime-fixture.js: Live2D runtime is not reachable from an HTML entry');
    expect(check(runtime, 'import "./runtime-fixture.js";').errors).toContain('runtime-fixture.js: Live2D runtime has no explicit lazy import');
  });
  it('does not exempt another large runtime-named chunk', () => {
    expect(check(runtime, undefined, [['runtime-unrelated.js', `export const unexpected="${'x'.repeat(600)}";`]]).oversized).toEqual([expect.objectContaining({ name: 'runtime-unrelated.js', codeBytes: expect.any(Number), maxBytes: 512 })]);
  });
});
