#!/usr/bin/env node
// Repackage the approved, source-aligned pixels. No image synthesis, resampling,
// scaling, translation, or occlusion painting is performed by this script.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const requireAuthoring = createRequire(path.resolve(directory, '../../../.local-tools/live2d/authoring/package.json'));
const { PNG } = requireAuthoring('pngjs');
const { writePsdBuffer, readPsd, initializeCanvas } = requireAuthoring('ag-psd');
const imageData = (width, height, data = new Uint8ClampedArray(width * height * 4)) => ({ width, height, data });
initializeCanvas(() => { throw new Error('Canvas is not used.'); }, imageData);
const hash = data => createHash('sha256').update(data).digest('hex');
const flatten = children => children.flatMap(child => child.children ? flatten(child.children) : [child]);
const contains = (polygon, x, y) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// Trace the visible clothing/hair boundary in the approved source coordinates.
// The outline doubles back around curled hair tips; a horizontal cut would
// discard these strands. No skin or clothing hidden by the hair is invented.
const bodyRegions = [
  { name: 'visible_clothing_below_traced_hairline', polygon: [
    [0,900],[286,900],[300,870],[310,850],[315,843],[320,836],[324,829],
    [330,832],[339,834],[349,835],[359,835],[369,834],[377,832],[381,830],
    [373,831],[365,829],[357,826],[350,821],[344,816],[338,812],
    [342,810],[348,807],[354,806],[359,803],[364,799],
    [370,802],[378,806],[387,809],[396,811],
    [399,821],[404,831],[411,841],[420,851],[430,859],[441,864],[452,866],[463,863],
    [454,863],[446,861],[438,857],[431,851],[425,844],[420,835],[416,825],[413,815],[412,811],
    [420,812],[427,814],[433,823],[440,833],[448,843],[457,853],[467,863],[478,871],[490,877],
    [504,880],[516,879],[525,875],[522,873],[514,877],[504,877],[491,873],[480,868],[470,859],[462,849],[455,837],
    [450,826],[457,835],[469,843],[481,850],[495,856],[510,860],[527,862],[541,860],[552,856],[562,850],
    [570,843],[576,834],[571,840],[564,843],[554,845],[544,845],[532,842],[521,837],[511,831],[503,826],
    [512,829],[521,830],[530,827],[537,823],[544,818],[550,816],[554,814],
    [559,818],[564,821],[568,821],[568,811],[576,809],[585,809],[594,811],
    [593,800],[591,793],[588,786],[611,794],[634,800],[648,803],[665,800],[688,792],[714,779],
    [711,790],[709,800],[708,809],[719,808],[727,811],[734,812],[738,815],[733,817],[726,817],
    [733,820],[739,819],[744,817],[753,821],[765,823],[778,823],[789,821],
    [783,829],[776,837],[766,845],[755,852],[744,857],[732,860],[723,861],[715,860],[708,856],
    [714,861],[724,864],[738,866],[752,867],[766,865],[780,861],[793,855],[805,848],[815,840],[821,834],
    [816,844],[809,854],[800,863],[790,870],[780,875],[772,876],
    [782,878],[794,876],[808,870],[821,862],[834,851],[846,839],[858,823],[867,809],[875,793],
    [879,792],[884,795],[887,799],[884,801],[895,802],[907,800],[918,796],[922,794],
    [924,801],[929,807],[937,813],[947,817],[958,818],[968,815],
    [973,824],[990,842],[1020,875],[1254,900],[1254,1254],[0,1254],
  ] },
];

// A self-crossing silhouette silently produces triangular ownership mistakes.
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
for (const { name, polygon } of bodyRegions) {
  for (let i = 0; i < polygon.length; i++) for (let j = i + 2; j < polygon.length; j++) {
    if (i === 0 && j === polygon.length - 1) continue;
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const c = polygon[j], d = polygon[(j + 1) % polygon.length];
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) {
      throw new Error(`The traced boundary ${name} self-intersects at segments ${i} and ${j}.`);
    }
  }
}

const definition = [
  ['Ahoge_Visible', 'Head'], ['Hair_Visible', 'Head'],
  ['IrisLeft_Visible', 'Head'], ['IrisRight_Visible', 'Head'],
  ['EyeLeft_Visible', 'Head'], ['EyeRight_Visible', 'Head'], ['Face_Visible', 'Head'],
  ['HeadphoneLeft_Visible', 'Head'], ['HeadphoneRight_Visible', 'Head'],
  ['Body_Visible', 'Body'],
  ['HandLeft_Visible', 'ArmL'], ['SleeveLeft_Visible', 'ArmL'],
  ['HandRight_Visible', 'ArmR'], ['SleeveRight_Visible', 'ArmR'],
];

async function main() {
  const sourcePath = path.join(directory, 'source/codia-neutral-bust.png');
  const alignedPath = path.join(directory, 'codia-source-aligned.psd');
  const [sourceBytes, alignedBytes] = await Promise.all([fs.readFile(sourcePath), fs.readFile(alignedPath)]);
  const source = PNG.sync.read(sourceBytes);
  const { width, height } = source;
  if (width !== 1254 || height !== 1254) throw new Error('Source coordinates require the approved 1254 × 1254 image.');
  const sourcePsd = readPsd(alignedBytes, { useImageData: true, skipThumbnail: true });
  const original = new Map(flatten(sourcePsd.children).map(layer => [layer.name, layer]));
  const base = original.get('Base_Unassigned');
  if (!base) throw new Error('Expected original Base_Unassigned layer.');
  const layers = definition.map(([name, group]) => ({ name, group, left: 0, top: 0, opacity: 1,
    blendMode: 'normal', imageData: imageData(width, height), restoredEdgePixels: 0 }));
  const owner = new Int16Array(width * height).fill(-1);
  const bodyIndex = layers.findIndex(layer => layer.name === 'Body_Visible');
  const correctionCounts = Object.fromEntries(bodyRegions.map(region => [region.name, 0]));
  let movedFromHeadToBody = 0;
  for (let index = 0; index < layers.length; index++) {
    const originalLayer = original.get(layers[index].name);
    if (!originalLayer || originalLayer.left !== 0 || originalLayer.top !== 0) throw new Error(`Unexpected source layer: ${layers[index].name}`);
    const data = originalLayer.imageData.data;
    for (let pixel = 0; pixel < owner.length; pixel++) {
      const offset = pixel * 4;
      if (!data[offset + 3]) continue;
      if (owner[pixel] !== -1) throw new Error('Original visible layers overlap.');
      const x = pixel % width, y = Math.floor(pixel / width);
      // Keep the explicitly separated face untouched, including its jaw line.
      const region = layers[index].name === 'Hair_Visible' && y >= 778
        ? bodyRegions.find(item => contains(item.polygon, x + 0.5, y + 0.5)) : undefined;
      const destination = region ? bodyIndex : index;
      owner[pixel] = destination;
      layers[destination].imageData.data.set(data.subarray(offset, offset + 4), offset);
      if (region) { movedFromHeadToBody++; correctionCounts[region.name]++; }
    }
  }

  // Nearest existing source-owner propagation restores outline fragments to
  // their adjacent, already classified layer. It does not move any pixel.
  // Retained ownership never crosses between separate groups as a single layer.
  const nearest = new Int16Array(owner);
  const distance = new Uint16Array(owner.length).fill(65535);
  const queue = new Int32Array(owner.length);
  let begin = 0, end = 0;
  for (let pixel = 0; pixel < owner.length; pixel++) {
    if (nearest[pixel] === -1) continue;
    queue[end++] = pixel;
    distance[pixel] = 0;
  }
  while (begin < end) {
    const pixel = queue[begin++], x = pixel % width, y = Math.floor(pixel / width);
    for (const next of [x ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1,
      y ? pixel - width : -1, y + 1 < height ? pixel + width : -1]) {
      if (next < 0 || nearest[next] !== -1) continue;
      nearest[next] = nearest[pixel];
      distance[next] = distance[pixel] + 1;
      queue[end++] = next;
    }
  }
  const invisible = { name: 'Transparent_RGB_Retention', left: 0, top: 0, hidden: true,
    protected: { transparency: true, composite: true, position: true },
    opacity: 1, blendMode: 'normal', imageData: imageData(width, height) };
  let restoredBaseVisiblePixels = 0, baseFarFragments = 0;
  const restoredByGroup = { Head: 0, Body: 0, ArmL: 0, ArmR: 0 };
  for (let pixel = 0; pixel < owner.length; pixel++) {
    const offset = pixel * 4;
    if (!source.data[offset + 3]) {
      invisible.imageData.data.set(source.data.subarray(offset, offset + 4), offset);
      continue;
    }
    if (owner[pixel] !== -1) continue;
    if (!base.imageData.data[offset + 3]) throw new Error(`Missing original visible pixel ${pixel}`);
    const x = pixel % width, y = Math.floor(pixel / width);
    let destination = nearest[pixel];
    // Visually identified outline components are not assigned across body/arm
    // boundaries just because the clothing underneath happens to be nearer.
    // The 3,029 px right contour and 1,874 px left contour are sleeve edges.
    if (y >= 950 && x >= 970) destination = layers.findIndex(item => item.name === 'SleeveLeft_Visible');
    else if (y >= 950 && x <= 300) destination = layers.findIndex(item => item.name === 'SleeveRight_Visible');
    else if (y < 950 && bodyRegions.some(region => contains(region.polygon, x + 0.5, y + 0.5))) {
      destination = bodyIndex;
    } else if (y < 950 && layers[destination].group !== 'Head') {
      destination = layers.findIndex(item => item.name === 'Hair_Visible');
    }
    if (destination < 0) throw new Error('Could not restore an edge owner.');
    owner[pixel] = destination;
    layers[destination].imageData.data.set(source.data.subarray(offset, offset + 4), offset);
    layers[destination].restoredEdgePixels++;
    restoredByGroup[layers[destination].group]++;
    restoredBaseVisiblePixels++;
    if (distance[pixel] > 32) baseFarFragments++;
  }
  const layer = name => {
    const { group, restoredEdgePixels, ...entry } = layers.find(item => item.name === name);
    return entry;
  };
  const group = (name, children) => ({ name, opened: true, blendMode: 'pass through', children });
  const headGroup = group('HeadGroup', [
    group('Hair', [layer('Ahoge_Visible'), layer('Hair_Visible')]),
    group('Face', ['IrisLeft_Visible', 'IrisRight_Visible', 'EyeLeft_Visible', 'EyeRight_Visible', 'Face_Visible'].map(layer)),
    group('Headphones', [layer('HeadphoneLeft_Visible'), layer('HeadphoneRight_Visible')]),
  ]);
  const children = [
    group('ArmLGroup', [layer('HandLeft_Visible'), layer('SleeveLeft_Visible')]),
    group('ArmRGroup', [layer('HandRight_Visible'), layer('SleeveRight_Visible')]),
    group('BodyGroup', [headGroup, layer('Body_Visible')]),
    invisible,
  ];
  const psd = writePsdBuffer({ width, height, bitsPerChannel: 8, colorMode: 3, children,
    imageData: imageData(width, height, new Uint8ClampedArray(source.data)) },
  { noBackground: true, trimImageData: false, generateThumbnail: false });
  const decoded = readPsd(psd, { useImageData: true, skipThumbnail: true });
  const decodedLayers = flatten(decoded.children);
  const decodedInvisible = decodedLayers.find(item => item.name === invisible.name);
  if (!decodedInvisible?.hidden || !decodedInvisible.protected?.transparency
    || !decodedInvisible.protected?.composite || !decodedInvisible.protected?.position) {
    throw new Error('Transparent RGB retention layer did not retain its hidden and locked flags.');
  }
  const reconstructed = new Uint8ClampedArray(decodedInvisible.imageData.data);
  const count = new Uint8Array(width * height);
  let overlaps = 0;
  for (const item of decodedLayers) {
    if (item.name === invisible.name) continue;
    if (item.left !== 0 || item.top !== 0 || item.imageData.width !== width || item.imageData.height !== height) throw new Error('Layer coordinates changed.');
    const data = item.imageData.data;
    for (let pixel = 0; pixel < count.length; pixel++) {
      const offset = pixel * 4;
      if (!data[offset + 3]) continue;
      if (count[pixel]++) overlaps++;
      reconstructed.set(data.subarray(offset, offset + 4), offset);
    }
  }
  let rgbaDifferences = 0, visibleDifferences = 0, missingVisiblePixels = 0;
  for (let pixel = 0; pixel < count.length; pixel++) {
    const offset = pixel * 4;
    let different = false;
    for (let channel = 0; channel < 4; channel++) if (source.data[offset + channel] !== reconstructed[offset + channel]) different = true;
    if (different) { rgbaDifferences++; if (source.data[offset + 3]) visibleDifferences++; }
    if (source.data[offset + 3] && count[pixel] !== 1) missingVisiblePixels++;
  }
  if (rgbaDifferences || overlaps || missingVisiblePixels) throw new Error(`Recomposition failed: ${JSON.stringify({ rgbaDifferences, overlaps, missingVisiblePixels })}`);
  const output = path.join(directory, 'codia-rig-source.psd');
  const preview = path.join(directory, 'codia-rig-source.preview.png');
  await fs.writeFile(output, psd);
  await fs.writeFile(preview, PNG.sync.write({ width, height, data: Buffer.from(reconstructed) }, { colorType: 6 }));
  for (const groupName of ['Head', 'Body', 'ArmL', 'ArmR']) {
    const data = Buffer.alloc(width * height * 4);
    for (const item of layers.filter(item => item.group === groupName)) {
      const input = item.imageData.data;
      for (let offset = 0; offset < data.length; offset += 4) if (input[offset + 3]) data.set(input.subarray(offset, offset + 4), offset);
    }
    await fs.writeFile(path.join(directory, `codia-rig-source.${groupName}.png`), PNG.sync.write({ width, height, data }, { colorType: 6 }));
  }
  const validation = {
    status: 'grouped source draft; visible hair/hood boundary traced; occluded areas remain unavailable',
    source: sourcePath, originalAlignedPsd: alignedPath, output,
    originalSourceSha256: hash(sourceBytes), originalAlignedPsdSha256: hash(alignedBytes),
    sourceRgbaSha256: hash(source.data), reconstructedRgbaSha256: hash(reconstructed),
    outputPsdSha256: hash(psd), width, height, layerCount: decodedLayers.length,
    stableLayerNames: decodedLayers.map(item => item.name),
    originalCoordinatesPreserved: true, scaledOrTranslated: false, drawnPixels: 0,
    overlapPixels: overlaps, totalRgbaPixelDifferences: rgbaDifferences,
    visiblePixelDifferences: visibleDifferences, missingVisiblePixels,
    restoredBaseVisiblePixels, restoredByGroup, baseFarFragments,
    baseRestorationMethod: 'Multi-source 4-neighbor nearest source owner; explicit anatomical group constraints restore the isolated sleeve and head outline components. Isolated source speckles are retained, not deleted.',
    movedFromHeadToBody, correctionCounts, correctionRegions: bodyRegions,
    visibleBaseLayerRemaining: false, transparentRgbLayerHiddenAndLocked: true,
    groups: ['BodyGroup/HeadGroup/Hair', 'BodyGroup/HeadGroup/Face', 'BodyGroup/HeadGroup/Headphones', 'BodyGroup/Body_Visible', 'ArmLGroup', 'ArmRGroup'],
    semanticReview: {
      status: 'visible-contour-traced; hidden-areas-unresolved',
      visibleBoundaryTraced: true,
      outlineVertices: bodyRegions.reduce((total, region) => total + region.polygon.length, 0),
      selfIntersections: 0,
      safeCompleted: [
        'All visible Base_Unassigned pixels have a named owning layer.',
        'Sleeve outline components remain with their respective hands and sleeves.',
        'Neck, black collar, shoulder straps and exposed pink/white hood pixels are assigned to Body.',
        'The boundary doubles back around the two viewer-left curled hair tips and the viewer-right split hair tip.',
        'The existing Face_Visible jaw pixels and all original layer/group names are preserved.',
      ],
      unresolvedRegions: [
        { bounds: [310,790,585,885], issue: 'Hood and strap behind the viewer-left hair tips are occluded in the source; the traced layers preserve the visible pixels but cannot restore this hidden clothing.' },
        { bounds: [708,790,970,885], issue: 'Collar, inner hood and strap behind the viewer-right hair are occluded; head motion may expose these unpainted areas.' },
        { bounds: [588,778,714,812], issue: 'Only the visible neck is present. No neck extension hidden behind the jaw was created.' },
        { bounds: [310,778,970,885], issue: 'Some original edge pixels mix hair and clothing colors. Reassigning unchanged RGBA cannot recreate a clean separate alpha matte or remove baked-in color fringes.' },
      ],
      headRelativeMotionReady: false,
      note: 'Exact recomposition verifies pixel preservation, not a complete turn-ready model. Visible contours have been traced; use endpoint visual checks for any head-relative motion because hidden clothing/neck backplates have not been painted.',
    },
    rigged: false, occludedAreasPainted: false,
  };
  await fs.writeFile(path.join(directory, 'codia-rig-source.validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
  if (hash(await fs.readFile(sourcePath)) !== hash(sourceBytes) || hash(await fs.readFile(alignedPath)) !== hash(alignedBytes)) throw new Error('Original source unexpectedly changed.');
  console.log(JSON.stringify({ output, preview, restoredBaseVisiblePixels, restoredByGroup, movedFromHeadToBody,
    totalRgbaPixelDifferences: rgbaDifferences, overlapPixels: overlaps, semanticReview: validation.semanticReview.status }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
