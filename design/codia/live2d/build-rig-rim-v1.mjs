#!/usr/bin/env node
// Deterministic vector rim assets; approved character artwork stays untouched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(dir, '../../../.local-tools/live2d/authoring/package.json'));
const { PNG } = require('pngjs');
const sharp = require('sharp');
const { readPsd, writePsdBuffer, initializeCanvas } = require('ag-psd');
const imageData = (width, height, data = new Uint8ClampedArray(width * height * 4)) => ({ width, height, data });
initializeCanvas(() => { throw Error('Canvas unused'); }, imageData);
const hash = b => createHash('sha256').update(b).digest('hex');
const W = 1254, H = 1254, radius = 575;
const input = path.join(dir, 'codia-rig-repair-masks-v3.psd');
const prefix = path.join(dir, 'codia-rig-rim-v1');
const assets = path.join(dir, 'source/codia-rim-v1');
const anchors = [{ layer: 'HandRight_Visible', x: 392, y: 1134 }, { layer: 'HandLeft_Visible', x: 877, y: 1152 }];
const dx = anchors[1].x - anchors[0].x, dy = anchors[1].y - anchors[0].y;
const chord = Math.hypot(dx, dy), h = Math.sqrt(radius ** 2 - (chord / 2) ** 2);
const cx = (anchors[0].x + anchors[1].x) / 2 + dy / chord * h;
const cy = (anchors[0].y + anchors[1].y) / 2 - dx / chord * h;
const rad = d => d * Math.PI / 180;
const point = (r, a) => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
const arc = r => { const a = point(r, 40), b = point(r, 140); return `M${a[0]},${a[1]} A${r},${r} 0 0 1 ${b[0]},${b[1]}`; };
const svg = content => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${content}</svg>`;
const color = '#C8A0DA', highlight = '#F8E7F5';
const drawings = {
  RimBack: svg(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="8"/><circle cx="${cx}" cy="${cy}" r="${radius - 3}" fill="none" stroke="${highlight}" stroke-width="2"/>`),
  RimFront: svg(`<path d="${arc(radius)}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round"/><path d="${arc(radius - 3)}" fill="none" stroke="${highlight}" stroke-width="2" stroke-linecap="round"/>`),
  OpeningMask: svg(`<ellipse cx="${cx}" cy="${cy}" rx="${radius}" ry="${radius}" fill="white"/>`),
};
const flatten = (nodes, parent = '', opacity = 1, hidden = false) => nodes.flatMap(node => {
  const full = parent + node.name, op = opacity * (node.opacity ?? 1), off = hidden || Boolean(node.hidden);
  return node.children ? flatten(node.children, full + '/', op, off) : [{ node, path: full, opacity: op, hidden: off }];
});
const properties = n => ({ name: n.name, left: n.left, top: n.top, right: n.right, bottom: n.bottom, opacity: n.opacity ?? 1, hidden: Boolean(n.hidden), blendMode: n.blendMode });
const clippedNames = new Set(['Body_Visible', 'SleeveLeft_Visible', 'SleeveRight_Visible']);
const order = { Transparent_RGB_Retention: 0, RimBack: 450, OpeningMask: 460, Body_Visible: 490,
  HeadphoneRight_Visible: 500, HeadphoneLeft_Visible: 501, EyeRight_OpeningMask: 505, EyeLeft_OpeningMask: 506,
  Face_Visible: 510, EyeRight_Visible: 520, EyeLeft_Visible: 521, IrisRight_Visible: 530, IrisLeft_Visible: 531,
  Hair_Visible: 540, Ahoge_Visible: 550, SleeveRight_Visible: 560, SleeveLeft_Visible: 570,
  RimFront: 600, HandRight_Visible: 610, HandLeft_Visible: 611 };
function compose(entries, mask, simulation = false) {
  const out = Buffer.alloc(W * H * 4);
  const sorted = simulation ? [...entries].sort((a,b) => order[a.node.name] - order[b.node.name]) : [...entries].reverse();
  for (const e of sorted) {
    if (e.hidden || !e.opacity) continue;
    const d = e.node.imageData.data, clip = simulation && clippedNames.has(e.node.name);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i+3] / 255 * e.opacity * (clip ? mask[i+3] / 255 : 1);
      if (!a) continue;
      const b = out[i+3] / 255, sum = a + b * (1-a);
      for (let c = 0; c < 3; c++) out[i+c] = Math.round((d[i+c] * a + out[i+c] * b * (1-a)) / sum);
      out[i+3] = Math.round(sum * 255);
    }
  }
  return out;
}
async function main() {
  const inputBytes = await fs.readFile(input);
  const psd = readPsd(inputBytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  if (psd.width !== W || psd.height !== H) throw Error('Unexpected source dimensions');
  const original = flatten(psd.children);
  if (original.length !== 17) throw Error('Expected unchanged 17-layer masks-v3 PSD');
  for (const a of anchors) if (original.find(e => e.node.name === a.layer).node.imageData.data[(a.y * W + a.x) * 4 + 3] < 240) throw Error('Contact anchor is not an original solid hand pixel');
  const old = new Map(original.map(e => [e.path, { rgba: Buffer.from(e.node.imageData.data), properties: properties(e.node) }]));
  await fs.mkdir(assets, { recursive: true });
  const layers = {};
  for (const [name, source] of Object.entries(drawings)) {
    const png = await sharp(Buffer.from(source)).png().toBuffer();
    await fs.writeFile(path.join(assets, name + '.svg'), source + '\n');
    await fs.writeFile(path.join(assets, name + '.png'), png);
    const pixels = PNG.sync.read(png);
    layers[name] = { name, left: 0, top: 0, right: W, bottom: H, opacity: name === 'OpeningMask' ? 0 : 1,
      hidden: false, blendMode: 'normal', imageData: imageData(W,H,new Uint8ClampedArray(pixels.data)) };
  }
  // Original groups/parents are retained. Cubism must assign draw orders and
  // clipping after import; PSD group nesting alone cannot put both hands above
  // a front arc while keeping their sibling sleeves below it.
  psd.children = [layers.RimFront, ...psd.children, layers.RimBack, layers.OpeningMask];
  const entries = flatten(psd.children), mask = layers.OpeningMask.imageData.data;
  const neutral = compose(entries, mask), target = compose(entries, mask, true);
  const outputBytes = writePsdBuffer({ ...psd, imageData: imageData(W,H,new Uint8ClampedArray(neutral)) }, { noBackground:true, trimImageData:false, generateThumbnail:false });
  const decoded = flatten(readPsd(outputBytes, { useImageData:true, skipThumbnail:true, skipCompositeImageData:true }).children);
  const originalEntries = decoded.filter(e => old.has(e.path));
  if (originalEntries.length !== 17 || JSON.stringify(originalEntries.map(e => e.path)) !== JSON.stringify(original.map(e => e.path))) throw Error('Original hierarchy/order changed');
  for (const e of originalEntries) {
    const before = old.get(e.path);
    if (!before.rgba.equals(Buffer.from(e.node.imageData.data)) || JSON.stringify(before.properties) !== JSON.stringify(properties(e.node))) throw Error('Original pixels/properties changed: ' + e.path);
  }
  const contact = anchors.map(a => {
    const data = original.find(e => e.node.name === a.layer).node.imageData.data;
    let intersects = 0, outside = 0;
    for (let y=0;y<H;y++) for(let x=0;x<W;x++) {
      const i=(y*W+x)*4;
      if(data[i+3]<240) continue;
      if(layers.RimFront.imageData.data[i+3]>0) intersects++;
      if(mask[i+3]<240) outside++;
    }
    return { ...a, radialError: Math.hypot(a.x-cx,a.y-cy)-radius, lowerArcAngleDegrees: Math.atan2(a.y-cy,a.x-cx)*180/Math.PI, solidHandPixelsIntersectingFrontStroke:intersects, solidHandPixelsOutsideOpening:outside };
  });
  let headOutside=0, headOutsideBounds=[W,H,-1,-1];
  for (let y=0;y<H;y++) for(let x=0;x<W;x++) {
    const i=(y*W+x)*4;
    if(mask[i+3]>=240 || !original.some(e=>e.path.startsWith('BodyGroup/HeadGroup/')&&e.opacity>0&&!e.hidden&&e.node.imageData.data[i+3]>=240))continue;
    headOutside++;headOutsideBounds=[Math.min(headOutsideBounds[0],x),Math.min(headOutsideBounds[1],y),Math.max(headOutsideBounds[2],x),Math.max(headOutsideBounds[3],y)];
  }
  const geometry={canvas:[W,H],requested:{center:[626,590],radius:575},chosen:{center:[cx,cy],radius,strokeWidth:8,strokeColor:color,innerHighlight:{radius:radius-3,width:2,color:highlight},frontArcDegrees:[40,140],angles:'degrees clockwise in screen coordinates, positive Y down'},sourceAnchors:contact,
    rejectedApproximateAnchor:{layer:'HandLeft_Visible',point:[875,1157],reason:'Original alpha=0; closest solid point is [877,1152].'},
    adjustmentReason:'Fixed radius circle through two verified source fingertip-edge pixels; no artwork translated or scaled.',drawOrderRecommendation:order,clipRecommendation:{OpeningMask:['Body_Visible','SleeveLeft_Visible','SleeveRight_Visible'],unclipped:['HandRight_Visible','HandLeft_Visible','HeadGroup']}};
  await fs.writeFile(path.join(assets,'geometry.json'),JSON.stringify(geometry,null,2)+'\n');
  await fs.writeFile(prefix+'.psd',outputBytes);
  for(const[name,data]of[['neutral',neutral],['target-clipped',target]])await fs.writeFile(prefix+'.'+name+'.png',PNG.sync.write({width:W,height:H,data},{colorType:6}));
  const images=[['original',compose(original,mask)],['PSD overlay only',neutral],['clipping + draw-order simulation',target]];
  const cells=[];
  for(let j=0;j<images.length;j++){
    const[label,data]=images[j];const heading=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="627" height="34"><rect width="100%" height="100%" fill="white"/><text x="12" y="23" font-size="16">${label}</text></svg>`);
    const cell=await sharp(PNG.sync.write({width:W,height:H,data})).resize(627,627).flatten({background:'#eee6f7'}).extend({top:34,bottom:0,left:0,right:0,background:'white'}).composite([{input:heading,left:0,top:0}]).png().toBuffer();cells.push({input:cell,left:j*627,top:0});
  }
  await sharp({create:{width:1881,height:661,channels:4,background:'white'}}).composite(cells).png().toFile(prefix+'.comparison.png');
  const report={status:'geometry-only rim authoring candidate, no Cubism clipping or rig acceptance',input,output:prefix+'.psd',inputSha256:hash(inputBytes),outputSha256:hash(outputBytes),sourceArtworkLayersPreserved:17,outputLayerCount:decoded.length,originalCoordinatesPreserved:true,originalLayerPixelsPropertiesParentsAndRelativeOrderUnchanged:true,addedLayers:Object.keys(layers),geometry,
    openingMask:{name:'OpeningMask',opacity:0,hidden:false,fullWhiteEllipse:true},contact,headOutsideOpening:{solidPixels:headOutside,bounds:headOutsideBounds},
    previews:{neutral:prefix+'.neutral.png',targetSimulation:prefix+'.target-clipped.png',comparison:prefix+'.comparison.png'},
    modifiedCmo3:false,clippingAssigned:false,drawOrdersAssignedInCubism:false,modelImported:false,visualAcceptance:false,
    limitations:['The PSD neutral preview is a raw overlay without clipping. The target preview simulates clipping and explicit ArtMesh draw order; it is not a saved or verified Cubism model.',
      'Hands touch the arc at verified original edge pixels, but the clenched original fingers are not redrawn as a full grip; overlap alone is not a proven grasp pose.',
      'Head is deliberately unclipped. Ahoge, headphones and outer hair can remain outside the opening; BodyRise must hide them via actual masking/position/opacity as needed.',
      'Hands are unclipped and above RimFront; hide-state movement must take them below the visible viewport or animate opacity. This PSD does not provide that motion.',
      'The circular frame stays stationary; do not parent it to BodyRise or the reaching hand deformers.',
      'Existing body/neck/shoulder and eye limitations remain. Frame clipping does not constitute acceptance of those repairs.']};
  await fs.writeFile(prefix+'.validation.json',JSON.stringify(report,null,2)+'\n');
  if(!(await fs.readFile(input)).equals(inputBytes))throw Error('Input PSD changed');
  console.log(JSON.stringify({output:report.output,center:[cx,cy],contact,headOutsideOpening:report.headOutsideOpening,comparison:report.previews.comparison},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
