#!/usr/bin/env node
// Package frozen full-canvas eye candidates without painting, scaling, or moving
// artwork. Opening masks still need Editor adjustment; this is not a final rig.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const argumentsList = process.argv.slice(2);
const options = {};
for (let index = 0; index < argumentsList.length; index += 2) {
  const flag = argumentsList[index], value = argumentsList[index + 1];
  if (!['--base', '--out'].includes(flag) || !value || value.startsWith('--')) {
    throw new Error('Usage: node build-rig-eyes-v2.mjs [--base original.psd] [--out output-prefix]');
  }
  if (options[flag]) throw new Error(`Duplicate option: ${flag}`);
  options[flag] = value;
}
// Explicit paths resolve from the caller's working directory. Defaults retain
// the original standalone eye-candidate filenames beside this script.
const inputPath = options['--base'] ? path.resolve(options['--base']) : path.join(directory, 'codia-rig-source.psd');
const outputPrefix = options['--out'] ? path.resolve(options['--out']) : path.join(directory, 'codia-rig-eyes-v2');
const requireAuthoring = createRequire(path.resolve(directory, '../../../.local-tools/live2d/authoring/package.json'));
const { PNG } = requireAuthoring('pngjs');
const { readPsd, writePsdBuffer, initializeCanvas } = requireAuthoring('ag-psd');
const imageData = (width, height, data = new Uint8ClampedArray(width * height * 4)) => ({ width, height, data });
initializeCanvas(() => { throw new Error('Canvas is not used.'); }, imageData);
const hash = data => createHash('sha256').update(data).digest('hex');
const facePath = 'BodyGroup/HeadGroup/Face';
const patchDirectory = path.join(directory, 'source/codia-eye-patches-v2');
const maskNames = new Set(['EyeLeft_OpeningMask', 'EyeRight_OpeningMask']);
const replacementFiles = {
  IrisLeft_Visible: 'IrisLeft_reassigned.png', IrisRight_Visible: 'IrisRight_reassigned.png',
  EyeLeft_Visible: 'EyeLeft_filled.png', EyeRight_Visible: 'EyeRight_filled.png',
};
const flatten = (children, prefix = '', opacity = 1, hidden = false) => children.flatMap(node => {
  const layerPath = prefix ? `${prefix}/${node.name}` : node.name;
  const effectiveOpacity = opacity * (node.opacity ?? 1);
  const effectiveHidden = hidden || Boolean(node.hidden);
  return node.children ? flatten(node.children, layerPath, effectiveOpacity, effectiveHidden)
    : [{ node, path: layerPath, opacity: effectiveOpacity, hidden: effectiveHidden }];
});
const hierarchy = (children, excludeMasks = false) => children
  .filter(node => !excludeMasks || !maskNames.has(node.name))
  .map(node => ({ name: node.name, ...(node.children ? { children: hierarchy(node.children, excludeMasks) } : {}) }));
const samePixel = (a, b, offset) => [0, 1, 2, 3].every(channel => a[offset + channel] === b[offset + channel]);

function compose(entries, width, height) {
  const result = Buffer.alloc(width * height * 4);
  const retention = entries.find(entry => entry.node.name === 'Transparent_RGB_Retention');
  if (retention) result.set(retention.node.imageData.data);
  for (const { node, hidden, opacity } of entries.slice().reverse()) {
    // Masks are real image layers for import, never preview artwork.
    if (hidden || opacity === 0 || maskNames.has(node.name)) continue;
    if (node.blendMode && node.blendMode !== 'normal') throw new Error(`Unsupported image blend mode: ${node.name}`);
    const source = node.imageData.data;
    for (let offset = 0; offset < source.length; offset += 4) {
      if (!source[offset + 3]) continue;
      const a = source[offset + 3] / 255 * opacity;
      const b = result[offset + 3] / 255;
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
  const output = `${outputPrefix}.psd`;
  const preview = `${outputPrefix}.neutral.png`;
  if (output.toLowerCase() === inputPath.toLowerCase()) throw new Error('Output must not overwrite the input PSD.');
  const inputBytes = await fs.readFile(inputPath);
  const psd = readPsd(inputBytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  const { width, height } = psd;
  if (width !== 1254 || height !== 1254) throw new Error('Expected the approved 1254 × 1254 source coordinate system.');
  const originals = flatten(psd.children);
  const originalByPath = new Map(originals.map(entry => [entry.path, Buffer.from(entry.node.imageData.data)]));
  const originalHierarchy = hierarchy(psd.children);
  const originalCoordinates = new Map(originals.map(entry => [entry.path, [entry.node.left, entry.node.top, entry.node.imageData.width, entry.node.imageData.height]]));
  for (const { node } of originals) {
    if ((node.left ?? 0) !== 0 || (node.top ?? 0) !== 0 || node.imageData.width !== width || node.imageData.height !== height) {
      throw new Error(`Unexpected original coordinates: ${node.name}`);
    }
  }
  const baseline = compose(originals, width, height);
  const trackedFiles = new Map([[inputPath, inputBytes]]);
  const loadPatch = async filename => {
    const file = path.join(patchDirectory, filename);
    const bytes = await fs.readFile(file);
    trackedFiles.set(file, bytes);
    const patch = PNG.sync.read(bytes);
    if (patch.width !== width || patch.height !== height) throw new Error(`${filename} must already be ${width} × ${height}; resizing is forbidden.`);
    return patch;
  };
  const patches = new Map();
  for (const filename of Object.values(replacementFiles)) patches.set(filename, await loadPatch(filename));
  const ownershipResults = [];
  const newIrisUnion = new Uint8Array(width * height);
  let expectedMaxAlphaDelta = 0;
  for (const side of ['Left', 'Right']) {
    const eyeName = `Eye${side}_Visible`, irisName = `Iris${side}_Visible`;
    const oldEye = originalByPath.get(`${facePath}/${eyeName}`);
    const oldIris = originalByPath.get(`${facePath}/${irisName}`);
    if (!oldEye || !oldIris) throw new Error(`Original Face/${side} eye layers are missing.`);
    const ownership = await loadPatch(`Eye${side}_original-ownership.png`);
    const eye = patches.get(replacementFiles[eyeName]);
    const iris = patches.get(replacementFiles[irisName]);
    let unionDifferences = 0, overlaps = 0, changedOriginalEyePixels = 0, additionsOutsideIris = 0, addedBackingPixels = 0;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const offset = pixel * 4;
      if (oldEye[offset + 3] && oldIris[offset + 3]) throw new Error('Original eye and iris unexpectedly overlap.');
      const original = oldEye[offset + 3] ? oldEye : oldIris;
      const corrected = ownership.data[offset + 3] ? ownership.data : iris.data;
      if (ownership.data[offset + 3] && iris.data[offset + 3]) overlaps++;
      if (!samePixel(original, corrected, offset)) unionDifferences++;
      if (ownership.data[offset + 3] && !samePixel(ownership.data, eye.data, offset)) changedOriginalEyePixels++;
      if (!ownership.data[offset + 3] && eye.data[offset + 3]) {
        addedBackingPixels++;
        if (!iris.data[offset + 3]) additionsOutsideIris++;
      }
      if (iris.data[offset + 3]) {
        newIrisUnion[pixel] = 1;
        const foregroundAlpha = iris.data[offset + 3];
        const backingAlpha = eye.data[offset + 3];
        expectedMaxAlphaDelta = Math.max(expectedMaxAlphaDelta,
          Math.round(foregroundAlpha + backingAlpha * (1 - foregroundAlpha / 255)) - original[offset + 3]);
      }
    }
    if (unionDifferences || overlaps || changedOriginalEyePixels || additionsOutsideIris) {
      throw new Error(`Eye ${side} ownership/backing validation failed: ${JSON.stringify({ unionDifferences, overlaps, changedOriginalEyePixels, additionsOutsideIris })}`);
    }
    ownershipResults.push({ side, unionRgbaPixelDifferences: unionDifferences, unionOverlaps: overlaps,
      changedOriginalEyePixels, additionsOutsideIris, addedBackingPixels });
  }
  for (const [name, filename] of Object.entries(replacementFiles)) {
    const entry = originals.find(item => item.path === `${facePath}/${name}`);
    if (!entry) throw new Error(`Missing original layer: ${name}`);
    entry.node.imageData = imageData(width, height, new Uint8ClampedArray(patches.get(filename).data));
  }
  const body = psd.children.find(node => node.name === 'BodyGroup');
  const head = body?.children?.find(node => node.name === 'HeadGroup');
  const face = head?.children?.find(node => node.name === 'Face');
  if (!face?.children) throw new Error(`Missing group: ${facePath}`);
  for (const side of ['Left', 'Right']) {
    const name = `Eye${side}_OpeningMask`;
    if (face.children.some(node => node.name === name)) throw new Error(`Mask already exists: ${name}`);
    const patch = await loadPatch(`Eye${side}_opening-mask.png`);
    if (!patch.data.some((value, index) => index % 4 === 3 && value > 0)) throw new Error(`Empty opening mask: ${name}`);
    face.children.push({ name, left: 0, top: 0, opacity: 0, hidden: false, blendMode: 'normal',
      imageData: imageData(width, height, new Uint8ClampedArray(patch.data)) });
  }
  const neutral = compose(flatten(psd.children), width, height);
  const bytes = writePsdBuffer({ ...psd, imageData: imageData(width, height, new Uint8ClampedArray(neutral)) },
    { noBackground: true, trimImageData: false, generateThumbnail: false });
  const decoded = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  const decodedEntries = flatten(decoded.children);
  if (decodedEntries.length !== originals.length + 2 || JSON.stringify(hierarchy(decoded.children, true)) !== JSON.stringify(originalHierarchy)) {
    throw new Error('Original group/layer names or order changed.');
  }
  const nonEyeLayers = [];
  const replacements = [];
  const masks = [];
  for (const { node, path: layerPath } of decodedEntries) {
    if ((node.left ?? 0) !== 0 || (node.top ?? 0) !== 0 || node.imageData.width !== width || node.imageData.height !== height) {
      throw new Error(`Decoded layer was cropped or moved: ${layerPath}`);
    }
    const rgbaHash = hash(node.imageData.data);
    if (maskNames.has(node.name)) {
      const side = node.name.includes('Left') ? 'Left' : 'Right';
      const expected = PNG.sync.read(trackedFiles.get(path.join(patchDirectory, `Eye${side}_opening-mask.png`)));
      if (node.opacity !== 0 || node.hidden === true || node.blendMode !== 'normal' || rgbaHash !== hash(expected.data)) {
        throw new Error(`Mask import flags/data changed: ${node.name}`);
      }
      masks.push({ name: node.name, opacity: node.opacity, hidden: Boolean(node.hidden), blendMode: node.blendMode, rgbaSha256: rgbaHash });
    } else if (replacementFiles[node.name] && layerPath === `${facePath}/${node.name}`) {
      const expected = patches.get(replacementFiles[node.name]);
      if (rgbaHash !== hash(expected.data)) throw new Error(`Replacement pixels changed: ${node.name}`);
      replacements.push({ name: node.name, source: replacementFiles[node.name], rgbaSha256: rgbaHash,
        left: node.left, top: node.top, width, height, scaledOrTranslated: false });
    } else {
      if (rgbaHash !== hash(originalByPath.get(layerPath))) throw new Error(`Non-eye layer pixels changed: ${layerPath}`);
      if (JSON.stringify([node.left, node.top, node.imageData.width, node.imageData.height]) !== JSON.stringify(originalCoordinates.get(layerPath))) {
        throw new Error(`Non-eye layer coordinates changed: ${layerPath}`);
      }
      nonEyeLayers.push({ path: layerPath, unchangedRgba: true, rgbaSha256: rgbaHash });
    }
  }
  const decodedNeutral = compose(decodedEntries, width, height);
  if (hash(decodedNeutral) !== hash(neutral)) throw new Error('PSD layer round-trip changed the neutral composite.');
  let changedPixels = 0, changedOutsideIris = 0, maxRgbDelta = 0, maxAlphaDelta = 0;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const offset = pixel * 4;
    if (!samePixel(baseline, decodedNeutral, offset)) { changedPixels++; if (!newIrisUnion[pixel]) changedOutsideIris++; }
    for (let channel = 0; channel < 3; channel++) maxRgbDelta = Math.max(maxRgbDelta, Math.abs(baseline[offset + channel] - decodedNeutral[offset + channel]));
    maxAlphaDelta = Math.max(maxAlphaDelta, Math.abs(baseline[offset + 3] - decodedNeutral[offset + 3]));
  }
  // Original iris pixels use alpha 252–254. Backing can raise alpha by up to
  // three levels; compute that bound from the actual input instead of assuming
  // every original pixel is alpha 254. RGB changes above three require review.
  if (changedOutsideIris || maxRgbDelta > 3 || maxAlphaDelta > expectedMaxAlphaDelta || expectedMaxAlphaDelta > 3) {
    throw new Error(`Neutral composite exceeds the reviewed tolerance: ${JSON.stringify({ changedOutsideIris, maxRgbDelta, maxAlphaDelta })}`);
  }
  for (const [file, original] of trackedFiles) {
    if (hash(await fs.readFile(file)) !== hash(original)) throw new Error(`An input changed during packaging; rerun after patch work is complete: ${file}`);
  }
  const validation = {
    status: 'combined authoring candidate for Editor adjustment; eye openings, base artwork repairs and motion are not visually accepted',
    originalPsd: inputPath, output, preview, width, height, originalPsdSha256: hash(inputBytes), outputPsdSha256: hash(bytes),
    originalLayerCount: originals.length, outputLayerCount: decodedEntries.length,
    originalGroupAndLayerNamesAndOrderPreserved: true, originalCoordinatesPreserved: true,
    nonEyeLayers, replacements, ownershipResults, masks,
    neutralComposite: { changedPixels, changedOutsideIris, maxRgbDelta, maxAlphaDelta, expectedMaxAlphaDelta,
      masksExcluded: true, decodedLayerRecompositionMatches: true,
      note: 'Ownership-only Eye + Iris union is exact. Hidden sclera backing can alter neutral compositing beneath original iris pixels with alpha 252–254.' },
    inputFiles: [...trackedFiles].map(([file, contents]) => ({ file, sha256: hash(contents) })),
    modifiedCmo3: false, rigParametersChanged: false, clippingAssigned: false, editorImportVerified: false,
    baseArtworkReview: 'All non-eye pixels are retained exactly from the selected base PSD. This packaging step does not approve its body, neck, sleeve ownership or occlusion artwork.',
    openingMaskReview: 'authoring candidate only; eye-opening boundaries require adjustment in Editor',
    motionReview: { accepted: false, rejectedDiagnosticOffsets: [[-8, -6], [8, -6]],
      note: 'Ownership fringe was corrected, but left/right 8px plus upward 6px eye-motion diagnostics have not passed visual review.' },
    limitations: ['No clipping relationships are encoded by adding PSD image layers. Assign each iris to its matching OpeningMask in Cubism.',
      'Opacity zero with hidden=false is verified in the PSD only; retained ArtMesh and runtime masking require Editor/export verification.',
      'Opening masks are provisional authoring candidates. Neither the eye-opening edges nor the +/-8px, -6px eye-motion diagnostics are approved.',
      'This step only changes eye layers and adds mask sources; any torso/neck repairs are inherited unmodified from the selected base, and still require visual acceptance.',
      'No blink shape, facial turn or motion binding is added by this package.'],
  };
  await fs.writeFile(output, bytes);
  await fs.writeFile(preview, PNG.sync.write({ width, height, data: Buffer.from(decodedNeutral) }, { colorType: 6 }));
  await fs.writeFile(`${outputPrefix}.validation.json`, `${JSON.stringify(validation, null, 2)}\n`);
  console.log(JSON.stringify({ output, preview, originalLayerCount: originals.length, outputLayerCount: decodedEntries.length,
    unchangedNonEyeLayers: nonEyeLayers.length, ownershipResults, neutralComposite: validation.neutralComposite, masks }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
