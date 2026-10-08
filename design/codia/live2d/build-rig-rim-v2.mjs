#!/usr/bin/env node
// Add two stationary lower-opening masks. Existing v1 artwork is immutable.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const dir=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(dir,'../../../.local-tools/live2d/authoring/package.json'));
const {PNG}=require('pngjs'),sharp=require('sharp');
const {readPsd,writePsdBuffer,initializeCanvas}=require('ag-psd');
const imageData=(width,height,data=new Uint8ClampedArray(width*height*4))=>({width,height,data});
initializeCanvas(()=>{throw Error('Canvas unused');},imageData);
const sha=b=>createHash('sha256').update(b).digest('hex');
const input=path.join(dir,'codia-rig-rim-v1.psd'),prefix=path.join(dir,'codia-rig-rim-v2');
const assets=path.join(dir,'source/codia-rim-v2');
const flatten=(ns,p='')=>ns.flatMap(n=>n.children?flatten(n.children,p+n.name+'/'):[{node:n,path:p+n.name}]);
const prop=n=>({name:n.name,left:n.left,top:n.top,right:n.right,bottom:n.bottom,opacity:n.opacity??1,hidden:Boolean(n.hidden),blendMode:n.blendMode});
const hierarchy=ns=>ns.map(n=>({name:n.name,...(n.children?{children:hierarchy(n.children)}:{})}));
const lowerOpeningSvg=(width,height,cx,cy,r)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><path d="M0 0 H${width} V${cy} H${cx+r} A${r} ${r} 0 0 1 ${cx-r} ${cy} H0 Z" fill="white"/></svg>\n`;
async function main(){
  const inputBytes=await fs.readFile(input),geometryBytes=await fs.readFile(path.join(dir,'source/codia-rim-v1/geometry.json'));
  const geometry=JSON.parse(geometryBytes),[cx,cy]=geometry.chosen.center,r=geometry.chosen.radius;
  const psd=readPsd(inputBytes,{useImageData:true,skipThumbnail:true}),{width,height}=psd;
  if(width!==1254||height!==1254)throw Error('Expected actual source canvas 1254×1254');
  const old=flatten(psd.children),oldHierarchy=hierarchy(psd.children);
  if(old.length!==20||old.some(e=>e.node.name==='HeadOpeningMask'))throw Error('Expected v1 with exactly 20 layers and no head opening mask');
  const before=new Map(old.map(e=>[e.path,{pixels:Buffer.from(e.node.imageData.data),properties:prop(e.node)}]));
  const circle=old.find(e=>e.path==='OpeningMask').node.imageData.data;
  const mask=Buffer.alloc(width*height*4);
  let fullTopPixels=0,copiedBottomPixels=0,bottomAlphaDifferences=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,top=y+0.5<cy,a=top?255:circle[i+3];
    if(top)fullTopPixels++;else{copiedBottomPixels++;if(a!==circle[i+3])bottomAlphaDifferences++;}
    if(a){mask[i]=255;mask[i+1]=255;mask[i+2]=255;mask[i+3]=a;}
  }
  const hands=old.filter(e=>['HandLeft_Visible','HandRight_Visible'].includes(e.node.name));
  let handMaxRadius=0,handMaxPixel=null;
  for(const hand of hands)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const alpha=hand.node.imageData.data[(y*width+x)*4+3];
    if(!alpha)continue;
    const distance=Math.hypot(x+0.5-cx,y+0.5-cy);
    if(distance>handMaxRadius){handMaxRadius=distance;handMaxPixel={layer:hand.node.name,x,y,alpha,distance};}
  }
  const handRadius=handMaxRadius+2;
  const handCirclePng=await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${cx}" cy="${cy}" r="${handRadius}" fill="white"/></svg>`)).png().toBuffer();
  const handCircle=PNG.sync.read(handCirclePng).data,handMask=Buffer.alloc(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4,a=y+0.5<cy?255:handCircle[i+3];
    if(a){handMask[i]=255;handMask[i+1]=255;handMask[i+2]=255;handMask[i+3]=a;}
  }
  const handNeutral=hands.map(hand=>{
    let nontransparentPixels=0,partiallyClippedPixels=0,fullyClippedPixels=0,minMaskAlpha=255;
    for(let i=0;i<handMask.length;i+=4){if(!hand.node.imageData.data[i+3])continue;nontransparentPixels++;minMaskAlpha=Math.min(minMaskAlpha,handMask[i+3]);if(handMask[i+3]<255)partiallyClippedPixels++;if(!handMask[i+3])fullyClippedPixels++;}
    if(partiallyClippedPixels)throw Error('Hand neutral pose is clipped: '+hand.node.name);
    return{layer:hand.node.name,nontransparentPixels,minMaskAlpha,partiallyClippedPixels,fullyClippedPixels};
  });
  const makeLayer=(name,data)=>({name,left:0,top:0,right:width,bottom:height,opacity:0,hidden:false,blendMode:'normal',imageData:imageData(width,height,new Uint8ClampedArray(data))});
  const newLayers=[makeLayer('HeadOpeningMask',mask),makeLayer('HandOpeningMask',handMask)];
  const baseline=Buffer.from(psd.imageData.data);
  // ag-psd's merged-image white-matte conversion is lossy on a decoded composite.
  // Reuse the exact canonical PNG supplied when writing v1, avoiding a second conversion.
  const neutralBytes=await fs.readFile(path.join(dir,'codia-rig-rim-v1.neutral.png'));
  const neutral=PNG.sync.read(neutralBytes);
  if(neutral.width!==width||neutral.height!==height)throw Error('Unexpected neutral PNG dimensions');
  psd.imageData=imageData(width,height,new Uint8ClampedArray(neutral.data));
  psd.children.push(...newLayers);
  const bytes=writePsdBuffer(psd,{noBackground:true,trimImageData:false,generateThumbnail:false});
  const decoded=readPsd(bytes,{useImageData:true,skipThumbnail:true}),entries=flatten(decoded.children);
  const decodedOld=entries.filter(e=>!['HeadOpeningMask','HandOpeningMask'].includes(e.path));
  if(entries.length!==22||JSON.stringify(hierarchy(decoded.children.slice(0,-2)))!==JSON.stringify(oldHierarchy))throw Error('Original hierarchy changed');
  for(const e of decodedOld){const b=before.get(e.path);if(!b||!b.pixels.equals(Buffer.from(e.node.imageData.data))||JSON.stringify(b.properties)!==JSON.stringify(prop(e.node)))throw Error('Original layer changed: '+e.path);}
  const check=entries.find(e=>e.path==='HeadOpeningMask');
  if(!Buffer.from(check.node.imageData.data).equals(mask)||check.node.opacity!==0||check.node.hidden)throw Error('Mask packaging changed');
  const handCheck=entries.find(e=>e.path==='HandOpeningMask');
  if(!Buffer.from(handCheck.node.imageData.data).equals(handMask)||handCheck.node.opacity!==0||handCheck.node.hidden)throw Error('Hand mask packaging changed');
  if(!baseline.equals(Buffer.from(decoded.imageData.data)))throw Error('Neutral composite changed');
  await fs.mkdir(assets,{recursive:true});
  const sourceSvg=lowerOpeningSvg(width,height,cx,cy,r);
  await fs.writeFile(path.join(assets,'HeadOpeningMask.svg'),sourceSvg);
  await fs.writeFile(path.join(assets,'HeadOpeningMask.png'),PNG.sync.write({width,height,data:mask},{colorType:6}));
  await fs.writeFile(path.join(assets,'HandOpeningMask.svg'),lowerOpeningSvg(width,height,cx,cy,handRadius));
  await fs.writeFile(path.join(assets,'HandOpeningMask.png'),PNG.sync.write({width,height,data:handMask},{colorType:6}));
  await fs.writeFile(prefix+'.psd',bytes);
  await fs.writeFile(prefix+'.neutral.png',neutralBytes);
  const cells=[];
  for(const [j,name,data]of [[0,'Body / sleeves: OpeningMask',Buffer.from(circle)],[1,'Head: HeadOpeningMask',mask],[2,'Hands: HandOpeningMask',handMask]]){
    const header=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="627" height="34"><rect width="100%" height="100%" fill="white"/><text x="12" y="23" font-size="16">${name}</text></svg>`);
    const picture=await sharp(PNG.sync.write({width,height,data})).resize(627,627).flatten({background:'#705d86'}).extend({top:34,bottom:0,left:0,right:0,background:'white'}).composite([{input:header,left:0,top:0}]).png().toBuffer();
    cells.push({input:picture,left:j*627,top:0});
  }
  await sharp({create:{width:1881,height:661,channels:4,background:'white'}}).composite(cells).png().toFile(prefix+'.mask-comparison.png');
  const metadata={canvas:[width,height],maxPixelCoordinate:[width-1,height-1],center:[cx,cy],radius:r,
    algorithm:'For source pixel center y+0.5 < cy, alpha=255 across the full canvas width; otherwise copy the exact alpha byte from existing OpeningMask. Nontransparent RGB is white; transparent RGB is zero.',
    split:{topRows:[0,621],bottomRows:[622,1253]},fullTopPixels,copiedBottomPixels,bottomAlphaDifferences,
    vectorSource:'HeadOpeningMask.svg',pngSource:'HeadOpeningMask.png',rasterizationNote:'SVG records continuous geometry; PNG uses pixel-center split and preserves existing lower-circle alpha exactly.',
    intendedUsage:{part:'HeadGroup',offscreenDrawing:true,clippingId:'Actual ArtMesh ID of HeadOpeningMask, not this display name',maskOpacity:0,maskVisible:true,maskParent:'Root stationary, outside BodyRise and HeadGroup',irisClips:'Keep each existing Eye Opening mask; do not append HeadOpeningMask to iris clip ID lists.'},
    hands:{name:'HandOpeningMask',center:[cx,cy],radius:handRadius,maximumOriginalNontransparentPixelRadius:handMaxRadius,radiusPadding:2,farthestPixel:handMaxPixel,pixelPositionConvention:'pixel centers x+0.5,y+0.5; all alpha>0 pixels, including antialias edges',neutralVerification:handNeutral,clippingTargets:['HandLeft_Visible','HandRight_Visible'],drawOrders:{HandRight_Visible:610,HandLeft_Visible:611},opacity:0,hidden:false,stationaryAtRoot:true}};
  await fs.writeFile(path.join(assets,'geometry.json'),JSON.stringify(metadata,null,2)+'\n');
  const report={status:'independent lower-opening mask candidate, no Editor or runtime acceptance',input,output:prefix+'.psd',inputSha256:sha(inputBytes),outputSha256:sha(bytes),width,height,originalLayerCount:20,outputLayerCount:22,
    original20LayersRgbaPropertiesParentsAndRelativeOrderPreserved:true,originalOpeningMaskUnchanged:true,newRootLayers:[prop(check.node),prop(handCheck.node)],neutralCompositeRgbaChanges:0,canonicalNeutralPngUnchanged:true,mergedImagePackaging:'Canonical original v1 PNG reused to avoid a second lossy white-matte/unmatte conversion in ag-psd; decoded merged-image RGBA also matches v1 exactly.',
    geometry:metadata,modifiedCmo3:false,editorImportVerified:false,offscreenConfigured:false,clippingAssigned:false,visualAcceptance:false,exportReady:false,
    limitations:['Mask must remain root-stationary; moving it with the head defeats the lower opening.',
      'PSD does not store Cubism Offscreen drawing or Clipping ID configuration. HeadGroup must render to offscreen, then be clipped by this new mask in Cubism.',
      'The entire upper half-plane is allowed intentionally; ears and ahoge can extend outside the upper circle. Lower-half visibility stays inside the original circle.',
      'The neutral PNG is unchanged raw PSD compositing, not a preview of configured Offscreen clipping or a validated hiding motion.',
      'Hands remain outside HeadGroup and require their own HandOpeningMask ClipIDs. Neutral alpha is preserved; actual Reach/BodyRise shapes must still be checked for full concealment at zero. Existing eye/body/neck quality limitations are not resolved by these masks.'],
    assets:[path.join(assets,'HeadOpeningMask.svg'),path.join(assets,'HeadOpeningMask.png'),path.join(assets,'HandOpeningMask.svg'),path.join(assets,'HandOpeningMask.png'),path.join(assets,'geometry.json')],previews:[prefix+'.neutral.png',prefix+'.mask-comparison.png']};
  await fs.writeFile(prefix+'.validation.json',JSON.stringify(report,null,2)+'\n');
  if(!(await fs.readFile(input)).equals(inputBytes)||!(await fs.readFile(path.join(dir,'source/codia-rim-v1/geometry.json'))).equals(geometryBytes))throw Error('Original v1 input changed');
  console.log(JSON.stringify({output:report.output,original20LayersPreserved:true,neutralCompositeRgbaChanges:0,newMask:{opacity:check.node.opacity,hidden:check.node.hidden},geometry:metadata},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
