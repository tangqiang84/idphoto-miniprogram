// L1 姿态信号：posekey 云函数（P1 / 台账 #72+#74）
//
// 【定位】换装信号三级降级的第一级（L1）。L2 = faceDetect 关键点（services/faceService），
// L3 = 几何估算（core/face.js headMetricsFromBBox）。三条路径**同权**（#74 纪律）：
//   · 都有独立超时（#70 纪律：跨设备异步边界必须有硬闸门）
//   · 都返回原因码（#67 纪律：UI 失败提示必须带原因码，否则现场无法定位）
//   · 结果都带 source，批量验收按 source 分层统计（不再让"模拟器没测过"变成盲区）
//
// 【未部署时的行为】云函数未部署/模型缺失 → 返回 ok:false + reason（如 posekey:not_deployed），
// 调用方降级到 L2/L3 + 物理标尺通道；**绝不静默造点**（v1 的病根就是猜）。
import Taro from '@tarojs/taro';
import { withTimeout, CLOUD_CALL_TIMEOUT_MS } from '../core/asyncUtils';
import { parsePoseResult, mapPoseToCanvas, REASON } from '../core/poseContract';

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
  pose: { points: { name: string; x: number; y: number; score: number }[]; model: string | null; latencyMs: number | null } | null;
  /** 失败原因码（posekey:xxx） */
  reason: string | null;
  message: string;
}

/**
 * 取 pose 关键点（L1）。任何失败都以原因码返回，不抛异常给调用方（便于三级降级串联）。
 */
export async function requestPoseKeypoints(req: PoseRequest): Promise<PoseResult> {
  const { imageB64, width, height, region, canvasW, canvasH } = req;
  if (!imageB64) {
    return { ok: false, pose: null, reason: REASON.CALL_FAILED, message: '人像区域编码为空' };
  }
  try {
    const res: any = await withTimeout(
      Taro.cloud.callFunction({
        name: 'posekey',
        data: {
          region: 'CN',
          purpose: 'pose_keypoints',
          retain: false,
          train: false,
          width,
          height,
          image: imageB64,
        },
      }),
      POSE_TIMEOUT_MS,
      'posekey: 云端响应超时',
    );
    const parsed = parsePoseResult((res && res.result) || null);
    if (!parsed.ok) {
      return { ok: false, pose: null, reason: parsed.reason, message: parsed.message };
    }
    const points = mapPoseToCanvas(parsed.points, region, { canvasW, canvasH });
    return {
      ok: true,
      pose: { points, model: parsed.model, latencyMs: parsed.latencyMs },
      reason: null,
      message: '',
    };
  } catch (e: any) {
    const m = String((e && e.message) || e);
    // withTimeout 的错误消息形如「posekey: 云端响应超时（超时 15s）」
    const reason = m.indexOf('超时') >= 0 ? REASON.TIMEOUT : REASON.CALL_FAILED;
    return { ok: false, pose: null, reason, message: m };
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
