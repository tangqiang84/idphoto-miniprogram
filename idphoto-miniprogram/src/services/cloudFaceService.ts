import { mapSuitPoints } from '../core/suitImageSpace';
import { makeCloudFnAdapter } from './cloudFnAdapter';
import { analyzeFace } from '../core/face';
const MODEL_SHA = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';

export async function measureCloudSuitFace(imageB64: string, width: number, height: number, authorization: {check(): void}, target = {width, height}) {
  const traceId = 'suit-face-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
  try {
    authorization.check();
    if (!imageB64 || imageB64.length > 4 * 1024 * 1024 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 1600000) throw {code: 'FACE_INPUT_INVALID'};
    const result = await makeCloudFnAdapter({name:'facepoints', authorization, resultType:'raw'}).call({
      image: imageB64, width, height, consent:'faceCloudEnhance', suitConsent:'suitSwap',
      purpose:'suit_face_landmarks', region:'CN', retain:false, train:false,
    });
    authorization.check();
    if (result.ok !== true || result.faceCount !== 1 || result.width !== width || result.height !== height || result.provider !== 'mediapipe-face-landmarker-cpu' || result.modelSha256 !== MODEL_SHA ||
      !Array.isArray(result.points) || result.points.length !== 478 || !result.points.every((p: any) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height)) throw {code:'FACE_OUTPUT_INVALID'};
    const points: {x:number;y:number}[] = mapSuitPoints(result.points, width, height, target);
    const xs=points.map(p=>p.x), ys=points.map(p=>p.y);
    const rect={x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
    const measured=analyzeFace({points,rect,imageWidth:target.width,imageHeight:target.height,confidence:null});
    if (!measured.ok || measured.metrics?.quality !== 'good' || rect.width <= 0 || rect.height <= 0) throw {code:'FACE_UNRELIABLE'};
    authorization.check();
    return {ok:true,headLengthPx:measured.metrics.headLengthPx,source:'landmarks',metrics:measured.metrics,notes:measured.metrics.notes||[],
      faceRect:{x:rect.x,y:rect.y,w:rect.width,h:rect.height},faceCount:1,facePoints:points,
      provider:result.provider,rectSource:'landmark-envelope',traceId};
  } catch {
    authorization.check();
    console.warn('[suit-face]',{code:'SUIT_FACE_UNAVAILABLE',traceId});
    throw {code:'SUIT_FACE_UNAVAILABLE',message:'无法可靠识别单人面部，已停止换装，请更换照片',traceId};
  }
}
