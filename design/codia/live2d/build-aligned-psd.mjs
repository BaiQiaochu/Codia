#!/usr/bin/env node
// Mechanical source-pixel partitioning only. Every layer retains original coordinates.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const requireAuthoring = createRequire(path.resolve(directory, '../../../.local-tools/live2d/authoring/package.json'));
const { PNG } = requireAuthoring('pngjs');
const { writePsdBuffer, readPsd, initializeCanvas } = requireAuthoring('ag-psd');
const sha256 = data => createHash('sha256').update(data).digest('hex');
const pixelData = (width, height, data = new Uint8ClampedArray(width * height * 4)) => ({ width, height, data });
initializeCanvas(() => { throw new Error('This script does not use a canvas.'); }, pixelData);

function contains(polygon, x, y) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function leaves(children) {
  return children.flatMap(child => child.children ? leaves(child.children) : [child]);
}

async function main() {
  const manifestPath = path.join(directory, 'source-separation.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const sourcePath = path.resolve(directory, manifest.source);
  const sourceBytes = await fs.readFile(sourcePath);
  const source = PNG.sync.read(sourceBytes);
  const { width, height } = source;
  if (manifest.version !== 1 || source.depth !== 8 || width !== manifest.canvas.width || height !== manifest.canvas.height) {
    throw new Error('Manifest version, source bit depth or original canvas dimensions do not match.');
  }
  if (manifest.regions.length > 16) throw new Error('Keep at most 16 selected layers plus the retained base.');
  const names = new Set();
  const regions = manifest.regions.map(region => {
    if (!region.name || names.has(region.name)) throw new Error('Each region must have a unique name.');
    names.add(region.name);
    if (!Array.isArray(region.polygons) || !region.polygons.length) throw new Error(`Missing polygons for ${region.name}`);
    for (const polygon of region.polygons) {
      if (!Array.isArray(polygon) || polygon.length < 3) throw new Error(`Invalid polygon for ${region.name}`);
      for (const point of polygon) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
          || point[0] < 0 || point[0] > width || point[1] < 0 || point[1] > height) throw new Error(`Invalid original-canvas point for ${region.name}`);
      }
    }
    return { ...region, imageData: pixelData(width, height), pixelCount: 0 };
  });
  const base = { name: 'Base_Unassigned', left: 0, top: 0, opacity: 1, blendMode: 'normal',
    imageData: pixelData(width, height, new Uint8ClampedArray(source.data)) };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (source.data[offset + 3] === 0) continue; // Keep invisible original RGB in the base.
      const region = regions.find(item => item.polygons.some(polygon => contains(polygon, x + 0.5, y + 0.5)));
      if (!region) continue;
      region.imageData.data.set(source.data.subarray(offset, offset + 4), offset);
      base.imageData.data.fill(0, offset, offset + 4);
      region.pixelCount++;
    }
  }
  const children = [];
  const groups = new Map();
  for (const region of regions) {
    if (!region.pixelCount) throw new Error(`Region contains no visible original pixels: ${region.name}`);
    if (!groups.has(region.group)) {
      const group = { name: region.group, opened: true, blendMode: 'pass through', children: [] };
      children.push(group);
      groups.set(region.group, group);
    }
    groups.get(region.group).children.push({ name: region.name, left: 0, top: 0, opacity: 1,
      blendMode: 'normal', imageData: region.imageData });
  }
  children.push(base);
  const psd = writePsdBuffer({ width, height, bitsPerChannel: 8, colorMode: 3, children,
    imageData: pixelData(width, height, new Uint8ClampedArray(source.data)) },
  { noBackground: true, trimImageData: false, generateThumbnail: false });
  const decoded = readPsd(psd, { useImageData: true, skipThumbnail: true });
  const decodedLayers = leaves(decoded.children);
  const decodedBase = decodedLayers.find(layer => layer.name === 'Base_Unassigned');
  const reconstructed = new Uint8ClampedArray(decodedBase.imageData.data);
  const ownership = new Uint8Array(width * height);
  for (let pixel = 0; pixel < ownership.length; pixel++) if (reconstructed[pixel * 4 + 3]) ownership[pixel]++;
  let overlapPixels = 0;
  for (const layer of decodedLayers) {
    if (layer === decodedBase) continue;
    if (layer.left !== 0 || layer.top !== 0 || layer.imageData.width !== width || layer.imageData.height !== height) {
      throw new Error(`Layer moved or resized during PSD encoding: ${layer.name}`);
    }
    const data = layer.imageData.data;
    for (let offset = 0; offset < data.length; offset += 4) {
      if (!data[offset + 3]) continue;
      if (ownership[offset / 4]++ !== 0) overlapPixels++;
      // Each visible pixel has exactly one owner. Source-over a transparent pixel
      // preserves that owner's original straight-alpha RGBA without quantization.
      reconstructed.set(data.subarray(offset, offset + 4), offset);
    }
  }
  let visiblePixelDifferences = 0;
  let alphaDifferences = 0;
  let invisibleRgbDifferences = 0;
  let totalRgbaPixelDifferences = 0;
  for (let offset = 0; offset < source.data.length; offset += 4) {
    const rgbDiff = source.data[offset] !== reconstructed[offset] || source.data[offset + 1] !== reconstructed[offset + 1]
      || source.data[offset + 2] !== reconstructed[offset + 2];
    const alphaDiff = source.data[offset + 3] !== reconstructed[offset + 3];
    if (alphaDiff) alphaDifferences++;
    if (source.data[offset + 3] > 0 && (rgbDiff || alphaDiff)) visiblePixelDifferences++;
    if (source.data[offset + 3] === 0 && rgbDiff) invisibleRgbDifferences++;
    if (rgbDiff || alphaDiff) totalRgbaPixelDifferences++;
  }
  if (overlapPixels || visiblePixelDifferences || alphaDifferences || invisibleRgbDifferences) {
    throw new Error(`Source reconstruction failed: ${JSON.stringify({ overlapPixels, visiblePixelDifferences, alphaDifferences, invisibleRgbDifferences })}`);
  }
  const output = path.join(directory, 'codia-source-aligned.psd');
  const preview = path.join(directory, 'codia-source-aligned.preview.png');
  const validationPath = path.join(directory, 'codia-source-aligned.validation.json');
  const validation = { status: 'visible-pixel separation draft; not rigged', source: sourcePath,
    sourceFileSha256: sha256(sourceBytes), sourceRgbaSha256: sha256(source.data), reconstructedRgbaSha256: sha256(reconstructed),
    width, height, layerCount: decodedLayers.length, groupCount: groups.size,
    originalCoordinatesPreserved: true, scaledOrTranslated: false,
    overlapPixels, visiblePixelDifferences, alphaDifferences, invisibleRgbDifferences, totalRgbaPixelDifferences,
    verification: 'Reconstructed original pixels from decoded PSD layers; every visible pixel has at most one nonzero-alpha owner. Invisible original RGB retained in base.',
    note: 'Merged PSD preview may use white-matte encoding for translucent pixels; exact verification uses decoded image layers, not the merged preview channel.',
    layers: regions.map(({ imageData, ...region }) => region),
    cubismImport: 'not verified', rigged: false };
  await fs.writeFile(output, psd);
  await fs.writeFile(preview, PNG.sync.write({ width, height, data: Buffer.from(reconstructed) }, { colorType: 6 }));
  await fs.writeFile(validationPath, `${JSON.stringify(validation, null, 2)}\n`);
  console.log(JSON.stringify({ output, preview, validation: validationPath, layerCount: decodedLayers.length,
    overlapPixels, visiblePixelDifferences, alphaDifferences, invisibleRgbDifferences, totalRgbaPixelDifferences }, null, 2));
}

main().catch(error => { console.error(`Aligned PSD packaging failed: ${error.message}`); process.exitCode = 1; });
