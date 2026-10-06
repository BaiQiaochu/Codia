#!/usr/bin/env node
// Mask-only review candidates. Existing Eye/Iris RGBA and PSDs are never written.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(root,'../../../.local-tools/live2d/authoring/package.json'));
const {PNG}=require('pngjs'),sharp=require('sharp');
const dir2=path.join(root,'source/codia-eye-patches-v2'),outDir=path.join(root,'source/codia-eye-patches-v3');
await fs.mkdir(outDir,{recursive:true});
const hash=d=>createHash('sha256').update(d).digest('hex'),hashes={};
const read=async p=>{const b=await fs.readFile(p);hashes[p]=hash(b);return PNG.sync.read(b);};
const source=await read(path.join(root,'source/codia-neutral-bust.png'));
const underpaint=await read(path.join(dir2,'both-eyes-sclera.crop.png'));
const {crop}=JSON.parse(await fs.readFile(path.join(dir2,'validation.json')));
const blank=()=>new PNG({width:source.width,height:source.height});
const cropImage=p=>{const o=new PNG({width:crop.width,height:crop.height});for(let y=0;y<crop.height;y++)p.data.copy(o.data,y*crop.width*4,((crop.top+y)*source.width+crop.left)*4,((crop.top+y)*source.width+crop.rightExclusive)*4);return o;};
const write=(name,p)=>fs.writeFile(path.join(outDir,name),PNG.sync.write(p));
const bbox=points=>points.length?{left:Math.min(...points.map(p=>p[0])),top:Math.min(...points.map(p=>p[1])),rightExclusive:Math.max(...points.map(p=>p[0]))+1,bottomExclusive:Math.max(...points.map(p=>p[1]))+1}:null;
const audit=(iris,mask)=>{
 let irisOpaquePixels=0,maskPartialAlphaPixels=0,notFullyCovered=0,fullyOmitted=0,partlyClipped=0,lostAlphaEquivalentPixels=0;
 const missed=[],zero=[],partial=[];
 for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
  const i=(y*source.width+x)*4,a=mask.data[i+3];if(a>0&&a<255)maskPartialAlphaPixels++;
  if(iris.data[i+3]<250)continue;irisOpaquePixels++;
  if(a<255){notFullyCovered++;missed.push([x,y]);lostAlphaEquivalentPixels+=(255-a)/255;if(a===0){fullyOmitted++;zero.push([x,y]);}else{partlyClipped++;partial.push([x,y]);}}
 }
 return{irisOpaquePixels,maskPartialAlphaPixels,notFullyCovered,fullyOmitted,partlyClipped,lostAlphaEquivalentPixels,missedBounds:bbox(missed),fullyOmittedBounds:bbox(zero),partialBounds:bbox(partial),missedPixelCoordinates:missed};
};
const dilate=(mask,r)=>{
 const o=blank();
 for(let y=crop.top;y<crop.bottomExclusive;y++)for(let x=crop.left;x<crop.rightExclusive;x++){
  let on=false;
  for(let dy=-r;dy<=r&&!on;dy++)for(let dx=-r;dx<=r;dx++)if(dx*dx+dy*dy<=r*r&&mask.data[((y+dy)*source.width+x+dx)*4+3]>0){on=true;break;}
  if(on)o.data.set([255,255,255,255],(y*source.width+x)*4);
 }return o;
};
const sides={},results=[];
const omittedOverlay=cropImage(source);
for(const side of ['Left','Right']){
 const iris=await read(path.join(dir2,`Iris${side}_reassigned.png`)),eye=await read(path.join(dir2,`Eye${side}_filled.png`)),v2=await read(path.join(dir2,`Eye${side}_opening-mask.png`));
 const hard=dilate(v2,0),one=dilate(v2,1),two=dilate(v2,2);
 sides[side]={iris,eye,v2,hard,one,two};
 for(const [tag,mask]of [['hard',hard],['1px',one],['2px',two]])await write(`Eye${side}_opening-mask-${tag}.png`,mask);
 const audits={v2:audit(iris,v2),hard:audit(iris,hard),onePixel:audit(iris,one),twoPixels:audit(iris,two)};
 const missed=blank();for(const[x,y]of audits.v2.missedPixelCoordinates){const i=(y*source.width+x)*4;const c=v2.data[i+3]===0?[250,30,60,255]:[255,160,10,255];missed.data.set(c,i);const j=((y-crop.top)*crop.width+x-crop.left)*4;if(j>=0&&j<omittedOverlay.data.length)omittedOverlay.data.set(c,j);}
 await write(`Eye${side}_v2-iris-clipped-mask.png`,missed);
 await write(`Eye${side}_v2-iris-clipped-mask.crop.png`,cropImage(missed));
 results.push({side,viewerSide:side==='Left'?'right':'left',audits});
}
await write('v2-neutral-iris-clipped-overlay.crop.png',omittedOverlay);
// Premultiplied bilinear sample mirrors the fractional source-pixel translation
// requested for the current Cubism pose, without scaling or repainting an iris.
const sample=(data,x,y)=>{
 const x0=Math.floor(x),y0=Math.floor(y),fx=x-x0,fy=y-y0;
 let a=0,c=[0,0,0];
 for(const[dx,dy,w]of[[0,0,(1-fx)*(1-fy)],[1,0,fx*(1-fy)],[0,1,(1-fx)*fy],[1,1,fx*fy]]){
  const sx=x0+dx,sy=y0+dy;if(sx<0||sy<0||sx>=source.width||sy>=source.height)continue;
  const i=(sy*source.width+sx)*4,aw=data[i+3]/255*w;a+=aw;for(let k=0;k<3;k++)c[k]+=data[i+k]*aw;
 }return a?[c[0]/a,c[1]/a,c[2]/a,a]:[0,0,0,0];
};
const compose=(kind,dx,dy)=>{
 const o=new PNG({width:crop.width,height:crop.height});o.data.set(underpaint.data);
 for(const{iris,...masks}of Object.values(sides))for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){
  const gx=x+crop.left,gy=y+crop.top,p=sample(iris.data,gx-dx,gy-dy);
  p[3]*=masks[kind].data[(gy*source.width+gx)*4+3]/255;if(!p[3])continue;
  const i=(y*crop.width+x)*4,da=o.data[i+3]/255,oa=p[3]+da*(1-p[3]);
  for(let c=0;c<3;c++)o.data[i+c]=Math.round((p[c]*p[3]+o.data[i+c]*da*(1-p[3]))/oa);
  o.data[i+3]=Math.round(oa*255);
 }return o;
};
for(const kind of ['v2','hard','one','two'])for(const[tag,dx,dy]of[['neutral',0,0],['left7p8-up3',-7.8,-3],['right7p8-up3',7.8,-3]]){
 const name=`${kind}-${tag}.crop.png`;await write(name,compose(kind,dx,dy));await sharp(path.join(outDir,name)).resize(crop.width*3,crop.height*3,{kernel:'nearest'}).png().toFile(path.join(outDir,name.replace('.png','.3x.png')));
}
const overlay=cropImage(source);
for(const{v2,two}of Object.values(sides))for(let y=0;y<crop.height;y++)for(let x=0;x<crop.width;x++){const si=((y+crop.top)*source.width+x+crop.left)*4,i=(y*crop.width+x)*4;if(two.data[si+3]&&!v2.data[si+3]){overlay.data[i]=Math.round(overlay.data[i]*.5);overlay.data[i+1]=Math.round(overlay.data[i+1]*.5+110);overlay.data[i+2]=Math.round(overlay.data[i+2]*.5+110);}}
await write('two-pixel-expansion-overlay.crop.png',overlay);
const rows=[['V2 neutral','v2-neutral.crop.png'],['V3 +1px neutral','one-neutral.crop.png'],['V3 +2px neutral','two-neutral.crop.png'],['V3 +2px left/up (-7.8,-3)','two-left7p8-up3.crop.png'],['V3 +2px right/up (+7.8,-3)','two-right7p8-up3.crop.png']],rowHeight=crop.height+26,items=[];
for(let n=0;n<rows.length;n++){items.push({input:Buffer.from(`<svg width="${crop.width}" height="26"><rect width="100%" height="100%" fill="#f3eef9"/><text x="8" y="18" fill="#392f49" font-family="Arial" font-size="13">${rows[n][0]}</text></svg>`),left:0,top:n*rowHeight});items.push({input:path.join(outDir,rows[n][1]),left:0,top:n*rowHeight+26});}
await sharp({create:{width:crop.width,height:rowHeight*rows.length,channels:4,background:'#fff'}}).composite(items).png().toFile(path.join(outDir,'comparison-review.png'));
const unchanged=[];for(const[p,h]of Object.entries(hashes))unchanged.push({path:p,sha256:h,unchanged:(hash(await fs.readFile(p))===h)});
const upperLidOverlapDiagnostics=[];
for(const[side,s]of Object.entries(sides))for(const[pose,dx,dy]of[['left/up',-7.8,-3],['right/up',7.8,-3]]){
 const counts={v2:0,one:0,two:0};
 for(let y=crop.top;y<(side==='Left'?580:600);y++)for(let x=crop.left;x<crop.rightExclusive;x++){
  const i=(y*source.width+x)*4;if(!s.eye.data[i+3]||(s.eye.data[i]+s.eye.data[i+1]+s.eye.data[i+2])/3>=120)continue;
  const a=sample(s.iris.data,x-dx,y-dy)[3];if(a<.25)continue;
  for(const kind of Object.keys(counts))if(s[kind].data[i+3]>127)counts[kind]++;
 }
 upperLidOverlapDiagnostics.push({side,pose,counts,note:'Conservative overlap candidates: shifted iris intersects a fixed dark Eye pixel in the upper-lid region. This is a risk measure, not semantic pixel classification.'});
}
const validation={version:3,status:'Independent mask candidates for review; not production or acceptance',crop,method:'Threshold existing v2 mask alpha >0 to 255, then Euclidean binary dilation with radius 1 or 2 source pixels. No Eye or Iris RGBA modified.',results,sourceFiles:unchanged,preview:{translation:[[-7.8,-3],[7.8,-3]],sampling:'Premultiplied bilinear iris sampling, mask at destination, source-over composition',cubismEquivalence:'Texture-only diagnostic; does not reproduce ArtMesh deformation, filtering, draw order or clipping-buffer resolution.'},upperLidOverlapDiagnostics,visualReview:{status:'Candidate only; not accepted',neutral:'2px hard mask removes almost all neutral Iris clipping (Left 0, Right 4 opaque pixels still omitted). Existing Eye/Iris RGBA are unchanged.',gaze:'No large spill outside the eye opening was seen at the supplied poses. Small lower-edge pale fragments/double lines remain; these are not fully explained by mask omission. At +7.8/-3 the viewer-left iris still meets an abrupt right-side cut.',eyeliner:'No broad overpainting of the upper lashes was visible at review scale. Dilation expands the clipping region near the lash seam, and the separate conservative overlap counts must be checked in Cubism with actual draw order; absence of overlap is not certified.',suggestion:'Use the 2px candidate only for controlled visual comparison with the current model. Do not treat this texture diagnostic as model acceptance.'},outputScope:'PNG alpha masks and diagnostic previews only; no PSD, GUI or import.'};
await fs.writeFile(path.join(outDir,'validation.json'),JSON.stringify(validation,null,2)+'\n');
console.log(JSON.stringify({outDir,results:results.map(r=>({side:r.side,audits:Object.fromEntries(Object.entries(r.audits).map(([k,v])=>{const{missedPixelCoordinates,...stats}=v;return[k,stats];}))})),allInputsUnchanged:unchanged.every(f=>f.unchanged)},null,2));
