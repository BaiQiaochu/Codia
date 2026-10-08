#!/usr/bin/env node
// Transfer original pixels between eye and iris layers; never repaint visible iris pixels.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(root,'../../../.local-tools/live2d/authoring/package.json'));
const {PNG}=require('pngjs'),{readPsd,initializeCanvas}=require('ag-psd');
initializeCanvas(()=>{throw Error('No canvas');},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
const sharp=require('sharp');
const hash=d=>createHash('sha256').update(d).digest('hex');
const source=PNG.sync.read(await fs.readFile(path.join(root,'source/codia-neutral-bust.png')));
const base=PNG.sync.read(await fs.readFile(path.join(root,'source/codia-sclera-occlusion-v1.aligned.png')));
const {crop}=JSON.parse(await fs.readFile(path.join(root,'source/codia-eyes-reference.coordinates.json')));
const psd=readPsd(await fs.readFile(path.join(root,'codia-source-aligned.psd')),{useImageData:true,skipThumbnail:true,skipCompositeImageData:true});
const flatten=a=>a.flatMap(l=>l.children?flatten(l.children):[l]),layers=flatten(psd.children);
const find=n=>layers.find(l=>l.name===n).imageData.data;
const outDir=path.join(root,'source/codia-eye-patches-v2');await fs.mkdir(outDir,{recursive:true});
const blank=()=>new PNG({width:source.width,height:source.height});
const cropImage=p=>{const o=new PNG({width:crop.width,height:crop.height});for(let y=0;y<crop.height;y++)p.data.copy(o.data,y*crop.width*4,((crop.top+y)*source.width+crop.left)*4,((crop.top+y)*source.width+crop.rightExclusive)*4);return o;};
const write=(name,p)=>fs.writeFile(path.join(outDir,name),PNG.sync.write(p));
const contains=(x,y,p)=>{let yes=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const[a,b]=p[i],[c,d]=p[j];if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)yes=!yes;}return yes;};
// Anatomical Left is on the viewer's right. Coordinates traced against the 5x source
// reference, including the iris contour while keeping the upper lash line stationary.
const polygons={
 Right:[[499,579],[507,578],[519,579],[532,582],[544,587],[553,592],[562,600],[568,609],[572,619],[574,630],[574,642],[572,652],[567,663],[561,670],[553,674],[543,677],[533,679],[526,680],[514,678],[505,675],[497,670],[490,663],[484,655],[480,645],[478,636],[476,626],[476,616],[478,605],[481,597],[486,589],[492,583]],
 Left:[[738,565],[750,558],[763,552],[780,551],[790,558],[800,568],[808,578],[814,591],[817,604],[817,617],[814,630],[807,642],[800,649],[789,657],[775,661],[752,661],[741,658],[731,651],[725,642],[720,630],[717,617],[717,603],[720,589],[725,577]]
};
// Eye-opening selections traced from the original lash/sclera and lower-lid
// boundaries. Masks contain the eyeball opening only, not the whole Eye layer.
const openingPolygons={
 Right:[[447,615],[451,607],[458,599],[466,592],[477,586],[486,582],[498,577],[512,575],[526,577],[540,582],[551,587],[561,595],[568,605],[573,618],[577,637],[575,649],[571,659],[563,668],[553,674],[539,677],[527,679],[514,679],[502,678],[489,674],[478,669],[467,662],[457,653],[451,643],[447,631]],
 Left:[[712,592],[720,581],[731,572],[743,562],[755,556],[768,552],[784,552],[801,555],[815,561],[829,571],[837,580],[842,591],[843,604],[839,617],[832,630],[823,640],[812,648],[799,655],[786,659],[766,659],[750,658],[737,655],[728,649],[721,641],[715,628],[712,615],[712,603]]
};
const sides={},results=[];
const ownership=blank();
const nearPolygon=(x,y,p)=>{for(let dy=-5;dy<=5;dy++)for(let dx=-5;dx<=5;dx++)if(dx*dx+dy*dy<=25&&contains(x+dx,y+dy,p))return true;return false;};
for(const side of ['Left','Right']){
 const oldEye=find(`Eye${side}_Visible`),oldIris=find(`Iris${side}_Visible`);
 const eyeOriginal=blank(),iris=blank(),patch=blank(),eyeFilled=blank(),toIris=blank(),toEye=blank();
 const irisMask=new Uint8Array(source.width*source.height);
 let movedToIris=0,movedToEye=0,irisPixels=0,originalPixelChanges=0,backgroundRimReturnedToEye=0;
 for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
  const i=(y*source.width+x)*4,owner=oldEye[i+3]?oldEye:oldIris[i+3]?oldIris:null;if(!owner)continue;
  const j=((y-crop.top)*crop.width+x-crop.left)*4;
  const inside=contains(x+.5,y+.5,polygons[side]);
  const withinCrop=x>=crop.left&&x<crop.rightExclusive&&y>=crop.top&&y<crop.bottomExclusive;
  const sourceMean=(owner[i]+owner[i+1]+owner[i+2])/3;
  const baseMean=withinCrop?(base.data[j]+base.data[j+1]+base.data[j+2])/3:0;
  const rgbDifference=withinCrop?Math.abs(owner[i]-base.data[j])+Math.abs(owner[i+1]-base.data[j+1])+Math.abs(owner[i+2]-base.data[j+2]):0;
  // The approved generated base preserves upper lashes and the fixed lower lid.
  // Only grow across a traced contour where the base exposes lighter sclera.
  const preservedLid=baseMean<180&&rgbDifference<105;
  const contourPixel=!inside&&baseMean-sourceMean>12&&nearPolygon(x+.5,y+.5,polygons[side]);
  if((inside||contourPixel)&&!preservedLid)irisMask[y*source.width+x]=1;
 }
 // Neutral light pixels connected to the exterior are sclera/background fringe,
 // not enclosed iris highlights. Keep them fixed to avoid lifting a pale halo
 // over the upper lashes. This transfers bytes only; no recoloring or dilation.
 const rimQueue=[],queued=new Uint8Array(irisMask.length);
 const nearNeutral=p=>{const i=p*4,o=oldEye[i+3]?oldEye:oldIris;return Math.floor(p/source.width)<(side==='Left'?575:590)&&(o[i]+o[i+1]+o[i+2])/3>180&&Math.max(o[i],o[i+1],o[i+2])-Math.min(o[i],o[i+1],o[i+2])<38;};
 const adjacent=p=>[p-1,p+1,p-source.width,p+source.width].filter(n=>n>=0&&n<irisMask.length);
 for(let p=0;p<irisMask.length;p++)if(irisMask[p]&&nearNeutral(p)&&adjacent(p).some(n=>!irisMask[n])){rimQueue.push(p);queued[p]=1;}
 for(let k=0;k<rimQueue.length;k++){const p=rimQueue[k];irisMask[p]=0;backgroundRimReturnedToEye++;for(const n of adjacent(p))if(irisMask[n]&&!queued[n]&&nearNeutral(n)){queued[n]=1;rimQueue.push(n);}}
 for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
  const i=(y*source.width+x)*4,owner=oldEye[i+3]?oldEye:oldIris[i+3]?oldIris:null;if(!owner)continue;
  const j=((y-crop.top)*crop.width+x-crop.left)*4;
  if(irisMask[y*source.width+x]){
   iris.data.set(owner.subarray(i,i+4),i);irisPixels++;
   if(oldEye[i+3]){toIris.data.set(owner.subarray(i,i+4),i);ownership.data.set([30,180,250,255],i);movedToIris++;}
   patch.data.set([base.data[j],base.data[j+1],base.data[j+2],owner[i+3]],i);
   eyeFilled.data.set(patch.data.subarray(i,i+4),i);
  }else{
   eyeOriginal.data.set(owner.subarray(i,i+4),i);eyeFilled.data.set(owner.subarray(i,i+4),i);
   if(oldIris[i+3]){toEye.data.set(owner.subarray(i,i+4),i);ownership.data.set([255,160,20,255],i);movedToEye++;}
  }
  const newOwner=iris.data[i+3]?iris.data:eyeOriginal.data;
  if(newOwner.subarray(i,i+4).some((v,c)=>v!==owner[i+c]))originalPixelChanges++;
 }
 const opening=blank();
 for(let y=crop.top;y<crop.bottomExclusive;y++)for(let x=crop.left;x<crop.rightExclusive;x++){
  let coverage=0;for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++)if(contains(x+(sx+.5)/4,y+(sy+.5)/4,openingPolygons[side]))coverage++;
  if(coverage)opening.data.set([255,255,255,Math.round(coverage*255/16)],(y*source.width+x)*4);
 }
 await write(`Eye${side}_opening-mask.png`,opening);await write(`Eye${side}_opening-mask.crop.png`,cropImage(opening));
 sides[side]={eyeOriginal,eyeFilled,iris,patch,opening};
 for(const[name,p]of [[`Eye${side}_original-ownership.png`,eyeOriginal],[`Eye${side}_filled.png`,eyeFilled],[`Iris${side}_reassigned.png`,iris],[`Eye${side}_sclera-patch.png`,patch],[`Eye${side}_to_Iris${side}.png`,toIris],[`Iris${side}_to_Eye${side}.png`,toEye]])await write(name,p);
 results.push({side,viewerSide:side==='Left'?'right':'left',movedOriginalEyePixelsToIris:movedToIris,movedOriginalIrisPixelsToEye:movedToEye,backgroundRimReturnedToEye,irisPixels,originalPixelChanges,originalEyeSha256:hash(oldEye),originalIrisSha256:hash(oldIris),reassignedIrisSha256:hash(iris.data)});
}
await write('ownership-transfer-mask.png',ownership);await write('ownership-transfer-mask.crop.png',cropImage(ownership));
const underpaint=blank();underpaint.data.set(source.data);
for(const {patch}of Object.values(sides))for(let i=0;i<patch.data.length;i+=4)if(patch.data[i+3])underpaint.data.set(patch.data.subarray(i,i+4),i);
await write('both-eyes-sclera.crop.png',cropImage(underpaint));
const over=(d,i,s,j)=>{const sa=s[j+3]/255,da=d[i+3]/255,a=sa+da*(1-sa);for(let c=0;c<3;c++)d[i+c]=Math.round((s[j+c]*sa+d[i+c]*da*(1-sa))/a);d[i+3]=Math.round(a*255);};
const compose=(dx,dy,clip=false)=>{const o=blank();o.data.set(underpaint.data);for(const{iris,opening}of Object.values(sides))for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){const i=(y*source.width+x)*4;if(!iris.data[i+3])continue;const tx=x+dx,ty=y+dy;if(tx>=0&&ty>=0&&tx<source.width&&ty<source.height){const ti=(ty*source.width+tx)*4;if(clip){const a=Math.round(iris.data[i+3]*opening.data[ti+3]/255);if(a)over(o.data,ti,[iris.data[i],iris.data[i+1],iris.data[i+2],a],0);}else over(o.data,ti,iris.data,i);}}return o;};
const neutral=compose(0,0);
await write('both-eyes-neutral.crop.png',cropImage(neutral));
await write('both-eyes-shift-left8-unclipped.crop.png',cropImage(compose(-8,0)));
await write('both-eyes-shift-right8-unclipped.crop.png',cropImage(compose(8,0)));
await write('both-eyes-shift-left8-up6-unclipped.crop.png',cropImage(compose(-8,-6)));
await write('both-eyes-shift-right8-up6-unclipped.crop.png',cropImage(compose(8,-6)));
await write('both-eyes-neutral-clipped.crop.png',cropImage(compose(0,0,true)));
await write('both-eyes-shift-left8-up6-clipped.crop.png',cropImage(compose(-8,-6,true)));
await write('both-eyes-shift-right8-up6-clipped.crop.png',cropImage(compose(8,-6,true)));
const maskOverlay=cropImage(source);
for(const{opening}of Object.values(sides)){const m=cropImage(opening);for(let i=0;i<m.data.length;i+=4)if(m.data[i+3]){const a=m.data[i+3]/255*.22;maskOverlay.data[i]=Math.round(maskOverlay.data[i]*(1-a));maskOverlay.data[i+1]=Math.round(maskOverlay.data[i+1]*(1-a)+a*185);maskOverlay.data[i+2]=Math.round(maskOverlay.data[i+2]*(1-a)+a*240);}}
await write('eye-opening-mask-overlay.crop.png',maskOverlay);
for(const name of ['both-eyes-sclera.crop.png','both-eyes-neutral.crop.png','both-eyes-shift-left8-unclipped.crop.png','both-eyes-shift-right8-unclipped.crop.png','both-eyes-shift-left8-up6-unclipped.crop.png','both-eyes-shift-right8-up6-unclipped.crop.png','both-eyes-neutral-clipped.crop.png','both-eyes-shift-left8-up6-clipped.crop.png','both-eyes-shift-right8-up6-clipped.crop.png','eye-opening-mask-overlay.crop.png'])await sharp(path.join(outDir,name)).resize(crop.width*3,crop.height*3,{kernel:'nearest'}).png().toFile(path.join(outDir,name.replace('.png','.3x.png')));
let changedOriginalComposite=0,sourcePixelsLost=0,originalUnionOverlap=0,maxNeutralRgbDifference=0,neutralChangedOutsideNewIris=0;
for(let i=0;i<source.data.length;i+=4){
 let newIris=false;for(const side of ['Left','Right']){const oldEye=find(`Eye${side}_Visible`),oldIris=find(`Iris${side}_Visible`),{eyeOriginal,iris}=sides[side];if(eyeOriginal.data[i+3]&&iris.data[i+3])originalUnionOverlap++;const original=oldEye[i+3]?oldEye:oldIris[i+3]?oldIris:null;const merged=eyeOriginal.data[i+3]?eyeOriginal.data:iris.data[i+3]?iris.data:null;if(original&&!merged)sourcePixelsLost++;if(original&&merged&&merged.subarray(i,i+4).some((v,c)=>v!==original[i+c]))changedOriginalComposite++;if(iris.data[i+3])newIris=true;}
 let changed=false;for(let c=0;c<4;c++){const d=Math.abs(source.data[i+c]-neutral.data[i+c]);if(c<3)maxNeutralRgbDifference=Math.max(maxNeutralRgbDifference,d);if(d)changed=true;}if(changed&&!newIris)neutralChangedOutsideNewIris++;
}
const validation={version:2,status:'Manual iris-ownership boundary draft; review movement previews before merging',canvas:{width:source.width,height:source.height},crop,polygons,openingPolygons,openingMaskMethod:'Original-image traced opening polygons; 4x4 subpixel coverage; white RGB with transparent exterior. Does not reuse the skin/lash-bearing Eye layer alpha.',results,originalPixels:{changedOriginalComposite,sourcePixelsLost,originalUnionOverlap},neutralComposite:{maxNeutralRgbDifference,neutralChangedOutsideNewIris,note:'Underpainting beneath original alpha 254 can raise composite alpha by one; ownership-only union is exact.'},integration:'Use full-canvas patches and explicit ownership transfers with current source. Do not overwrite newer Eye layer restorations. Opening masks are separate clipping ArtMesh source data; keep the rendered skin/lash texture outside the clipping source. No PSD or UI modified.',visualReview:{status:'Pending'},limitations:['No closed-eye shape or blink model created.','Both clipped and unclipped movement diagnostics are supplied.']};
validation.status='Review package complete; limited gaze range is not yet visually accepted';
validation.maskLegend={cyan:'Original Eye pixels transferred to Iris',orange:'Original Iris pixels returned to fixed Eye'};
validation.visualReview={
 originalPixelTransfer:'Pass: ownership-only original composite is unchanged, no lost or duplicated pixels.',
 stationaryIrisOutline:'Pass for the conspicuous fixed lateral black arcs from v1: these no longer remain in either side of the underpaint or movement previews.',
 openingMask:'Original-eye-opening trace supplied separately from skin/lash-bearing Eye layers; this is an editable review mask, not a certified final clipping boundary.',
 limitedUpwardGaze:{dx:[-8,8],dy:-6,status:'Not accepted',reason:'Clipping exposes a thin pale arc at the upper eyelid, especially on the viewer-left eye; viewer-left iris also meets an abrupt right edge at +8/-6. No eye scaling, eyeliner changes or new iris painting were used to conceal this.'},
 remainingWork:'Refine the clipping boundary at the original lash/iris seam and review the small sclera color seam in Cubism at actual scale. The original iris still lacks hidden artwork beyond the photographed upper edge.',
 unimplemented:['downward gaze','blink','closed eyelid artwork','Cubism keyforms and export']
};
const comparisonNames=[
 ['Original source','../codia-eyes-reference.png'],
 ['V2 neutral, no clipping','both-eyes-neutral.crop.png'],
 ['V2 left/up (-8,-6), opening clipping','both-eyes-shift-left8-up6-clipped.crop.png'],
 ['V2 right/up (+8,-6), opening clipping','both-eyes-shift-right8-up6-clipped.crop.png']
];
const rowHeight=crop.height+26,items=[];
for(let n=0;n<comparisonNames.length;n++){
 const[label,name]=comparisonNames[n];
 items.push({input:Buffer.from(`<svg width="${crop.width}" height="26"><rect width="100%" height="100%" fill="#f3eef9"/><text x="8" y="18" fill="#392f49" font-family="Arial" font-size="13">${label}</text></svg>`),left:0,top:n*rowHeight});
 items.push({input:path.join(outDir,name),left:0,top:n*rowHeight+26});
}
await sharp({create:{width:crop.width,height:rowHeight*comparisonNames.length,channels:4,background:'#fff'}}).composite(items).png().toFile(path.join(outDir,'comparison-review.png'));
await fs.writeFile(path.join(outDir,'validation.json'),JSON.stringify(validation,null,2)+'\n');
console.log(JSON.stringify({outDir,results,originalPixels:validation.originalPixels,neutralComposite:validation.neutralComposite},null,2));
