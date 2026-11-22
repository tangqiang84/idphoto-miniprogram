'use strict';
const {getSpec}=require('./specLibrary');
const POSE_MIN_SCORE=0.5,ROTATE_LIMIT_DEG=15;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
function validRect(r,w,h){return !!r&&[r.x,r.y,r.w,r.h].every(finite)&&r.w>0&&r.h>0&&r.x>=0&&r.y>=0&&r.x+r.w<=w&&r.y+r.h<=h;}
function measuredShoulders(points,w,h){
 if(!Array.isArray(points))return null;
 const pick=name=>{const found=points.filter(p=>p?.name===name);if(found.length!==1)return null;const p=found[0];return finite(p.x)&&finite(p.y)&&finite(p.score)&&p.score>=POSE_MIN_SCORE&&p.score<=1&&p.x>=0&&p.y>=0&&p.x<w&&p.y<h?p:null;};
 const l=pick('left_shoulder'),r=pick('right_shoulder');
 if(!l||!r||r.x===l.x)return null;
 return l.x<r.x?{l,r}:{l:r,r:l};
}
function assessSuitSignals(p={}){
 const face=p.face,pose=p.pose,w=p.canvasW,h=p.canvasH,spec=getSpec(p.spec?.id);
 const source=face?.source==='landmarks'?'landmarks':face?.source==='estimate'?'estimate':'physical';
 const fail=(reason,message,extra={})=>({ok:false,reason,message,source,measuredShoulders:false,shoulderAngleDeg:null,...extra});
 if(!spec)return fail('suit:no_spec','仅支持现有九种标准证件照规格');
 if(!finite(w)||!finite(h)||w<=0||h<=0)return fail('suit:invalid_canvas','换装画布尺寸无效');
 if(p.source&&p.source.width>p.source.height)return fail('suit:horizontal_input','横向原图不支持换装，请使用正面标准证件照');
 if(face?.faceCount>1||pose?.personCount>1)return fail('suit:multiple_people','检测到多人，不能换装');
 if(!face||face.source!=='landmarks'||face.quality!=='good'||face.faceCount!==1||!validRect(face.rect,w,h))return fail('suit:unreliable_face','未取得可靠的单人脸部信号，不能用估算代替换装定位');
 if(![face.chinY,face.crownY,face.headH,face.faceCenterX].every(finite)||face.headH<=0||face.crownY<0||face.chinY<=face.crownY||face.chinY>=h)return fail('suit:unreliable_face','脸部位置不完整，无法安全换装');
 const viewport=p.viewport||{x:0,y:0,w,h};
 if(!validRect(viewport,w,h)||face.rect.y<viewport.y||face.rect.y+face.rect.h>viewport.y+viewport.h||face.rect.x<viewport.x||face.rect.x+face.rect.w>viewport.x+viewport.w)return fail('suit:unsupported_composition','裁剪后脸部不完整，请重新选择正面标准构图');
 const ratio=face.headH/viewport.h;
 if(ratio<spec.headHeightRatioMin||ratio>spec.headHeightRatioMax)return fail('suit:unsupported_composition','头部占比不符合所选标准构图，请重新裁剪后换装');
 const pair=measuredShoulders(pose?.points,w,h);
 if(!pair)return fail('suit:unreliable_shoulders','未检测到可靠双肩，不能以估算肩宽或默认角度换装');
 const angle=Math.atan2(pair.r.y-pair.l.y,pair.r.x-pair.l.x)*180/Math.PI;
 if(Math.abs(angle)>ROTATE_LIMIT_DEG)return fail('suit:unsupported_composition','肩线倾斜过大，请使用正面端正证件照',{source:'pose',measuredShoulders:true,shoulderAngleDeg:angle});
 return {ok:true,reason:null,message:'',source:'pose',measuredShoulders:true,shoulderAngleDeg:angle,
  protectedRect:{...face.rect},protectUntilY:Math.ceil(Math.max(face.chinY,face.rect.y+face.rect.h)),pair};
}
module.exports={assessSuitSignals,measuredShoulders,validRect,POSE_MIN_SCORE,ROTATE_LIMIT_DEG};
