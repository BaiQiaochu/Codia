#!/usr/bin/env node
// Add AI-painted clothing and neck backplates only below original occluders.
// Correct source ownership without changing original pixel colors/coordinates.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const requireAuthoring = createRequire(path.resolve(directory, '../../../.local-tools/live2d/authoring/package.json'));
const { PNG } = requireAuthoring('pngjs');
const sharp = requireAuthoring('sharp');
const { readPsd, writePsdBuffer, initializeCanvas } = requireAuthoring('ag-psd');
const imageData = (width, height, data = new Uint8ClampedArray(width * height * 4)) => ({ width, height, data });
initializeCanvas(() => { throw new Error('Canvas is not used.'); }, imageData);
const hash = data => createHash('sha256').update(data).digest('hex');
const flatten = (nodes, parent = '') => nodes.flatMap(node => node.children
  ? flatten(node.children, parent + node.name + '/') : [{ node, path: parent + node.name }]);
const contains = (polygon, x, y) => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

// Anatomical gate, inset from the generated silhouette. The actual acceptance
// also requires existing Hair/Arm coverage, no Face/Eye coverage, and a solid
// generated clothing pixel. Background and exposed original pixels are excluded.
const bodyGate = [
  [590,782],[645,799],[715,778],[713,809],[750,813],[782,830],[824,829],
  [876,816],[922,811],[939,821],[950,850],[992,876],[1008,919],[995,982],
  [1060,1040],[1120,1100],[1190,1165],[1189,1198],[1100,1224],[1000,1238],
  [800,1242],[620,1242],[410,1238],[220,1226],[65,1190],[72,1160],
  [134,1110],[205,1040],[265,985],[254,931],[253,892],[282,865],[310,840],
  [332,825],[358,815],[385,815],[427,826],[480,837],[521,836],[548,819],[587,811],
];

// Generated shirt seam lines delimit the torso behind the raised arms. The
// generated image's outstretched sleeve wings are not a stationary body layer.
const torsoGate = [
  [0,770],[1254,770],[1254,980],[998,1008],[983,1011],[962,1020],[944,1031],
  [928,1044],[914,1060],[906,1075],[919,1110],[932,1150],[946,1190],[966,1230],
  [970,1254],[398,1254],[399,1240],[404,1205],[407,1160],[408,1118],
  [399,1100],[383,1075],[366,1050],[348,1030],[330,1015],[309,1003],[0,980],
];

// Only the concealed continuation immediately above the original neck. The
// candidate is sampled at its original coordinates and still needs original
// jaw or original adjacent Hair_Visible coverage; background stays transparent.
const neckGate = [[580,744],[726,744],[723,770],[718,797],[713,828],
  [594,828],[590,802],[585,772]];

// These contours follow visible source cuff/hand edges. They relocate original
// RGBA without painting, scaling, or replacing it. Donor restrictions ensure the
// regions cannot grab neighboring unaffected layers.
const ownershipCorrections = [
  { name: 'right_cuff_fragment', from: ['BodyGroup/Body_Visible'], to: 'ArmRGroup/SleeveRight_Visible', polygon: [
    [454,1044],[461,1046],[469,1050],[478,1054],[485,1059],[491,1066],[496,1073],[500,1081],
    [503,1090],[505,1100],[506,1110],[505,1120],[503,1130],[500,1140],[496,1150],[468,1150],
    [451,1065],
  ] },
  { name: 'torso_above_right_hand', from: ['ArmRGroup/'], to: 'BodyGroup/Body_Visible', polygon: [
    [300,960],[510,960],[510,1052],[475,1055],[464,1049],[454,1045],
    [451,1037],[444,1032],[432,1023],[420,1016],[410,1009],[401,1005],[393,1003],
    [380,1008],[369,1014],[355,1018],[346,1025],[338,1019],[328,1013],[318,1009],[307,1007],
  ] },
  { name: 'torso_above_left_hand', from: ['ArmLGroup/'], to: 'BodyGroup/Body_Visible', polygon: [
    [730,950],[1010,950],[1010,1008],[994,1007],[980,1009],[965,1013],[951,1018],
    [939,1025],[929,1034],[923,1042],[917,1041],[909,1035],[902,1029],[891,1026],
    [879,1022],[867,1018],[856,1016],[846,1019],[835,1026],[824,1034],[815,1042],
    [808,1050],[805,1062],[797,1067],[787,1071],[779,1077],[775,1085],[773,1090],[730,1090],
  ] },
  { name: 'left_torso_drawstring_beside_cuff', from: ['ArmLGroup/'], to: 'BodyGroup/Body_Visible', polygon: [
    [700,1088],[773,1090],[769,1097],[765,1107],[762,1120],[761,1135],
    [762,1148],[766,1160],[773,1174],[781,1188],[791,1201],[803,1213],[816,1224],
    [823,1230],[826,1254],[700,1254],
  ] },
];

function render(entries, width, height, options = {}) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (const { node, path: layerPath } of [...entries].reverse()) {
    if (node.hidden || options.hidden?.some(prefix => layerPath.startsWith(prefix))) continue;
    const displacement = options.transforms?.find(item => layerPath.startsWith(item.prefix));
    const dx = displacement?.dx || 0, dy = displacement?.dy || 0;
    const input = node.imageData.data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const tx = x + dx, ty = y + dy;
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
      const from = (y * width + x) * 4, to = (ty * width + tx) * 4;
      const sa = input[from + 3] / 255;
      if (!sa) continue;
      const da = out[to + 3] / 255, oa = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) out[to + c] = Math.round((input[from + c] * sa + out[to + c] * da * (1 - sa)) / oa);
      out[to + 3] = Math.round(oa * 255);
    }
  }
  return out;
}

async function main() {
  const sourcePath = path.join(directory, 'source/codia-neutral-bust.png');
  const rigPath = path.join(directory, 'codia-rig-source.psd');
  const candidatePath = path.join(directory, 'source/codia-body-occlusion-v1.png');
  const neckPath = path.join(directory, 'source/codia-neck-occlusion-v4.png');
  const [sourceBytes, rigBytes, candidateBytes, neckBytes] = await Promise.all([sourcePath, rigPath, candidatePath, neckPath].map(file => fs.readFile(file)));
  const source = PNG.sync.read(sourceBytes), candidate = PNG.sync.read(candidateBytes), neckCandidate = PNG.sync.read(neckBytes);
  const { width, height } = source;
  if (width !== 1254 || height !== 1254 || candidate.width !== width || candidate.height !== height) throw new Error('All artwork must retain the approved 1254 × 1254 coordinates.');
  if (neckCandidate.width !== width || neckCandidate.height !== height) throw new Error('Neck artwork coordinates changed.');
  const psd = readPsd(rigBytes, { useImageData: true, skipThumbnail: true });
  const entries = flatten(psd.children);
  const before = new Map(entries.map(({ node, path: layerPath }) => [layerPath, Buffer.from(node.imageData.data)]));
  const bodyPath = 'BodyGroup/Body_Visible';
  const body = entries.find(entry => entry.path === bodyPath)?.node;
  if (!body) throw new Error('Body_Visible is missing.');
  // Preserve the source hand outline while correcting the adjacent white shirt.
  // Skin seeds are limited to the inspected fist boxes, then expanded by three
  // source pixels so antialiased dark knuckle outlines stay on the arm.
  const handEdgeProtection = new Uint8Array(width * height);
  const fistBoxes = [[304,998,480,1137], [775,1016,950,1160]];
  for (const [x0,y0,x1,y1] of fistBoxes) for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
    const offset=(y*width+x)*4;
    const [r,g,b,a]=source.data.subarray(offset,offset+4);
    if (a<200 || r<140 || r-g<8 || g-b < -1) continue;
    for(let dy=-3;dy<=3;dy++) for(let dx=-3;dx<=3;dx++) {
      if(dx*dx+dy*dy>9) continue;
      handEdgeProtection[(y+dy)*width+x+dx]=1;
    }
  }
  const ownershipMoves = [];
  for (const correction of [...ownershipCorrections.slice(1), ownershipCorrections[0]]) {
    const destination = entries.find(entry => entry.path === correction.to).node.imageData.data;
    const counts = {};
    for (const { node, path: layerPath } of entries.filter(entry => correction.from.some(prefix => entry.path.startsWith(prefix)))) {
      if (layerPath === correction.to) continue;
      const input = node.imageData.data;
      for (let y = 950; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        if (!input[offset + 3] || !contains(correction.polygon, x + 0.5, y + 0.5)) continue;
        if (correction.name.startsWith('torso_above_') && handEdgeProtection[y * width + x]) continue;
        if (destination[offset + 3]) throw new Error('Ownership correction would overlap existing original pixels.');
        destination.set(input.subarray(offset, offset + 4), offset);
        input.fill(0, offset, offset + 4);
        counts[layerPath] = (counts[layerPath] || 0) + 1;
      }
    }
    ownershipMoves.push({ ...correction, movedPixelsByDonor: counts });
  }
  const correctedBefore = new Map(entries.map(({ node, path: layerPath }) => [layerPath, Buffer.from(node.imageData.data)]));
  const originalBody = correctedBefore.get(bodyPath);
  let originalVisibleRgbaDifferences = 0, originalOverlaps = 0;
  const reconstructedOriginal = new Uint8ClampedArray(width * height * 4), originalOwners = new Uint8Array(width * height);
  for (const { node } of entries) {
    if (node.hidden) continue;
    for (let pixel = 0; pixel < originalOwners.length; pixel++) {
      const offset = pixel * 4;
      if (!node.imageData.data[offset + 3]) continue;
      if (originalOwners[pixel]++) originalOverlaps++;
      reconstructedOriginal.set(node.imageData.data.subarray(offset, offset + 4), offset);
    }
  }
  for (let pixel = 0; pixel < originalOwners.length; pixel++) {
    const offset = pixel * 4;
    if (source.data[offset + 3] && [0,1,2,3].some(c => reconstructedOriginal[offset + c] !== source.data[offset + c])) originalVisibleRgbaDifferences++;
  }
  if (originalVisibleRgbaDifferences || originalOverlaps) throw new Error('Original ownership corrections changed the source composition.');
  const covered = new Uint8Array(width * height), forbiddenFace = new Uint8Array(width * height);
  const headCoverage = new Uint8Array(width * height), armCoverage = new Uint8Array(width * height);
  for (const { node, path: layerPath } of entries) {
    const isHair = layerPath === 'BodyGroup/HeadGroup/Hair/Hair_Visible';
    const isArm = layerPath.startsWith('ArmLGroup/') || layerPath.startsWith('ArmRGroup/');
    const isFace = layerPath.startsWith('BodyGroup/HeadGroup/Face/');
    if (!isHair && !isArm && !isFace) continue;
    for (let pixel = 0; pixel < covered.length; pixel++) {
      if (!node.imageData.data[pixel * 4 + 3]) continue;
      if (isHair || isArm) covered[pixel] = 1;
      if (isHair) headCoverage[pixel] = 1;
      if (isArm) armCoverage[pixel] = 1;
      if (isFace) forbiddenFace[pixel] = 1;
    }
  }
  let addedPixels = 0, underHead = 0, underArms = 0;
  let addedNeckPixels = 0;
  const addedMask = new Uint8Array(width * height);
  const neckMask = new Uint8Array(width * height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 770; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x, offset = pixel * 4;
    if (originalBody[offset + 3] || !covered[pixel] || forbiddenFace[pixel]
      || candidate.data[offset + 3] < 240 || !contains(bodyGate, x + 0.5, y + 0.5)
      || !contains(torsoGate, x + 0.5, y + 0.5)) continue;
    body.imageData.data.set(candidate.data.subarray(offset, offset + 4), offset);
    addedMask[pixel] = 1;
    addedPixels++;
    if (headCoverage[pixel]) underHead++;
    if (armCoverage[pixel]) underArms++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }

  const originalFace = correctedBefore.get('BodyGroup/HeadGroup/Face/Face_Visible');
  for (let y = 744; y < 829; y++) for (let x = 580; x < 727; x++) {
    const pixel = y * width + x, offset = pixel * 4;
    if (originalBody[offset + 3] || (originalFace[offset + 3] < 240 && !headCoverage[pixel])
      || neckCandidate.data[offset + 3] < 240 || !contains(neckGate, x + 0.5, y + 0.5)) continue;
    const [r,g,b] = neckCandidate.data.subarray(offset, offset + 3);
    // Exclude any accidentally sampled collar/outline/background; this pass is
    // confined to the independently generated warm skin extension.
    if (r < 155 || r - g < 8 || g - b < -3) continue;
    body.imageData.data.set(neckCandidate.data.subarray(offset, offset + 4), offset);
    if (!addedMask[pixel]) { addedPixels++; underHead++; }
    addedMask[pixel] = 1; neckMask[pixel] = 1; addedNeckPixels++;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }

  // Inspect candidate alignment at original visible pixels adjacent to additions.
  // Large disagreement is retained as an explicit warning, never healed by
  // replacing approved original artwork or quietly blending it away.
  let boundaryCount = 0, boundaryError = 0, boundaryOver20 = 0, boundaryMax = 0;
  let neckBoundaryCount = 0, neckBoundaryError = 0, neckBoundaryMax = 0;
  let neckSkinBoundaryCount = 0, neckSkinBoundaryError = 0, neckSkinBoundaryMax = 0;
  for (let pixel = 0; pixel < addedMask.length; pixel++) {
    const offset = pixel * 4;
    if (originalBody[offset + 3] < 240) continue;
    const x = pixel % width, y = Math.floor(pixel / width);
    if (![x ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y ? pixel - width : -1, y + 1 < height ? pixel + width : -1]
      .some(next => next >= 0 && addedMask[next])) continue;
    const adjacent = [x ? pixel - 1 : -1, x + 1 < width ? pixel + 1 : -1, y ? pixel - width : -1, y + 1 < height ? pixel + width : -1];
    const isNeck = adjacent.some(next => next >= 0 && neckMask[next]);
    const comparison = isNeck ? neckCandidate.data : candidate.data;
    if (comparison[offset + 3] < 240) continue;
    const error = [0, 1, 2].reduce((sum, c) => sum + Math.abs(originalBody[offset + c] - comparison[offset + c]), 0) / 3;
    if (isNeck) { neckBoundaryCount++; neckBoundaryError += error; neckBoundaryMax = Math.max(neckBoundaryMax,error); }
    if (isNeck && originalBody[offset] > 140 && originalBody[offset] - originalBody[offset + 1] > 8
      && originalBody[offset + 1] - originalBody[offset + 2] > -3) {
      neckSkinBoundaryCount++; neckSkinBoundaryError += error; neckSkinBoundaryMax = Math.max(neckSkinBoundaryMax,error);
    }
    boundaryCount++; boundaryError += error; boundaryMax = Math.max(boundaryMax, error);
    if (error > 20) boundaryOver20++;
  }

  const neutral = render(entries, width, height);
  const output = path.join(directory, 'codia-rig-occlusion-v1.psd');
  const outputBytes = writePsdBuffer({ width, height, bitsPerChannel: 8, colorMode: 3,
    children: psd.children, imageData: imageData(width, height, neutral) },
  { noBackground: true, trimImageData: false, generateThumbnail: false });
  const decoded = flatten(readPsd(outputBytes, { useImageData: true, skipThumbnail: true }).children);
  if (JSON.stringify(decoded.map(entry => entry.path)) !== JSON.stringify(entries.map(entry => entry.path))) throw new Error('Layer names or group order changed.');
  let changedOriginalBodyPixels = 0, changedOtherLayers = 0;
  for (const { node, path: layerPath } of decoded) {
    const original = correctedBefore.get(layerPath), data = node.imageData.data;
    if (node.left !== 0 || node.top !== 0 || node.imageData.width !== width || node.imageData.height !== height) throw new Error('Original coordinates changed.');
    if (layerPath !== bodyPath) {
      if (hash(original) !== hash(data)) changedOtherLayers++;
    } else {
      for (let offset = 0; offset < original.length; offset += 4) {
        if (!original[offset + 3]) continue;
        if ([0, 1, 2, 3].some(channel => original[offset + channel] !== data[offset + channel])) changedOriginalBodyPixels++;
      }
    }
  }
  if (changedOriginalBodyPixels || changedOtherLayers) throw new Error('An original visible layer pixel changed.');

  const previews = [
    ['neutral', neutral],
    ['Body', body.imageData.data],
    ['arms-hidden', render(entries, width, height, { hidden: ['ArmLGroup/', 'ArmRGroup/'] })],
    ['head-left', render(entries, width, height, { transforms: [{ prefix: 'BodyGroup/HeadGroup/', dx: -12, dy: -8 }] })],
    ['head-right', render(entries, width, height, { transforms: [{ prefix: 'BodyGroup/HeadGroup/', dx: 12, dy: -8 }] })],
    ['arms-separated', render(entries, width, height, { transforms: [
      { prefix: 'ArmLGroup/', dx: 20, dy: 50 }, { prefix: 'ArmRGroup/', dx: -20, dy: 50 },
    ] })],
    ['actual-head-left', render(entries, width, height, { transforms: [{ prefix: 'BodyGroup/HeadGroup/', dx: -4, dy: -2 }] })],
    ['actual-head-right', render(entries, width, height, { transforms: [{ prefix: 'BodyGroup/HeadGroup/', dx: 4, dy: -2 }] })],
  ];
  await fs.writeFile(output, outputBytes);
  for (const [name, data] of previews) await fs.writeFile(path.join(directory, 'codia-rig-occlusion-v1.' + name + '.png'),
    PNG.sync.write({ width, height, data: Buffer.from(data) }, { colorType: 6 }));
  const cells = [];
  for (let i = 0; i < previews.length; i++) {
    const [name, data] = previews[i];
    const header = '<svg width="627" height="28" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="10" y="20" font-size="15">' + name + '</text></svg>';
    cells.push({ left: (i % 2) * 627, top: Math.floor(i / 2) * 280,
      input: await sharp(PNG.sync.write({ width, height, data: Buffer.from(data) }))
        .extract({ left: 0, top: 750, width, height: 504 }).resize(627, 252)
        .flatten({ background: '#a2b3b2' }).extend({ top: 28, bottom: 0, left: 0, right: 0, background: 'white' })
        .composite([{ input: Buffer.from(header), left: 0, top: 0 }]).png().toBuffer(),
    });
  }
  const sheetPath = path.join(directory, 'codia-rig-occlusion-v1.seam-review.png');
  await sharp({ create: { width: 1254, height: Math.ceil(previews.length / 2) * 280, channels: 4, background: 'white' } }).composite(cells).png().toFile(sheetPath);
  for (const name of ['actual-head-left','actual-head-right','head-left','head-right']) {
    await sharp(path.join(directory, 'codia-rig-occlusion-v1.' + name + '.png'))
      .extract({ left: 570, top: 760, width: 170, height: 85 }).resize(850,425,{kernel:'nearest'})
      .flatten({ background: '#a2b3b2' }).png()
      .toFile(path.join(directory, 'codia-rig-occlusion-v1.' + name + '.neck-review.png'));
  }

  let neutralRgbaDifferences = 0, faceCompositeChanges = 0;
  for (let pixel = 0; pixel < addedMask.length; pixel++) {
    const offset = pixel * 4;
    const changed = [0, 1, 2, 3].some(c => neutral[offset + c] !== source.data[offset + c]);
    if (changed) neutralRgbaDifferences++;
    if (changed && forbiddenFace[pixel]) faceCompositeChanges++;
  }
  const report = {
    status: 'candidate clothing and hidden neck backplates; visual seam review required; not a completed rig',
    source: sourcePath, originalRigPsd: rigPath, generatedCandidate: candidatePath, generatedNeckCandidate: neckPath, output,
    sourceSha256: hash(sourceBytes), originalRigSha256: hash(rigBytes), candidateSha256: hash(candidateBytes), outputSha256: hash(outputBytes),
    neckCandidateSha256: hash(neckBytes),
    width, height, originalCoordinatesPreserved: true, originalLayersScaledOrTranslated: false,
    groupAndLayerNamesUnchanged: true, bodyRemainsBehindHeadAndArms: true,
    originalVisibleRgbaDifferencesAfterOwnershipCorrections: originalVisibleRgbaDifferences,
    originalOverlapsAfterOwnershipCorrections: originalOverlaps,
    originalLayerMembershipCorrected: true, ownershipMoves,
    changedCorrectedOriginalBodyPixels: changedOriginalBodyPixels, unexpectedChangesToOtherCorrectedLayers: changedOtherLayers, faceCompositeChanges,
    addedOcclusionPixels: addedPixels, addedUnderHeadPixels: underHead, addedUnderArmsPixels: underArms, addedNeckPixels,
    addedPixelBounds: [minX, minY, maxX, maxY], allowedBodyPolygon: bodyGate, allowedTorsoPolygon: torsoGate, allowedHiddenNeckPolygon: neckGate,
    bodyOnlyAddsWhereOriginallyCovered: true, originalFaceAndEyeLayersUnchanged: true,
    clothingExcludedFromFaceCoverage: true, hiddenNeckRequiresOriginalJawOrAdjacentHeadCoverage: true, generatedBackgroundExcluded: true,
    seamBoundarySamples: boundaryCount, candidateBoundaryMeanRgbError: boundaryCount ? boundaryError / boundaryCount : null,
    candidateBoundaryMaxRgbError: boundaryMax, candidateBoundarySamplesOver20: boundaryOver20,
    neckBoundarySamples: neckBoundaryCount, neckBoundaryMeanRgbError: neckBoundaryCount ? neckBoundaryError / neckBoundaryCount : null, neckBoundaryMaxRgbError: neckBoundaryMax,
    neckSkinBoundarySamples: neckSkinBoundaryCount,
    neckSkinBoundaryMeanRgbError: neckSkinBoundaryCount ? neckSkinBoundaryError / neckSkinBoundaryCount : null,
    neckSkinBoundaryMaxRgbError: neckSkinBoundaryMax,
    boundaryMetricNote: 'Candidate-vs-original RGB comparison at untouched original pixels adjacent to additions; all-neck metrics may include dark outline/collar pixels. These numbers do not establish visual continuity.',
    neutralRgbaDifferences,
    compositeNote: 'Original foreground layer RGBA is unchanged. Most source foreground alpha is 252–254; adding clothing underneath can alter neutral composited RGBA. Exact layer preservation is not a claim of zero composite difference or animation acceptance.',
    diagnosticTransformsOnly: { headLeft: [-12,-8], headRight: [12,-8], armLeft: [20,50], armRight: [-20,50], actualHeadLeft: [-4,-2], actualHeadRight: [4,-2] },
    rigParametersChanged: false, animationValidated: false, needsVisualReview: true,
    frozenCandidate: true,
    visualAssessment: [
      { item: 'Original approved foreground pixels, dimensions and Face/Eye/Iris names', result: 'PASS', detail: 'Original visible RGBA and coordinates preserved, apart from explicitly recorded source layer membership corrections; decoded PSD verified.' },
      { item: 'Central neck transparent triangle in displacement previews', result: 'PASS_LIMITED', detail: 'Hidden generated neck covers the central gap in +/-4,-2 and +/-12,-8 static diagnostics. This is not validation of a bound Cubism deforming mesh.' },
      { item: 'Small head motion +/-4 horizontal, -2 vertical', result: 'REQUIRES_EDITOR_REVIEW', detail: 'No broad central gap; magnified previews still show a narrow color boundary and small neck-side slit. Do not call this fully seamless.' },
      { item: 'Larger head motion +/-12 horizontal, -8 vertical', result: 'FAIL', detail: 'New skin shading boundary and neck-side openings remain visible.' },
      { item: 'Whole-arm translation +/-20 horizontal, +50 vertical', result: 'FAIL', detail: 'Both shoulder connections open. No stationary sleeve wings were added to conceal them; requires sleeve-joint deformation or a separately approved hidden seam repair.' },
      { item: 'Bound Live2D animation and mesh clipping', result: 'NOT_TESTED', detail: 'No Cubism UI, CMO3, parameter bindings or runtime configuration changed by this builder.' },
    ],
    limitations: [
      'This candidate adds generated clothing beneath existing Hair/Arm pixels and a narrow generated neck extension beneath the original jaw; no eye whites, fingers, face turn or hair underlayers are created.',
      'The two outstretched sleeves are not copied into the stationary torso. Whole-arm translation still exposes shoulder gaps and is not accepted motion.',
      'No original visible artwork is recolored, moved, scaled or blended to hide candidate mismatch.',
      'The seam previews are static pixel displacement diagnostics, not bound Live2D motion.',
    ],
    previews: previews.map(([name]) => 'codia-rig-occlusion-v1.' + name + '.png'), seamReview: sheetPath,
  };
  await fs.writeFile(path.join(directory, 'codia-rig-occlusion-v1.validation.json'), JSON.stringify(report, null, 2) + '\n');
  if (hash(await fs.readFile(sourcePath)) !== hash(sourceBytes) || hash(await fs.readFile(rigPath)) !== hash(rigBytes)) throw new Error('An original asset changed.');
  console.log(JSON.stringify({ output, addedPixels, underHead, underArms, changedOriginalBodyPixels, changedOtherLayers,
    faceCompositeChanges, boundaryMeanRgbError: report.candidateBoundaryMeanRgbError, boundaryOver20, seamReview: sheetPath }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
