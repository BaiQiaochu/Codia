import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('preview retains the same premultiplied mipmap sampling as the main runtime', () => {
  const source = readFileSync(new URL('./app.ts', import.meta.url), 'utf8');
  const upload = source.slice(source.indexOf('async function addTexture('), source.indexOf('function resize()'));
  assert.match(upload, /premultiplyAlpha: 'premultiply'/);
  assert.match(upload, /TEXTURE_MIN_FILTER, gl!\.LINEAR_MIPMAP_LINEAR/);
  assert.match(upload, /TEXTURE_MAG_FILTER, gl!\.LINEAR/);
  const image = upload.indexOf('gl!.texImage2D(');
  const mipmaps = upload.indexOf('gl!.generateMipmap(gl!.TEXTURE_2D)');
  assert.ok(image >= 0 && mipmaps > image);
  assert.ok(mipmaps < upload.indexOf('gl!.bindTexture(gl!.TEXTURE_2D, null)'));
});
