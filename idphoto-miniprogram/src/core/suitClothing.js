'use strict';
const {resizeBilinearRGBA} = require('./mattingModel');
const {suitCompose} = require('./suit');
const {validRect} = require('./suitSafety');
const invalid = () => Object.assign(new Error('衣物解析结果无效，已拒绝换装'), {code: 'SUIT_CLOTHING_INVALID'});

function faceProtection(rect, width, height, points) {
  if (!validRect(rect, width, height)) throw invalid();
  const mask = new Uint8Array(width * height);
  const fillRect = (endY) => { for (let y = Math.floor(rect.y); y < Math.min(height, Math.ceil(endY)); y++)
    mask.fill(1, y * width + Math.floor(rect.x), y * width + Math.ceil(rect.x + rect.w)); };
  if (!points) { fillRect(rect.y + rect.h); return mask; }
  if (!Array.isArray(points) || points.length < 3 || !points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height)) throw invalid();
  const sorted = points.slice().sort((a,b) => a.x-b.x || a.y-b.y);
  const cross = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const half = list => { const out=[]; for (const p of list) { while(out.length>=2 && cross(out[out.length-2],out[out.length-1],p)<=0) out.pop(); out.push(p); } return out; };
  const lower=half(sorted),upper=half(sorted.slice().reverse());
  const hull=lower.slice(0,-1).concat(upper.slice(0,-1));
  if(hull.length<3) throw invalid();
  const top=Math.min(...hull.map(p=>p.y)),bottom=Math.max(...hull.map(p=>p.y));
  // 关键点通常不含额头；其上方仍保护整个检测框。下方按实测点凸包保护，避免把旧衣也当成脸。
  fillRect(top);
  for(let y=Math.floor(top);y<=Math.ceil(bottom)&&y<height;y++) {
    const cuts=[];
    for(let i=0;i<hull.length;i++){const a=hull[i],b=hull[(i+1)%hull.length];
      if(y>=Math.min(a.y,b.y)&&y<=Math.max(a.y,b.y)) {
        if(a.y===b.y)cuts.push(a.x,b.x);else cuts.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));
      }
    }
    if(cuts.length)mask.fill(1,y*width+Math.max(0,Math.floor(Math.min(...cuts))),y*width+Math.min(width,Math.ceil(Math.max(...cuts))+1));
  }
  return mask;
}

function prepareClothing(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba?.length !== width * height * 4) throw invalid();
  const resized = resizeBilinearRGBA(rgba, width, height, 256, 256);
  const out = new Float32Array(256 * 256 * 3);
  for (let i = 0; i < 256 * 256; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = resized[i * 4 + c] / 255;
  return out;
}

function decodeClothingLayers(tensor, width, height, rgba) {
  if (tensor?.dims?.join(',') !== '1,256,256,6' || tensor.data?.length !== 256 * 256 * 6 ||
    !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw invalid();
  const classes = new Uint8Array(256 * 256);
  const confidence = new Float32Array(classes.length), second = new Uint8Array(classes.length);
  for (let i = 0; i < classes.length; i++) {
    let best = -Infinity, label = 0;
    for (let c = 0; c < 6; c++) {
      const v = tensor.data[i * 6 + c];
      if (!Number.isFinite(v)) throw invalid();
      if (v > best) { best = v; label = c; }
    }
    classes[i] = label;
    let sum=0,runner=-Infinity;
    for(let c=0;c<6;c++) {const value=tensor.data[i*6+c];sum+=Math.exp(value-best);if(c!==label&&value>runner){runner=value;second[i]=c;}}
    confidence[i]=1/sum;
  }
  const removed = new Uint8Array(classes.length);
  for (let y=0;y<256;y++) for (let x=0;x<256;x++) {
    const i=y*256+x;
    if(classes[i]===4) { removed[i]=1; continue; }
    if(classes[i]!==0) continue;
    // 人体matte可能保留衣边，语义模型却将该边判为背景；只在衣物邻接的背景格消除残边。
    let cloth=false,body=false;
    for(let yy=Math.max(0,y-1);yy<=Math.min(255,y+1);yy++) for(let xx=Math.max(0,x-1);xx<=Math.min(255,x+1);xx++) {
      const label=classes[yy*256+xx];
      if(label===4)cloth=true;
      if(label===1||label===2||label===3||label===5)body=true;
    }
    if(cloth&&!body)removed[i]=1;
  }
  const out = new Uint8Array(width * height), background = new Uint8Array(width * height);
  if(rgba&&rgba.length!==width*height*4)throw invalid();
  const guide=rgba?resizeBilinearRGBA(rgba,width,height,256,256):null;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const gx=Math.min(255,Math.floor((x+0.5)*256/width)),gy=Math.min(255,Math.floor((y+0.5)*256/height)),g=gy*256+gx,i=y*width+x;
    out[i]=removed[g];
    background[i]=classes[g]===0?1:0;
    // 只细化“衣服/身体皮肤”之间的不确定格；高置信皮肤、头发及面部类别保持原判定。
    if(!guide||confidence[g]>=0.9||!((classes[g]===2&&second[g]===4)||(classes[g]===4&&second[g]===2)))continue;
    let skin=Infinity,cloth=Infinity;
    for(let yy=Math.max(0,gy-2);yy<=Math.min(255,gy+2);yy++)for(let xx=Math.max(0,gx-2);xx<=Math.min(255,gx+2);xx++) {
      const j=yy*256+xx;if(confidence[j]<0.9||(classes[j]!==2&&classes[j]!==4))continue;
      let distance=0;for(let c=0;c<3;c++)distance+=(rgba[i*4+c]-guide[j*4+c])**2;
      if(classes[j]===2)skin=Math.min(skin,distance);else cloth=Math.min(cloth,distance);
    }
    if(Number.isFinite(skin)&&Number.isFinite(cloth)&&skin!==cloth)out[i]=cloth<skin?1:0;
  }
  return {clothing: out, background};
}
function decodeClothing(tensor, width, height, rgba) { return decodeClothingLayers(tensor, width, height, rgba).clothing; }

function composeParsedSuit(p) {
  const {rgba, alpha, width, height, faceRect, clothing} = p;
  if (!validRect(faceRect, width, height) || clothing?.length !== width * height ||
    rgba?.length !== width * height * 4 || alpha?.length !== width * height) throw invalid();
  if(p.background && (p.background.length !== width*height || !p.background.every(v=>v===0||v===1)))throw invalid();
  const protectedMask = faceProtection(faceRect, width, height, p.facePoints);
  const removed = new Uint8Array(clothing.length), outputAlpha = new Float32Array(alpha);
  let count = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (clothing[i] !== 0 && clothing[i] !== 1) throw invalid();
    if (protectedMask[i]) continue;
    if (clothing[i]) { removed[i] = 1; outputAlpha[i] = 0; count++; }
    // 云解析已保护头发邻域；脸部保护仍优先。旧本地模型保持原清理范围。
    else if (p.background?.[i] && (p.backgroundMode === 'face-exterior' || y >= p.protectUntilY)) { outputAlpha[i] = 0; removed[i] = 1; }
  }
  if (!count) throw invalid();
  const out = (p.compose || suitCompose)(rgba, alpha, width, height, p.tpl, p.tplW, p.tplH, p.place, p.rotateDeg,
    {protectUntilY: p.protectUntilY, clothingMask: removed, outputAlpha});
  const alphaLimit = new Float32Array(alpha.length).fill(1);
  for (let i = 0; i < alpha.length; i++) if (removed[i]) alphaLimit[i] = outputAlpha[i];
  return {rgba: out, alpha: outputAlpha, alphaLimit, protectedMask, removedClothingPixels: count};
}
module.exports = {prepareClothing, decodeClothing, decodeClothingLayers, composeParsedSuit, faceProtection};
