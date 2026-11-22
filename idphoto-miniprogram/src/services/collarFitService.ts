import Taro from '@tarojs/taro';
import {makeCloudFnAdapter} from './cloudFnAdapter';
const PROVIDER='visible-neck-collar-cpu-v1';
const MODEL_SHA='35ec1ecd9ee7f85073c99c00020b7f6751b69506eeacf683bc8665f6117f85b0';
export async function fitCloudCollar(input: {imageB64:string|null;width:number;height:number}, work: {width:number;height:number;alpha:ArrayLike<number>}, face: any, template: any, authorization: {check():void}) {
  const traceId='collar-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
  try {
    authorization.check();
    const {width,height}=input;
    if (!input.imageB64 || !Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>768||height>768||work.alpha.length!==work.width*work.height) throw {code:'SUIT_INPUT_INVALID'};
    const alpha=new Uint8Array(width*height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const v=work.alpha[Math.min(work.height-1,Math.floor((y+.5)*work.height/height))*work.width+Math.min(work.width-1,Math.floor((x+.5)*work.width/width))];
      if(!Number.isFinite(v)||v<0||v>1)throw {code:'SUIT_INPUT_INVALID'};
      alpha[y*width+x]=Math.round(v*255);
    }
    const sx=width/work.width,sy=height/work.height;
    const response=await makeCloudFnAdapter({name:'suitfit',resultType:'raw',authorization}).call({
      ...input,image:input.imageB64,imageB64:undefined,alphaB64:Taro.arrayBufferToBase64(alpha.buffer),
      face:{x:face.rect.x*sx,y:face.rect.y*sy,w:face.rect.w*sx,h:face.rect.h*sy,chinY:face.chinY*sy},
      templateId:template.id,consent:'faceCloudEnhance',suitConsent:'suitSwap',purpose:'suit_collar_fit',region:'CN',retain:false,train:false,
    });
    authorization.check();
    if(response.ok!==true)throw {code:['SUIT_NECK_UNAVAILABLE','SUIT_COLLAR_UNSUPPORTED'].includes(response.code)?response.code:'SUIT_FIT_UNAVAILABLE'};
    const g=response.geometry;
    if(response.provider!==PROVIDER||response.modelSha256!==MODEL_SHA||response.templateId!==template.id||response.templateSha256!==template.sha256||response.width!==width||response.height!==height||!g||![g.left,g.top,g.scale,g.protectY,g.templateWidth,g.templateHeight].every(Number.isFinite)||g.templateWidth!==768||g.templateHeight!==768||g.scale<=0||g.scale>8||g.protectY<0||g.protectY>=767||Math.abs(g.left)>width*8||Math.abs(g.top)>height*8)throw {code:'SUIT_FIT_INVALID'};
    return {geometry:{...g,left:g.left/sx,top:g.top/sy,scale:g.scale/sy,scaleX:g.scale/sx},evidence:{provider:PROVIDER,modelSha256:MODEL_SHA,traceId,alignment:'visible-neck-opening',inputWidth:width,inputHeight:height}};
  } catch(e:any) {
    authorization.check();const code=['SUIT_NECK_UNAVAILABLE','SUIT_COLLAR_UNSUPPORTED','SUIT_FIT_INVALID'].includes(e?.code)?e.code:'SUIT_FIT_UNAVAILABLE';
    console.warn('[collar-fit]',{code,traceId});
    throw {code,message:code==='SUIT_NECK_UNAVAILABLE'||code==='SUIT_COLLAR_UNSUPPORTED'?'领口无法安全贴合，请更换模板或使用无遮挡正面照片':'领口定位暂不可用，已停止换装',traceId};
  }
}
