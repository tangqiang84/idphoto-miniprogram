import Taro from '@tarojs/taro';
import { planSuitImage } from '../core/suitImageSpace';
// 实测双肩通过matting的pose路由获取，复用已有百度配置；缺少可靠信号时拒绝换装。
import { CLOUD_CALL_TIMEOUT_MS } from '../core/asyncUtils';
import { parsePoseResult, mapPoseToCanvas, REASON } from '../core/poseContract';
import { makeCloudFnAdapter } from './cloudFnAdapter';

// pose 调用超时：与云端抠图同档（15s）。实测 CPU 上 MoveNet Lightning 单次推理百毫秒级，
// 余量主要给云函数冷启动与网络（真机冷启动可能数秒，#70 事故就是没这个闸门）。
export const POSE_TIMEOUT_MS = CLOUD_CALL_TIMEOUT_MS;

export interface PoseRequest {
  /** 人像区域图像的 base64（不含 dataURL 前缀；页面层用离屏 canvas 的 toDataURL 取得） */
  imageB64: string;
  /** 该区域的像素尺寸（云函数侧用于等比 letterbox） */
  width: number;
  height: number;
  /** 上传区域在工作画布中的矩形（F1 后通常是整张工作画布） */
  region: { x: number; y: number; w: number; h: number };
  canvasW: number;
  canvasH: number;
}

export interface PoseResult {
  ok: boolean;
  /** 换算到工作画布像素坐标的关键点（无则 null） */
  pose: { personCount?: number; points: { name: string; x: number; y: number; score: number }[]; model: string | null; latencyMs: number | null } | null;
  /** 失败原因码（posekey:xxx） */
  reason: string | null;
  message: string;
}

/**
 * 取 pose 关键点（L1）。任何失败都以原因码返回，不抛异常给调用方（缺少可靠信号时拒绝换装）。
 */
export async function requestPoseKeypoints(req: PoseRequest, authorization?: { check(): void; traceId?: string }): Promise<PoseResult> {
  try { if (!authorization) throw new Error('consent'); authorization.check(); }
  catch { return { ok: false, pose: null, reason: 'posekey:consent_required', message: '未同意上云姿态分析；缺少可靠双肩时不换装' }; }
  const { imageB64, width, height, region, canvasW, canvasH } = req;
  if (!imageB64) {
    return { ok: false, pose: null, reason: REASON.CALL_FAILED, message: '人像区域编码为空' };
  }
  try {
    const res: any = await makeCloudFnAdapter({ authorization, resultType: 'raw' }).call({
          action: 'pose',
          region: 'CN',
          purpose: 'pose_keypoints',
          consent: 'faceCloudEnhance',
          suitConsent: 'suitSwap',
          retain: false,
          train: false,
          width,
          height,
          image: imageB64,
    });
    authorization.check();
    const parsed = parsePoseResult(res);
    if (!parsed.ok) {
      return { ok: false, pose: null, reason: parsed.reason, message: parsed.message };
    }
    const points = mapPoseToCanvas(parsed.points, region, { canvasW, canvasH, clamp: false });
    return {
      ok: true,
      pose: { personCount: parsed.raw.personCount, points, model: parsed.model, latencyMs: parsed.latencyMs },
      reason: null,
      message: '',
    };
  } catch (e: any) {
    const m = String((e && e.message) || e);
    console.warn('[pose]', { code: e?.code || 'POSE_FAILED', traceId: e?.traceId || 'pose-' + Date.now() });
    // withTimeout 的错误消息形如「posekey: 云端响应超时（超时 15s）」
    const reason = m.indexOf('超时') >= 0 ? REASON.TIMEOUT : REASON.CALL_FAILED;
    return { ok: false, pose: null, reason, message: '姿态分析不可用；缺少可靠双肩时不换装' };
  }
}

/**
 * 把离屏 canvas 编码成 JPEG base64（去掉 dataURL 前缀）。
 * 失败（基础库不支持 toDataURL 等）返回 null —— 由调用方降级，不阻断换装主流程。
 */
export function encodeCanvasToJpegB64(canvas: any, quality = 0.8): string | null {
  try {
    if (!canvas || typeof canvas.toDataURL !== 'function') return null;
    const url: string = canvas.toDataURL('image/jpeg', quality);
    const idx = url.indexOf('base64,');
    return idx >= 0 ? url.slice(idx + 7) : null;
  } catch (e) {
    return null;
  }
}

/** 三项换装识别共用等比缩图；保留工作画布及已确认裁剪。 */
export function prepareSuitImage(canvas: any, width: number, height: number) {
  const size = planSuitImage(width, height);
  let input = canvas;
  if (size.width !== width || size.height !== height) {
    input = (Taro as any).createOffscreenCanvas({type:'2d',width:size.width,height:size.height});
    input.getContext('2d').drawImage(canvas,0,0,width,height,0,0,size.width,size.height);
  }
  return {...size,imageB64:encodeCanvasToJpegB64(input)};
}
