// 人脸定位平台适配层（任务 #4）
//
// 【双轨策略】owner 2026-10-23 决策：
//   轨道 1（首选）：wx.createVKSession + track.face.mode=2（静态图片检测）
//     —— 微信官方现役推荐方案，基础库 2.25.0+（安卓微信 ≥8.0.25 / iOS ≥8.0.24）
//   轨道 2（降级）：wx.initFaceDetect + wx.faceDetect
//     —— 官方已标注「停止维护」，但基础库 2.18.0+ 覆盖更广，作为老设备兜底
//   轨道 3（兜底）：两者都不可用 → 返回 null，由调用方用 core/face.js 的几何估算
//
// 【关键兼容点】两条轨道的静态图片输入都是「RGBA 像素 ArrayBuffer」，
// 与 canvas.getImageData().data.buffer 完全同构，故服务层只需把同一份 buffer 喂进去。
//
// 【坐标口径】两条轨道返回的关键点均为「图像像素坐标系」（相对传入的 width/height），
// 与 core/face.js 的假设一致，无需换算。
//
// 【隐私】全部在端侧完成，不上传任何像素；返回的关键点用完即弃，不落盘、不上报。

import Taro from '@tarojs/taro';
import {
  analyzeFace,
  pickPrimaryFace,
  faceVerticalSpan,
  ratioWithinWindow,
  MIN_LANDMARK_COUNT,
} from '../core/face';

export type FacePoint = { x: number; y: number };
export type FaceRect = { x: number; y: number; width: number; height: number };

export type FaceDetectResult = {
  /** 是否成功定位到人脸 */
  ok: boolean;
  /** 使用的轨道：visionkit / faceDetect / none */
  source: 'visionkit' | 'faceDetect' | 'none';
  /** 关键点（图像像素坐标） */
  points: FacePoint[] | null;
  /** 人脸框（图像像素坐标） */
  rect: FaceRect | null;
  /** 置信度 0~1（无则 null） */
  confidence: number | null;
  /** 失败原因（供日志，不给用户看技术细节） */
  reason?: string;
};

export type HeadMeasureResult = {
  ok: boolean;
  /** 头部占比（0~1）；null 表示无法测量 */
  ratio: number | null;
  /** 估算/实测标记：'landmarks' 实测 | 'estimate' 估算 */
  source: 'landmarks' | 'estimate' | 'none';
  /** 可信度：good / low / estimated */
  quality: 'good' | 'low' | 'estimated' | 'none';
  /** 补充说明（面向用户的中文提示） */
  notes: string[];
  /** 头部度量原始数据（供换装等复用） */
  metrics: any;
};

// 统一的空结果
function emptyResult(reason: string, source: 'visionkit' | 'faceDetect' | 'none' = 'none'): FaceDetectResult {
  return { ok: false, source, points: null, rect: null, confidence: null, reason };
}

// 取出长度精确等于像素数组的 ArrayBuffer。
// 注意：不能直接用 rgba.buffer —— 若 rgba 是某个大 buffer 的视图（byteOffset>0），
// 传入的会是错位数据。slice() 会复制出长度精确的新数组（端侧最多 800×800×4 = 2.5MB，可接受）。
function exactBuffer(rgba: Uint8ClampedArray): ArrayBuffer {
  return rgba.slice().buffer;
}

// VisionKit 人脸检测的客户端版本门槛（官方《人脸检测》指南）：
//   安卓微信 ≥ 8.0.25 / iOS 微信 ≥ 8.0.24；基础库 ≥ 2.25.0。
// 预检目的：不支持的环境【不调用】 createVKSession ——
// 否则微信 SDK 自身会打印 "createVKSession:fail ... does not support version v1" 错误日志，
// 污染页面运行时错误统计（功能虽已正确降级，但日志噪音会掩盖真实问题）。
const VK_MIN_VERSION = { android: '8.0.25', ios: '8.0.24' };

// 比较形如 "8.0.25" 的版本号；a ≥ b 返回 true
function versionGE(a: string, b: string): boolean {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

// VisionKit 人脸检测能力预检
function isVisionKitSupported(): boolean {
  const anyWx: any = typeof wx !== 'undefined' ? wx : null;
  if (!anyWx || typeof anyWx.createVKSession !== 'function') return false;
  // 开发者工具模拟器不支持 VisionKit（无真机 GPU 能力）→ 直接跳过
  try {
    if (typeof anyWx.getDeviceInfo === 'function') {
      const di = anyWx.getDeviceInfo();
      if (di && di.platform === 'devtools') return false;
      const min = di && di.platform === 'ios' ? VK_MIN_VERSION.ios : VK_MIN_VERSION.android;
      if (di && typeof di.version === 'string' && !versionGE(di.version, min)) return false;
    }
  } catch (_) { /* 预检失败不阻断，交由实际调用兜底 */ }
  return true;
}

// ==================== 轨道 1：VisionKit（wx.createVKSession，静态图片模式） ====================

// VisionKit 静态图片检测：mode=2 时手动传入图像，检测结果通过 updateAnchors 事件回吐。
// 参考官方指南《人脸检测》：session.start → session.detectFace → session.on('updateAnchors')
function detectByVisionKit(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<FaceDetectResult> {
  const anyWx: any = typeof wx !== 'undefined' ? wx : null;
  if (!anyWx || typeof anyWx.createVKSession !== 'function') {
    return Promise.resolve(emptyResult('基础库不支持 createVKSession'));
  }
  // 能力预检：不支持的环境不调用，避免微信 SDK 打印 "does not support version" 错误日志
  if (!isVisionKitSupported()) {
    return Promise.resolve(emptyResult('当前设备不支持 VisionKit 人脸检测', 'visionkit'));
  }

  return new Promise<FaceDetectResult>((resolve) => {
    let session: any = null;
    let settled = false;
    // 超时兜底：VisionKit 事件驱动，无回调即视为失败（避免页面永久 loading）。
    // 注意：设备不支持时 start 回调会【立即带 err 返回】（见下方 start 回调），不消耗此超时；
    // 此定时器只兜底「回调永不触发」的异常情况，故给足真机余量。
    const timer = setTimeout(() => finish(emptyResult('VisionKit 检测超时', 'visionkit')), 2500);

    const cleanup = () => {
      clearTimeout(timer);
      try { if (session) { session.off && session.off('updateAnchors', onAnchors); session.stop && session.stop(); session.destroy && session.destroy(); } } catch (_) {}
      session = null;
    };

    const finish = (res: FaceDetectResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    const onAnchors = (payload: any) => {
      // 官方示例：session.on('updateAnchors', anchors => {...})，payload 即 anchors 数组；
      // 部分基础库版本回传 { anchors } 包装对象 → 两种都兼容
      const anchors: any[] = Array.isArray(payload)
        ? payload
        : (payload && Array.isArray(payload.anchors) ? payload.anchors : []);
      if (!anchors.length) return;

      const candidates = anchors.map((a: any) => ({
        points: Array.isArray(a && a.points) ? a.points.filter((p: any) => p && typeof p.x === 'number') : [],
        rect: normalizeVKRect(a),
        confidence: typeof (a && a.confidence) === 'number' ? a.confidence : null,
      })).filter((c: any) => c.points.length >= MIN_LANDMARK_COUNT);

      if (!candidates.length) {
        finish(emptyResult('VisionKit 未检出人脸', 'visionkit'));
        return;
      }
      const primary = pickPrimaryFace(candidates)!;
      finish({
        ok: true,
        source: 'visionkit',
        points: primary.points,
        rect: primary.rect,
        confidence: primary.confidence,
      });
    };

    try {
      session = anyWx.createVKSession({ track: { face: { mode: 2 } } });
      if (!session) { finish(emptyResult('createVKSession 返回空')); return; }
      session.on('updateAnchors', onAnchors);
      session.start((err: any) => {
        if (err) { finish(emptyResult('VisionKit 会话启动失败', 'visionkit')); return; }
        try {
          session.detectFace({
            frameBuffer: exactBuffer(rgba),
            width,
            height,
            scoreThreshold: 0.5,
            sourceType: 1,
            modelMode: 1,
          });
        } catch (e: any) {
          finish(emptyResult('detectFace 调用异常：' + String((e && e.message) || e), 'visionkit'));
        }
      });
    } catch (e: any) {
      finish(emptyResult('VisionKit 初始化异常：' + String((e && e.message) || e), 'visionkit'));
    }
  });
}

// VisionKit anchor → 统一 rect 形状 { x, y, width, height }
// 官方结构：origin 人脸框左上角(x,y)、size 人脸框宽高(w,h)
function normalizeVKRect(anchor: any): FaceRect | null {
  if (!anchor) return null;
  const o = anchor.origin;
  const s = anchor.size;
  if (!o || !s) return null;
  const x = typeof o.x === 'number' ? o.x : (Array.isArray(o) ? o[0] : null);
  const y = typeof o.y === 'number' ? o.y : (Array.isArray(o) ? o[1] : null);
  const w = typeof s.width === 'number' ? s.width : (Array.isArray(s) ? s[0] : null);
  const h = typeof s.height === 'number' ? s.height : (Array.isArray(s) ? s[1] : null);
  if (x == null || y == null || w == null || h == null) return null;
  return { x, y, width: w, height: h };
}

// ==================== 轨道 2：wx.faceDetect（已停止维护，覆盖老设备） ====================

function detectByFaceDetect(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<FaceDetectResult> {
  const anyWx: any = typeof wx !== 'undefined' ? wx : null;
  if (!anyWx || typeof anyWx.initFaceDetect !== 'function' || typeof anyWx.faceDetect !== 'function') {
    return Promise.resolve(emptyResult('基础库不支持 faceDetect'));
  }
  // 开发者工具模拟器不支持人脸检测 → 直接跳过，避免 SDK 报错日志噪音
  try {
    if (typeof anyWx.getDeviceInfo === 'function') {
      const di = anyWx.getDeviceInfo();
      if (di && di.platform === 'devtools') {
        return Promise.resolve(emptyResult('开发者工具不支持人脸检测', 'faceDetect'));
      }
    }
  } catch (_) { /* 预检失败不阻断 */ }

  return new Promise<FaceDetectResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(emptyResult('faceDetect 超时', 'faceDetect')), 3000);
    const stop = () => { try { anyWx.stopFaceDetect && anyWx.stopFaceDetect(); } catch (_) {} };

    const finish = (res: FaceDetectResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      resolve(res);
    };

    anyWx.initFaceDetect({
      success: () => {
        try {
          anyWx.faceDetect({
            frameBuffer: exactBuffer(rgba),
            width,
            height,
            enablePoint: true,
            enableConf: true,
            success: (r: any) => {
              const pts: any[] = Array.isArray(r && r.pointArray) ? r.pointArray : [];
              if (pts.length < MIN_LANDMARK_COUNT) {
                finish(emptyResult('faceDetect 未检出人脸', 'faceDetect'));
                return;
              }
              const points = pts
                .filter((p: any) => p && typeof p.x === 'number' && typeof p.y === 'number')
                .map((p: any) => ({ x: p.x, y: p.y }));
              const dr = r && r.detectRect;
              const rect: FaceRect | null = dr && typeof dr.originX === 'number'
                ? { x: dr.originX, y: dr.originY, width: dr.width, height: dr.height }
                : null;
              const conf = r && r.confArray && typeof r.confArray.global === 'number' ? r.confArray.global : null;
              finish({ ok: true, source: 'faceDetect', points, rect, confidence: conf });
            },
            fail: (e: any) => finish(emptyResult('faceDetect 调用失败：' + String((e && e.errMsg) || e), 'faceDetect')),
          });
        } catch (e: any) {
          finish(emptyResult('faceDetect 调用异常：' + String((e && e.message) || e), 'faceDetect'));
        }
      },
      fail: (e: any) => finish(emptyResult('initFaceDetect 失败：' + String((e && e.errMsg) || e), 'faceDetect')),
    });
  });
}

// ==================== 统一入口 ====================

/**
 * 端侧人脸检测（双轨）
 * @param rgba   图像 RGBA 像素（canvas.getImageData().data）
 * @param width  图像宽
 * @param height 图像高
 * @returns FaceDetectResult —— points/rect/confidence，供 core/face.js 计算头部占比
 */
export async function detectFace(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<FaceDetectResult> {
  if (!rgba || !width || !height) return emptyResult('缺少像素输入');

  // 轨道 1：VisionKit 优先（官方现役推荐）
  const vk = await detectByVisionKit(rgba, width, height);
  if (vk.ok) return vk;

  // 轨道 2：faceDetect 降级
  const fd = await detectByFaceDetect(rgba, width, height);
  if (fd.ok) return fd;

  return emptyResult(vk.reason || fd.reason || '当前环境不支持人脸检测');
}

/**
 * 端侧人脸检测 + 头部占比测量（业务层主入口）
 * @param rgba        图像 RGBA 像素
 * @param width/height 图像尺寸
 * @param bbox        抠图人像包围盒（可选）：用于检测完全不可用时的几何估算降级
 * @param win         占比窗口（可选）：{x,y,width,height}，默认整图；
 *                    T1 传裁剪窗口 → 得到「成品图上的头占比」
 */
export async function measureHeadRatio(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bbox?: { x: number; y: number; w: number; h: number } | null,
  win?: { x: number; y: number; width: number; height: number } | null
): Promise<HeadMeasureResult> {
  const det = await detectFace(rgba, width, height);
  const an = analyzeFace({
    points: det.ok ? det.points : null,
    rect: det.ok ? det.rect : null,
    bbox: det.ok ? null : bbox,
    imageWidth: width,
    imageHeight: height,
    confidence: det.confidence,
  });

  if (!an.ok || !an.metrics) {
    return {
      ok: false,
      ratio: null,
      source: 'none',
      quality: 'none',
      notes: ['当前环境不支持人脸检测，头部占比未检测'],
      metrics: null,
    };
  }

  const metrics = an.metrics;
  const notes: string[] = [...(metrics.notes || [])];
  let ratio = an.ratio;

  if (win) {
    // 按指定窗口（裁剪区）重算占比
    const r = ratioWithinWindow(metrics, win);
    if (r) {
      ratio = r.ratio;
      if (r.clamped) notes.push('头顶或下巴被裁切，占比按成品图可见部分计算');
    }
  }

  return {
    ok: true,
    ratio,
    source: metrics.source,
    quality: metrics.quality,
    notes,
    metrics,
  };
}

/**
 * 头部度量（供 T3 换装的头肩定位复用）
 * 与 measureHeadRatio 同源，仅返回度量不返回占比。
 */
export async function measureHeadMetrics(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  bbox?: { x: number; y: number; w: number; h: number } | null
): Promise<{ ok: boolean; headLengthPx: number | null; source: string; metrics: any; notes: string[] }> {
  const det = await detectFace(rgba, width, height);
  const an = analyzeFace({
    points: det.ok ? det.points : null,
    rect: det.ok ? det.rect : null,
    bbox: det.ok ? null : bbox,
    imageWidth: width,
    imageHeight: height,
    confidence: det.confidence,
  });
  if (!an.ok || !an.metrics) {
    return { ok: false, headLengthPx: null, source: 'none', metrics: null, notes: ['未检出人脸'] };
  }
  return {
    ok: true,
    headLengthPx: an.metrics.headLengthPx,
    source: an.metrics.source,
    metrics: an.metrics,
    notes: an.metrics.notes || [],
  };
}

// 便捷导出：供单测与页面复用的纯函数
export { faceVerticalSpan, analyzeFace, pickPrimaryFace };
