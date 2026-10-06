#!/usr/bin/env node
// Replace only existing eye-opening mask pixels; never paint or move artwork.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), options = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index], value = args[index + 1];
  if (!['--base', '--out', '--mask-dir', '--variant'].includes(flag) || !value || value.startsWith('--') || options[flag]) {
    throw new Error('Usage: node build-rig-masks-v3.mjs [--base input.psd] [--out output-prefix] [--mask-dir directory] [--variant hard|1px|2px]');
  }
  options[flag] = value;
}
const inputPath = options['--base'] ? path.resolve(options['--base']) : path.join(directory, 'codia-rig-repair-source.psd');
const outputPrefix = options['--out'] ? path.resolve(options['--out']) : path.join(directory, 'codia-rig-repair-masks-v3');
const maskDirectory = options['--mask-dir'] ? path.resolve(options['--mask-dir']) : path.join(directory, 'source/codia-eye-patches-v3');
const variant = options['--variant'] ?? '2px';
if (!['hard', '1px', '2px'].includes(variant)) throw new Error('Unknown frozen mask variant.');
const requireAuthoring = createRequire(path.resolve(directory, '../../../.local-tools/live2d/authoring/package.json'));
const { PNG } = requireAuthoring('pngjs');
const { readPsd, writePsdBuffer, initializeCanvas } = requireAuthoring('ag-psd');
const imageData = (width, height, data = new Uint8ClampedArray(width * height * 4)) => ({ width, height, data });
initializeCanvas(() => { throw new Error('Canvas is not used.'); }, imageData);
const hash = data => createHash('sha256').update(data).digest('hex');
const facePath = 'BodyGroup/HeadGroup/Face';
const maskNames = new Set(['EyeLeft_OpeningMask', 'EyeRight_OpeningMask']);
const hierarchy = children => children.map(node => ({ name: node.name,
  ...(node.children ? { children: hierarchy(node.children) } : {}) }));
const properties = node => ({ name: node.name, left: node.left, top: node.top,
  width: node.imageData.width, height: node.imageData.height,
  opacity: node.opacity ?? 1, hidden: Boolean(node.hidden), blendMode: node.blendMode ?? 'normal' });
const flatten = (children, prefix = '', opacity = 1, hidden = false) => children.flatMap(node => {
  const layerPath = prefix ? `${prefix}/${node.name}` : node.name;
  const effectiveOpacity = opacity * (node.opacity ?? 1), effectiveHidden = hidden || Boolean(node.hidden);
  return node.children ? flatten(node.children, layerPath, effectiveOpacity, effectiveHidden)
    : [{ node, path: layerPath, opacity: effectiveOpacity, hidden: effectiveHidden }];
});

function compose(entries, width, height) {
  const result = Buffer.alloc(width * height * 4);
  const retention = entries.find(entry => entry.node.name === 'Transparent_RGB_Retention');
  if (retention) result.set(retention.node.imageData.data);
  for (const { node, hidden, opacity } of entries.slice().reverse()) {
    if (hidden || opacity === 0 || maskNames.has(node.name)) continue;
    if (node.blendMode && node.blendMode !== 'normal') throw new Error(`Unsupported blend mode: ${node.name}`);
    const source = node.imageData.data;
    for (let offset = 0; offset < source.length; offset += 4) {
      if (!source[offset + 3]) continue;
      const a = source[offset + 3] / 255 * opacity, b = result[offset + 3] / 255;
      const combined = a + b * (1 - a);
      for (let channel = 0; channel < 3; channel++) {
        result[offset + channel] = Math.round((source[offset + channel] * a + result[offset + channel] * b * (1 - a)) / combined);
      }
      result[offset + 3] = Math.round(combined * 255);
    }
  }
  return result;
}

async function main() {
  const output = `${outputPrefix}.psd`, preview = `${outputPrefix}.neutral.png`;
  if (output.toLowerCase() === inputPath.toLowerCase()) throw new Error('Output must not overwrite input.');
  const inputBytes = await fs.readFile(inputPath);
  const trackedFiles = new Map([[inputPath, inputBytes]]);
  const psd = readPsd(inputBytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  const { width, height } = psd;
  if (width !== 1254 || height !== 1254) throw new Error('Expected the approved 1254 × 1254 source coordinates.');
  const originals = flatten(psd.children), originalHierarchy = hierarchy(psd.children);
  if (originals.length !== 17) throw new Error('Expected the 17-layer merged repair source.');
  const originalByPath = new Map(originals.map(entry => [entry.path,
    { rgba: Buffer.from(entry.node.imageData.data), properties: properties(entry.node) }]));
  const baseline = compose(originals, width, height), replacements = new Map();
  for (const side of ['Left', 'Right']) {
    const name = `Eye${side}_OpeningMask`, layerPath = `${facePath}/${name}`;
    const matches = originals.filter(entry => entry.path === layerPath);
    if (matches.length !== 1) throw new Error(`Expected exactly one existing mask: ${layerPath}`);
    const node = matches[0].node;
    if (node.opacity !== 0 || node.hidden === true || (node.blendMode ?? 'normal') !== 'normal') {
      throw new Error(`Unexpected mask flags: ${layerPath}`);
    }
    if ((node.left ?? 0) !== 0 || (node.top ?? 0) !== 0 || node.imageData.width !== width || node.imageData.height !== height) {
      throw new Error(`Original mask coordinates differ: ${layerPath}`);
    }
    const file = path.join(maskDirectory, `Eye${side}_opening-mask-${variant}.png`);
    const bytes = await fs.readFile(file), patch = PNG.sync.read(bytes);
    trackedFiles.set(file, bytes);
    if (patch.width !== width || patch.height !== height) throw new Error(`Mask must already be ${width} × ${height}: ${file}`);
    if (!patch.data.some((value, index) => index % 4 === 3 && value > 0)) throw new Error(`Empty mask: ${file}`);
    node.imageData = imageData(width, height, new Uint8ClampedArray(patch.data));
    replacements.set(layerPath, { file, rgba: patch.data });
  }
  const neutral = compose(flatten(psd.children), width, height);
  if (!baseline.equals(neutral)) throw new Error('Replacing hidden masks changed the neutral composite.');
  const bytes = writePsdBuffer({ ...psd, imageData: imageData(width, height, new Uint8ClampedArray(neutral)) },
    { noBackground: true, trimImageData: false, generateThumbnail: false });
  const decoded = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  const entries = flatten(decoded.children);
  if (entries.length !== originals.length || JSON.stringify(hierarchy(decoded.children)) !== JSON.stringify(originalHierarchy)) {
    throw new Error('Layer/group names, order or parent assignments changed.');
  }
  const unchangedLayers = [], maskReplacements = [];
  for (const { node, path: layerPath } of entries) {
    const original = originalByPath.get(layerPath), replacement = replacements.get(layerPath);
    if (!original || JSON.stringify(properties(node)) !== JSON.stringify(original.properties)) {
      throw new Error(`Layer coordinates or display properties changed: ${layerPath}`);
    }
    const actual = Buffer.from(node.imageData.data), expected = replacement?.rgba ?? original.rgba;
    if (!actual.equals(expected)) throw new Error(`Unexpected layer pixel changes: ${layerPath}`);
    if (replacement) {
      let changedPixels = 0;
      for (let offset = 0; offset < actual.length; offset += 4) {
        if ([0, 1, 2, 3].some(channel => actual[offset + channel] !== original.rgba[offset + channel])) changedPixels++;
      }
      maskReplacements.push({ path: layerPath, source: replacement.file, changedPixels,
        sourceRgbaSha256: hash(expected), outputRgbaSha256: hash(actual),
        opacity: node.opacity, hidden: Boolean(node.hidden), blendMode: node.blendMode,
        scaledOrTranslated: false, propertiesPreserved: true });
    } else {
      unchangedLayers.push({ path: layerPath, unchangedRgba: true, propertiesPreserved: true, rgbaSha256: hash(actual) });
    }
  }
  if (unchangedLayers.length !== 15 || maskReplacements.length !== 2) throw new Error('Unexpected replacement scope.');
  const decodedNeutral = compose(entries, width, height);
  if (!baseline.equals(decodedNeutral)) throw new Error('PSD round-trip changed the neutral composite.');
  for (const [file, original] of trackedFiles) {
    if (!(await fs.readFile(file)).equals(original)) throw new Error(`Input changed during packaging: ${file}`);
  }
  const validation = {
    status: 'independent 2-mask replacement candidate; not Editor-imported or visually accepted',
    originalPsd: inputPath, output, preview, width, height, variant,
    originalPsdSha256: hash(inputBytes), outputPsdSha256: hash(bytes),
    originalLayerCount: originals.length, outputLayerCount: entries.length,
    groupAndLayerNamesOrderAndParentsPreserved: true, originalLayerPropertiesPreserved: true,
    unchangedLayers, maskReplacements,
    neutralComposite: { changedPixels: 0, maxRgbDelta: 0, maxAlphaDelta: 0,
      rgbaSha256: hash(decodedNeutral), masksExcluded: true, decodedLayerRecompositionMatches: true },
    inputFiles: [...trackedFiles].map(([file, data]) => ({ file, sha256: hash(data) })),
    inputFilesUnmodified: true, modifiedCmo3: false, rigParametersChanged: false,
    editorImportVerified: false, clippingAssigned: false, visualAcceptance: false, exportReady: false,
    limitations: [
      'Only the two existing opacity-zero eye-opening mask layers are replaced; all other 15 layers retain exact RGBA bytes, names, order and parent groups.',
      'Existing body/neck repairs, eye artwork and rig acceptance are not changed or approved by this package.',
      'PSD preservation checks do not verify Cubism import, actual clipping at motion endpoints, or retention of existing model keyforms.',
      'The 2px opening-mask candidate still requires Editor visual review; no CMO3 or SDK export is produced.'
    ]
  };
  await fs.writeFile(output, bytes);
  await fs.writeFile(preview, PNG.sync.write({ width, height, data: decodedNeutral }, { colorType: 6 }));
  await fs.writeFile(`${outputPrefix}.validation.json`, `${JSON.stringify(validation, null, 2)}\n`);
  console.log(JSON.stringify({ output, preview, originalLayerCount: originals.length, outputLayerCount: entries.length,
    unchangedLayers: unchangedLayers.length, maskReplacements, neutralComposite: validation.neutralComposite }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
