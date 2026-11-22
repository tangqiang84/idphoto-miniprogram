'use strict';
const {faceProtection}=require('./suitClothing');
function composeCollarSuit(p){
 const {rgba,alpha,width,height,clothing,background,tpl,tplW,tplH,geometry:g}=p;
 const invalid=()=>{throw {code:'SUIT_FIT_INVALID',message:'服装领口定位无效，已停止换装'};};
 if(!g||![g.left,g.top,g.scale,g.protectY,g.templateWidth,g.templateHeight].every(Number.isFinite)||g.scale<=0||g.templateWidth<=0||g.templateHeight<=1||g.protectY<0||g.protectY>=g.templateHeight-1||rgba?.length!==width*height*4||alpha?.length!==width*height||clothing?.length!==alpha.length||background?.length!==alpha.length||tpl?.length!==tplW*tplH*4)invalid();
 const protectedMask=faceProtection(p.faceRect,width,height,p.facePoints);
 const out=new Uint8ClampedArray(rgba),outputAlpha=Float32Array.from(alpha),alphaLimit=new Float32Array(alpha.length).fill(1);
 const scaleX=g.scaleX==null?g.scale:g.scaleX;if(!Number.isFinite(scaleX)||scaleX<=0)invalid();
 const remaining=g.templateHeight-1-g.protectY,extra=Math.max(0,height+2-(g.top+g.scale*(g.templateHeight-1))),coefficient=extra/(remaining*remaining);
 let removedClothingPixels=0;
 for(let y=0;y<height;y++){
  const relative=y-g.top-g.scale*g.protectY;
  const sy=extra>0&&relative>0?g.protectY+2*relative/(g.scale+Math.sqrt(g.scale*g.scale+4*coefficient*relative)):(y-g.top)/g.scale;
  const fy=sy*tplH/g.templateHeight;
  for(let x=0;x<width;x++){
   const i=y*width+x;if(protectedMask[i])continue;
   const removed=clothing[i]===1||background[i]===1;
   if(clothing[i]===1)removedClothingPixels++;
   const sourceAlpha=removed?0:alpha[i];let ta=0,tr=0,tg=0,tb=0;
   const fx=(x-g.left)/scaleX*tplW/g.templateWidth;
   if(fx>=0&&fy>=0&&fx<tplW-1&&fy<tplH-1){
    const ix=Math.floor(fx),iy=Math.floor(fy),dx=fx-ix,dy=fy-iy;
    const samples=[[ix,iy,(1-dx)*(1-dy)],[ix+1,iy,dx*(1-dy)],[ix,iy+1,(1-dx)*dy],[ix+1,iy+1,dx*dy]];
    for(const [xx,yy,weight] of samples){const j=(yy*tplW+xx)*4,a=tpl[j+3]/255*weight;ta+=a;tr+=tpl[j]*a;tg+=tpl[j+1]*a;tb+=tpl[j+2]*a;}
   }
   const a=ta+sourceAlpha*(1-ta);outputAlpha[i]=a;
   if(ta>0&&a>0){const j=i*4,under=sourceAlpha*(1-ta);out[j]=(tr+rgba[j]*under)/a;out[j+1]=(tg+rgba[j+1]*under)/a;out[j+2]=(tb+rgba[j+2]*under)/a;}
   if(removed)alphaLimit[i]=a;
  }
 }
 return {rgba:out,alpha:outputAlpha,alphaLimit,protectedMask,removedClothingPixels};
}
module.exports={composeCollarSuit};
