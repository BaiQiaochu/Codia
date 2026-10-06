#!/usr/bin/env node
// Package generated hidden sclera pixels into source-coordinate patches only.
// Existing PSDs and original Eye/Iris data are never overwritten.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(root,'../../../.local-tools/live2d/authoring/package.json'));
const {PNG}=require('pngjs');
const sharp=require('sharp');
const {readPsd,initializeCanvas}=require('ag-psd');
initializeCanvas(()=>{throw Error('Canvas not used');},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}));
const hash=data=>createHash('sha256').update(data).digest('hex');
const sourcePath=path.join(root,'source/codia-neutral-bust.png');
const input=process.argv[2];
if(!input)throw Error('Pass the path of the generated sclera crop.');
const generatedPath=path.join(root,'source/codia-sclera-occlusion-v1.png');
const generatedBytes=await fs.readFile(input);
await fs.writeFile(generatedPath,generatedBytes);
const meta=await sharp(generatedBytes).metadata();
const manifest=JSON.parse(await fs.readFile(path.join(root,'source/codia-eyes-reference.coordinates.json'),'utf8'));
const {crop}=manifest;
const reference=PNG.sync.read(await fs.readFile(path.join(root,'source/codia-eyes-reference.png')));
const sourceBytes=await fs.readFile(sourcePath),source=PNG.sync.read(sourceBytes);
const generated=PNG.sync.read(await sharp(generatedBytes).resize(crop.width,crop.height,{fit:'fill',kernel:'lanczos3'}).ensureAlpha().png().toBuffer());
const psd=readPsd(await fs.readFile(path.join(root,'codia-source-aligned.psd')),{useImageData:true,skipThumbnail:true,skipCompositeImageData:true});
const flatten=a=>a.flatMap(l=>l.children?flatten(l.children):[l]);
const layers=flatten(psd.children);
const names=['Left','Right'];
const find=name=>{const l=layers.find(l=>l.name===name);if(!l||l.left!==0||l.top!==0||l.imageData.width!==source.width||l.imageData.height!==source.height)throw Error(`Bad source layer ${name}`);return l;};
const eyeBounds=manifest.eyes.map(e=>e.eyeCompleteReferenceBounds);
const insideEye=(x,y,pad=0)=>eyeBounds.some(b=>x+crop.left>=b.left-pad&&x+crop.left<b.rightExclusive+pad&&y+crop.top>=b.top-pad&&y+crop.top<b.bottomExclusive+pad);
const samples=[];
for(let y=12;y<crop.height-12;y++)for(let x=12;x<crop.width-12;x++){
 if(insideEye(x,y,4))continue;
 const i=(y*crop.width+x)*4;
 let gradient=0;
 for(const d of [-4,4,-crop.width*4,crop.width*4])for(let c=0;c<3;c++)gradient=Math.max(gradient,Math.abs(reference.data[i+c]-reference.data[i+d+c]));
 if(gradient>=18)samples.push([x,y]);
}
const score=(dx,dy)=>{
 let sum=0;
 for(const [x,y]of samples){const a=(y*crop.width+x)*4,b=((y+dy)*crop.width+x+dx)*4;for(let c=0;c<3;c++)sum+=Math.abs(reference.data[a+c]-generated.data[b+c]);}
 return sum/(samples.length*3);
};
let best={dx:0,dy:0,meanAbsoluteRgbDifference:score(0,0)};
for(let dy=-8;dy<=8;dy++)for(let dx=-8;dx<=8;dx++){
 const n=score(dx,dy);if(n<best.meanAbsoluteRgbDifference)best={dx,dy,meanAbsoluteRgbDifference:n};
}
// Translation is fitted to unchanged hair/skin edges outside both eye regions.
// Only hidden patch pixels will use the registered generated image.
const aligned=new PNG({width:crop.width,height:crop.height});
for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
 const sx=Math.max(0,Math.min(crop.width-1,x+best.dx)),sy=Math.max(0,Math.min(crop.height-1,y+best.dy));
 generated.data.copy(aligned.data,(y*crop.width+x)*4,(sy*crop.width+sx)*4,(sy*crop.width+sx)*4+4);
}
await fs.writeFile(path.join(root,'source/codia-sclera-occlusion-v1.aligned.png'),PNG.sync.write(aligned));
const directory=path.join(root,'source/codia-eye-patches-v1');
await fs.mkdir(directory,{recursive:true});
const write=async(name,png)=>fs.writeFile(path.join(directory,name),PNG.sync.write(png));
const blank=()=>new PNG({width:source.width,height:source.height});
const cropImage=png=>{
 const out=new PNG({width:crop.width,height:crop.height});
 for(let y=0;y<crop.height;y++)png.data.copy(out.data,y*crop.width*4,((y+crop.top)*source.width+crop.left)*4,((y+crop.top)*source.width+crop.rightExclusive)*4);
 return out;
};
const percentile=(a,p)=>a.length?a.slice().sort((x,y)=>x-y)[Math.floor((a.length-1)*p)]:null;
const results=[];
const patches={};
for(const side of names){
 const eye=find(`Eye${side}_Visible`),iris=find(`Iris${side}_Visible`),patch=blank(),filled=blank();
 filled.data.set(eye.imageData.data);
 let added=0,originalEyeChanges=0,patchOutsideIris=0,overlapWithEye=0;
 const boundary=[];
 for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
  const i=(y*source.width+x)*4;
  if(!iris.imageData.data[i+3])continue;
  if(eye.imageData.data[i+3])throw Error('Eye/Iris ownership unexpectedly overlaps');
  const j=((y-crop.top)*crop.width+x-crop.left)*4;
  for(let c=0;c<3;c++)patch.data[i+c]=aligned.data[j+c];
  patch.data[i+3]=iris.imageData.data[i+3];
  filled.data.set(patch.data.subarray(i,i+4),i);added++;
  for(const [nx,ny]of[[x-1,y],[x+1,y],[x,y-1],[x,y+1]]){
   const ni=(ny*source.width+nx)*4;
   if(!eye.imageData.data[ni+3])continue;
   const rgb=Array.from(eye.imageData.data.subarray(ni,ni+3));
   // Compare only nearby light, neutral sclera, excluding lash/skin edges.
   if(Math.min(...rgb)<190||Math.max(...rgb)-Math.min(...rgb)>28)continue;
   boundary.push(rgb.reduce((sum,v,c)=>sum+Math.abs(v-patch.data[i+c]),0)/3);
  }
 }
 for(let i=0;i<patch.data.length;i+=4){
  if(eye.imageData.data[i+3]&&filled.data.subarray(i,i+4).some((v,c)=>v!==eye.imageData.data[i+c]))originalEyeChanges++;
  if(patch.data[i+3]&&!iris.imageData.data[i+3])patchOutsideIris++;
  if(patch.data[i+3]&&eye.imageData.data[i+3])overlapWithEye++;
 }
 if(originalEyeChanges||patchOutsideIris||overlapWithEye)throw Error('Existing visible pixels were modified');
 patches[side]=patch;
 await write(`Eye${side}_sclera-patch.png`,patch);
 await write(`Eye${side}_filled.png`,filled);
 await write(`Eye${side}_filled.crop.png`,cropImage(filled));
 results.push({side,viewerSide:side==='Left'?'right':'left',patch:`Eye${side}_sclera-patch.png`,filledLayer:`Eye${side}_filled.png`,addedPixels:added,originalEyeChangedPixels:originalEyeChanges,patchPixelsOutsideIris:patchOutsideIris,patchOverlapWithVisibleEye:overlapWithEye,originalIrisRgbaSha256:hash(iris.imageData.data),irisLayerNotModified:true,boundaryLightScleraRgbDifference:{samples:boundary.length,mean:boundary.reduce((a,b)=>a+b,0)/boundary.length,median:percentile(boundary,0.5),p95:percentile(boundary,0.95)},fullCanvas:{width:source.width,height:source.height,left:0,top:0}});
}
const underpaint=blank();underpaint.data.set(source.data);
for(const side of names){const p=patches[side];for(let i=0;i<p.data.length;i+=4)if(p.data[i+3])underpaint.data.set(p.data.subarray(i,i+4),i);}
await write('both-eyes-sclera.crop.png',cropImage(underpaint));
const sourceOver=(dst,di,src,si)=>{
 const sa=src[si+3]/255,da=dst[di+3]/255,oa=sa+da*(1-sa);
 if(!oa){dst.fill(0,di,di+4);return;}
 for(let c=0;c<3;c++)dst[di+c]=Math.round((src[si+c]*sa+dst[di+c]*da*(1-sa))/oa);
 dst[di+3]=Math.round(oa*255);
};
const compose=(dx,dy)=>{
 const out=blank();out.data.set(underpaint.data);
 for(const side of names){const iris=find(`Iris${side}_Visible`).imageData.data;
  for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
   const i=(y*source.width+x)*4;if(!iris[i+3])continue;
   const tx=x+dx,ty=y+dy;if(tx<0||ty<0||tx>=source.width||ty>=source.height)continue;
   sourceOver(out.data,(ty*source.width+tx)*4,iris,i);
  }
 }return out;
};
const neutral=compose(0,0);
await write('both-eyes-neutral.crop.png',cropImage(neutral));
await write('both-eyes-shift-left8-up4-unclipped.crop.png',cropImage(compose(-8,-4)));
await write('both-eyes-shift-right8-up4-unclipped.crop.png',cropImage(compose(8,-4)));
let neutralAlphaDifferences=0,neutralRgbDifferences=0,maxNeutralRgbDifference=0,neutralChangedOutsideOriginalIris=0;
for(let i=0;i<source.data.length;i+=4){
 let diff=false;for(let c=0;c<3;c++){const d=Math.abs(source.data[i+c]-neutral.data[i+c]);maxNeutralRgbDifference=Math.max(maxNeutralRgbDifference,d);if(d)diff=true;}
 if(diff)neutralRgbDifferences++;
 if(source.data[i+3]!==neutral.data[i+3])neutralAlphaDifferences++;
 if((diff||source.data[i+3]!==neutral.data[i+3])&&!names.some(side=>find(`Iris${side}_Visible`).imageData.data[i+3]))neutralChangedOutsideOriginalIris++;
}
const validation={version:1,status:'Hidden sclera patches only; not a completed eye rig or blink asset',sourceSha256:hash(sourceBytes),generatedSha256:hash(generatedBytes),generatedSourceSize:{width:meta.width,height:meta.height},normalizedSize:{width:crop.width,height:crop.height},crop,
 alignment:{method:'Resize generated crop to reference dimensions, then translation-only edge comparison outside all eye bounds',sampleCount:samples.length,zeroOffsetMeanAbsoluteRgbDifference:score(0,0),sampleGeneratedAtTargetPlusOffset:best,originalReferenceNotResampled:true},
 results,neutralComposite:{neutralAlphaDifferences,neutralRgbDifferences,maxNeutralRgbDifference,neutralChangedOutsideOriginalIris,note:'Original eye-region alpha is 254, so adding an underlayer changes source-over alpha by one and can change RGB by rounding; original Eye/Iris layer bytes remain unchanged.'},
 integration:'Composite each full-canvas sclera-patch beneath the corresponding unchanged Iris and into transparent pixels of the corresponding Eye layer. Keep all current visible Eye pixels, including any later edge restoration. Do not replace newer Eye data wholesale with the filled example if newer source has additional pixels.',
 visualReview:{neutralAppearance:'Preserved; no visible proportion or position change in the neutral preview.',movementAcceptance:'Failed: residual dark iris outlines remain stationary in the original Eye layers when the Iris layers shift.',cause:'The original coarse Iris polygon does not contain every visible iris contour pixel. The strict hole-only fill deliberately preserves those visible Eye pixels.',requiredNextStep:'Review and correct Eye/Iris ownership using original pixels while preserving the neutral composite, then fill the newly exposed sclera holes. Do not expand this patch or alter visible Eye RGB silently.',blinkAcceptance:'Not implemented or assessed.'},
 limitations:['Shifted previews intentionally have no eye-opening clipping mask and are diagnostic only.','The strict hole-only fill cannot correct stationary iris-outline fragments that belong to the original visible Eye layers.','No eyelid redraw, closed-eye shape, blink, keyform, PSD or model export was created.','Original Eye masks contain skin/lash edges and must not be used uncritically as a complete eye-opening mask.']};
await fs.writeFile(path.join(directory,'validation.json'),JSON.stringify(validation,null,2)+'\n');
console.log(JSON.stringify({directory,alignment:validation.alignment,results,neutralComposite:validation.neutralComposite},null,2));
