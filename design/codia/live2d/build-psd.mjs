#!/usr/bin/env node
/**
 * Package approved transparent PNG atlas regions as a layered Cubism source PSD.
 * Only integer cropping, optional explicit geometric scaling, placement and
 * source-over preview compositing are done. No repainting/model generation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const dependencyDir = path.join(repoRoot, '.local-tools/live2d/authoring');

function usage() {
  console.log(`Usage: node design/codia/live2d/build-psd.mjs --layout <layout.json> --out <model.psd>
  [--atlas <atlas.png>] [--preview <preview.png>] [--layers-dir <directory>] [--overwrite]

Install isolated dependencies first:
  npm install --prefix .local-tools/live2d/authoring --save-exact --no-audit --no-fund ag-psd@31.0.2 pngjs@7.0.0 sharp@0.35.5

The layout uses top-to-bottom Photoshop layer order. Atlas paths in the layout
are relative to its JSON file. CLI paths are relative to the current directory.
See PSD-AUTHORING.md for the layout format.`);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--overwrite') { result.overwrite = true; continue; }
    if (!['--layout', '--out', '--atlas', '--preview', '--layers-dir'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    result[arg.slice(2)] = path.resolve(value);
  }
  if (!result.layout || !result.out) throw new Error('--layout and --out are required.');
  if (path.extname(result.out).toLowerCase() !== '.psd') throw new Error('--out must end in .psd');
  return result;
}

function integer(value, label, min = 0, max = 8192) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function hash(data) { return createHash('sha256').update(data).digest('hex'); }

async function ensureNewFile(filename, overwrite) {
  if (overwrite) return;
  try { await fs.access(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite ${filename}; use --overwrite deliberately.`);
}

function rgbaImage(width, height, data) {
  return { width, height, data: data ?? new Uint8ClampedArray(width * height * 4) };
}

function cropImage(source, crop) {
  const result = rgbaImage(crop.width, crop.height);
  const rowBytes = crop.width * 4;
  for (let row = 0; row < crop.height; row++) {
    const start = ((crop.y + row) * source.width + crop.x) * 4;
    result.data.set(source.data.subarray(start, start + rowBytes), row * rowBytes);
  }
  return result;
}

function compositeLayer(destination, source, left, top) {
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const src = (y * source.width + x) * 4;
      const dst = ((top + y) * destination.width + left + x) * 4;
      const sourceAlpha = source.data[src + 3] / 255;
      if (sourceAlpha === 0) continue;
      const destinationAlpha = destination.data[dst + 3] / 255;
      const alpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel++) {
        destination.data[dst + channel] = Math.round((source.data[src + channel] * sourceAlpha
          + destination.data[dst + channel] * destinationAlpha * (1 - sourceAlpha)) / alpha);
      }
      destination.data[dst + 3] = Math.round(alpha * 255);
    }
  }
}

function compositeTree(destination, children, ancestorHidden = false) {
  // ag-psd and the manifest both store the topmost item first.
  for (const child of [...children].reverse()) {
    const hidden = ancestorHidden || child.hidden;
    if (hidden) continue;
    if (child.children) compositeTree(destination, child.children, hidden);
    else compositeLayer(destination, child.imageData, child.left, child.top);
  }
}

function verifyTree(expected, actual, prefix = '') {
  if (expected.length !== actual?.length) throw new Error(`PSD read-back layer count differs at ${prefix || 'root'}.`);
  for (let index = 0; index < expected.length; index++) {
    const before = expected[index];
    const after = actual[index];
    const label = `${prefix}/${before.name}`;
    if (before.name !== after.name || Boolean(before.hidden) !== Boolean(after.hidden)) {
      throw new Error(`PSD read-back name/visibility differs for ${label}.`);
    }
    if (before.children) { verifyTree(before.children, after.children, label); continue; }
    if (before.left !== after.left || before.top !== after.top
      || before.imageData.width !== after.imageData?.width || before.imageData.height !== after.imageData?.height
      || !Buffer.from(before.imageData.data).equals(Buffer.from(after.imageData.data))) {
      throw new Error(`PSD read-back did not preserve placement/RGBA pixels for ${label}.`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  let writer, PNG, sharp;
  try {
    const requireAuthoring = createRequire(path.join(dependencyDir, 'package.json'));
    writer = requireAuthoring('ag-psd');
    ({ PNG } = requireAuthoring('pngjs'));
    sharp = requireAuthoring('sharp');
  } catch (error) {
    throw new Error(`PSD dependencies are missing in ${dependencyDir}. Run the isolated install command shown by --help. ${error.message}`);
  }
  writer.initializeCanvas(
    () => { throw new Error('Unexpected canvas operation; this packer uses raw RGBA only.'); },
    (width, height) => rgbaImage(width, height),
  );

  const layout = JSON.parse((await fs.readFile(args.layout, 'utf8')).replace(/^\uFEFF/, ''));
  if (layout.version !== 1) throw new Error('layout.version must be 1.');
  if (layout.order && layout.order !== 'top-to-bottom') throw new Error('Only top-to-bottom layer order is supported.');
  const width = integer(layout.canvas?.width, 'canvas.width', 1);
  const height = integer(layout.canvas?.height, 'canvas.height', 1);
  if (width * height > 16_777_216) throw new Error('Canvas exceeds the 16 megapixel authoring limit.');
  const layoutDir = path.dirname(args.layout);
  const atlasCache = new Map();
  const layerReport = [];
  const pngExports = [];
  let layerCount = 0;
  let groupCount = 0;

  async function getAtlas(spec) {
    const filename = spec.atlas ? path.resolve(layoutDir, spec.atlas)
      : args.atlas ?? (layout.atlas ? path.resolve(layoutDir, layout.atlas) : undefined);
    if (!filename) throw new Error('Provide --atlas, layout.atlas, or atlas on every image layer.');
    if (!atlasCache.has(filename)) {
      const bytes = await fs.readFile(filename);
      const decoded = PNG.sync.read(bytes);
      if (decoded.width * decoded.height > 33_554_432) throw new Error(`Atlas exceeds 32 megapixels: ${filename}`);
      if (decoded.depth !== 8) throw new Error(`Only 8-bit PNG atlases are accepted: ${filename}`);
      let transparent = false;
      for (let offset = 3; offset < decoded.data.length; offset += 4) {
        if (decoded.data[offset] < 255) { transparent = true; break; }
      }
      if (!transparent) throw new Error(`Atlas has no transparent pixels. Provide real RGBA cutouts: ${filename}`);
      atlasCache.set(filename, { image: decoded, sha256: hash(bytes) });
    }
    return { filename, ...atlasCache.get(filename) };
  }

  async function buildLayers(specs, prefix = '', depth = 0) {
    if (!Array.isArray(specs) || !specs.length) throw new Error(`Expected a non-empty layer array at ${prefix || 'root'}.`);
    if (depth > 12) throw new Error('Layer nesting exceeds 12 groups.');
    const names = new Set();
    const result = [];
    for (const spec of specs) {
      if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) throw new Error('Each layer/group needs a non-empty name.');
      if (names.has(spec.name)) throw new Error(`Duplicate sibling name: ${prefix}/${spec.name}`);
      names.add(spec.name);
      const fullName = `${prefix}/${spec.name}`;
      if (spec.hidden !== undefined && typeof spec.hidden !== 'boolean') throw new Error(`hidden must be boolean: ${fullName}`);
      if (spec.children) {
        if (spec.crop || spec.position) throw new Error(`A group cannot have crop/position: ${fullName}`);
        if (++groupCount > 128) throw new Error('More than 128 groups are not supported.');
        result.push({ name: spec.name, hidden: spec.hidden ?? false, opened: true,
          blendMode: 'pass through', children: await buildLayers(spec.children, fullName, depth + 1) });
        continue;
      }
      if (++layerCount > 256) throw new Error('More than 256 image layers are not supported.');
      const atlas = await getAtlas(spec);
      const crop = {
        x: integer(spec.crop?.x, `${fullName}.crop.x`, 0, atlas.image.width),
        y: integer(spec.crop?.y, `${fullName}.crop.y`, 0, atlas.image.height),
        width: integer(spec.crop?.width, `${fullName}.crop.width`, 1, atlas.image.width),
        height: integer(spec.crop?.height, `${fullName}.crop.height`, 1, atlas.image.height),
      };
      if (crop.x + crop.width > atlas.image.width || crop.y + crop.height > atlas.image.height) {
        throw new Error(`Crop leaves its atlas: ${fullName}`);
      }
      const left = integer(spec.position?.x, `${fullName}.position.x`, 0, width);
      const top = integer(spec.position?.y, `${fullName}.position.y`, 0, height);
      const targetWidth = spec.size ? integer(spec.size.width, `${fullName}.size.width`, 1, width) : crop.width;
      const targetHeight = spec.size ? integer(spec.size.height, `${fullName}.size.height`, 1, height) : crop.height;
      if (left + targetWidth > width || top + targetHeight > height) throw new Error(`Placed layer leaves canvas: ${fullName}`);
      let imageData = cropImage(atlas.image, crop);
      if (targetWidth !== crop.width || targetHeight !== crop.height) {
        const resized = await sharp(Buffer.from(imageData.data), { raw: { width: crop.width, height: crop.height, channels: 4 } })
          .resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
        imageData = rgbaImage(targetWidth, targetHeight, new Uint8ClampedArray(resized));
      }
      let nonzeroAlpha = 0;
      for (let offset = 3; offset < imageData.data.length; offset += 4) if (imageData.data[offset]) nonzeroAlpha++;
      if (!nonzeroAlpha) throw new Error(`Crop contains no visible pixels: ${fullName}`);
      const layer = { name: spec.name, left, top, hidden: spec.hidden ?? false,
        opacity: 1, blendMode: 'normal', imageData };
      result.push(layer);
      layerReport.push({ path: fullName, atlas: atlas.filename, crop, position: { x: left, y: top },
        size: { width: targetWidth, height: targetHeight },
        hidden: layer.hidden, visiblePixelCount: nonzeroAlpha, rgbaSha256: hash(imageData.data) });
      if (args['layers-dir']) {
        const safeName = fullName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
        pngExports.push({ filename: path.join(args['layers-dir'], `${String(layerCount).padStart(3, '0')}${safeName}.png`), imageData });
      }
    }
    return result;
  }

  const children = await buildLayers(layout.layers);
  const imageData = rgbaImage(width, height);
  compositeTree(imageData, children);
  const document = { width, height, bitsPerChannel: 8, colorMode: 3, children, imageData };
  const psdBuffer = writer.writePsdBuffer(document, { noBackground: true, trimImageData: false, generateThumbnail: false });
  const parsed = writer.readPsd(psdBuffer, { useImageData: true, skipThumbnail: true });
  if (parsed.width !== width || parsed.height !== height) throw new Error('PSD dimensions changed during read-back.');
  verifyTree(children, parsed.children);
  // PSD's merged image uses a white matte and loses RGB precision at low alpha.
  // Layer RGBA above is exact; verify merged alpha and fully opaque RGB exactly.
  let compositeMattePixels = 0;
  for (let offset = 0; offset < imageData.data.length; offset += 4) {
    const alpha = imageData.data[offset + 3];
    if (alpha !== parsed.imageData.data[offset + 3]) throw new Error('Composite alpha changed during read-back.');
    if (alpha === 255) {
      for (let channel = 0; channel < 3; channel++) {
        if (imageData.data[offset + channel] !== parsed.imageData.data[offset + channel]) throw new Error('Opaque composite color changed during read-back.');
      }
    } else if (alpha !== 0) compositeMattePixels++;
  }

  const preview = args.preview ?? args.out.replace(/\.psd$/i, '.preview.png');
  const reportPath = args.out.replace(/\.psd$/i, '.layers.json');
  const outputs = [args.out, preview, reportPath, ...pngExports.map(item => item.filename)];
  if (new Set(outputs.map(name => name.toLowerCase())).size !== outputs.length) throw new Error('Output paths must be distinct.');
  const inputPaths = new Set([args.layout, ...atlasCache.keys()].map(name => name.toLowerCase()));
  for (const output of outputs) {
    if (inputPaths.has(output.toLowerCase())) throw new Error(`Output would overwrite an input: ${output}`);
    await ensureNewFile(output, args.overwrite);
  }
  for (const output of outputs) await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(args.out, psdBuffer);
  await fs.writeFile(preview, PNG.sync.write({ width, height, data: Buffer.from(imageData.data) }, { colorType: 6 }));
  for (const item of pngExports) await fs.writeFile(item.filename, PNG.sync.write({ ...item.imageData, data: Buffer.from(item.imageData.data) }, { colorType: 6 }));
  const report = { version: 1, layout: args.layout, output: args.out, preview, canvas: { width, height },
    layerCount, groupCount, order: 'top-to-bottom', psdSha256: hash(psdBuffer),
    validation: 'PSD decoded and every layer name, position, visibility and RGBA pixel matched. Composite alpha and opaque RGB matched; translucent merged RGB uses PSD white-matte encoding.',
    compositeMattePixels,
    cubismImport: 'Not verified in Cubism Editor by this script.',
    atlases: [...atlasCache].map(([filename, value]) => ({ filename, sha256: value.sha256 })), layers: layerReport };
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ psd: args.out, preview, report: reportPath, layerCount, groupCount,
    dimensions: `${width}x${height}`, bytes: psdBuffer.length, rgbaRoundTrip: 'passed' }, null, 2));
}

main().catch(error => { console.error(`PSD packaging failed: ${error.message}`); process.exitCode = 1; });
