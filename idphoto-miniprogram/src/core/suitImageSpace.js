'use strict';
function validSize(width,height){return Number.isInteger(width)&&Number.isInteger(height)&&width>0&&height>0&&width<=4096&&height<=4096&&width*height<=2200000;}
function planSuitImage(width,height){
 if(!validSize(width,height))throw {code:'SUIT_INPUT_INVALID',message:'换装图片尺寸无效'};
 const scale=Math.min(1,768/Math.max(width,height));
 return {width:Math.max(1,Math.round(width*scale)),height:Math.max(1,Math.round(height*scale)),workWidth:width,workHeight:height};
}
function mapSuitPoints(points,width,height,target){
 if(!validSize(width,height)||!validSize(target.width,target.height))throw {code:'SUIT_INPUT_INVALID',message:'换装坐标尺寸无效'};
 return points.map(p=>({...p,x:p.x*target.width/width,y:p.y*target.height/height}));
}
function resizeSuitMask(mask,width,height,target){
 if(!validSize(width,height)||!validSize(target.width,target.height)||mask.length!==width*height)throw {code:'SUIT_INPUT_INVALID',message:'换装掩码尺寸无效'};
 if(width===target.width&&height===target.height)return mask;
 const out=new Uint8Array(target.width*target.height);
 // 离散掩码按像素中心最近邻映射，不能插值出新的类别。
 for(let y=0;y<target.height;y++)for(let x=0;x<target.width;x++)out[y*target.width+x]=mask[Math.min(height-1,Math.floor((y+.5)*height/target.height))*width+Math.min(width-1,Math.floor((x+.5)*width/target.width))];
 return out;
}
module.exports={planSuitImage,mapSuitPoints,resizeSuitMask};
