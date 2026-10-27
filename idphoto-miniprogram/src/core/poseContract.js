'use strict';
// posekey 云函数 I/O 契约（P1 / 台账 #72）—— 纯函数，Node 可单测
//
// 【为什么单独成模块】方案 4.1 要求「契约先行」：云函数要部署到 CloudBase 才能真机验证，
// 而契约能在本地锁死——入参怎么组、出参怎么校验、坐标怎么换算回工作画布，全在这里，
// 云函数只是这套契约的一个实现（Python+tflite；将来换 ONNX/阿里云 parsing 也不动前端）。
//
// 【合规】沿用现有上云口径（PRD I3）：只上传**人像区域**（F1 后工作画布即规格裁剪窗，
// 人充满画布），retain=false、境内处理；用途为「姿态关键点识别」，属识别类非生成式。
//
// 【纪律】#70：每个异步边界有超时 + 原因码；#69：降级路径与正常路径同权（可观测、可分层统计）。

// MoveNet SinglePose 输出的 17 个关键点（COCO 顺序）
const KEYPOINT_NAMES = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
];

// 云函数错误码前缀（前端据此前缀判定「L1 不可用 → 降级 L2」，不再静默）
const REASON = {
  TIMEOUT: 'posekey:timeout',
  CALL_FAILED: 'posekey:call_failed',
  NO_PERSON: 'posekey:no_person',
  BAD_RESULT: 'posekey:bad_result',
  DECODE_FAILED: 'posekey:decode_failed',
  NOT_DEPLOYED: 'posekey:not_deployed',
};

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/**
 * 校验并归一化云函数 posekey 的返回。
 *
 * 出参契约（云函数）：
 *   成功 { keypoints:[{name,x,y,score}], model, latencyMs }   坐标归一化 0~1（相对上传人像区域）
 *   失败 { error: 'no_person'|'decode_failed'|'infer_failed' }
 *
 * @param {any} res 云函数返回的 result 对象
 * @returns {{ok:true, points:Array<{name,x,y,score}>, model:string|null, latencyMs:number|null, raw:any,
 *            reason:null, message:string} |
 *           {ok:false, reason:string, message:string}}
 */
function parsePoseResult(res) {
  if (!res || typeof res !== 'object') {
    return { ok: false, reason: REASON.BAD_RESULT, message: 'posekey 返回为空' };
  }
  if (res.error) {
    const code = String(res.error);
    // 云函数侧错误码 → 前端原因码（统一 posekey: 前缀，便于 UI 与状态行直接显示）
    const known = ['no_person', 'decode_failed', 'infer_failed', 'not_deployed', 'model_missing'];
    const reason = known.indexOf(code) >= 0 ? 'posekey:' + code : REASON.CALL_FAILED;
    return { ok: false, reason, message: 'posekey 返回错误：' + code };
  }
  const raw = Array.isArray(res.keypoints) ? res.keypoints : null;
  if (!raw || !raw.length) {
    return { ok: false, reason: REASON.NO_PERSON, message: 'posekey 未检出关键点' };
  }
  const points = [];
  for (let i = 0; i < raw.length; i++) {
    const k = raw[i];
    if (!k) continue;
    const x = num(k.x);
    const y = num(k.y);
    if (x === null || y === null) continue;
    // name：优先云函数给的名字；否则按 COCO 索引映射；都没有就跳（不猜）
    const name = typeof k.name === 'string' && k.name
      ? k.name
      : (typeof k.index === 'number' && KEYPOINT_NAMES[k.index] ? KEYPOINT_NAMES[k.index] : null);
    if (!name) continue;
    const score = num(k.score) === null ? 0 : clamp01(num(k.score));
    points.push({ name, x, y, score });
  }
  if (!points.length) {
    return { ok: false, reason: REASON.NO_PERSON, message: 'posekey 关键点全部无效' };
  }
  return {
    ok: true,
    points,
    model: typeof res.model === 'string' ? res.model : null,
    latencyMs: num(res.latencyMs),
    raw: res,
    reason: null,
    message: '',
  };
}

/**
 * 把 pose 关键点从「上传人像区域的归一化坐标」换算到「工作画布像素坐标」。
 *
 * @param {Array} points parsePoseResult 输出的点
 * @param {object} region 上传区域在工作画布中的矩形 {x,y,w,h}（F1 后通常 = 整张工作画布）
 * @param {object} [opts] { clamp:boolean } 是否把结果 clamp 到画布内（默认 true）
 * @returns {Array<{name,x,y,score}>}
 */
function mapPoseToCanvas(points, region, opts = {}) {
  if (!Array.isArray(points)) return [];
  const r = region && num(region.w) > 0 && num(region.h) > 0
    ? region
    : { x: 0, y: 0, w: null, h: null };
  const doClamp = opts.clamp !== false;
  const boundW = num(opts.canvasW);
  const boundH = num(opts.canvasH);
  return points.map((p) => {
    // 归一化坐标（0~1，相对区域）→ 工作画布像素
    let x = (r.x || 0) + p.x * r.w;
    let y = (r.y || 0) + p.y * r.h;
    if (doClamp) {
      if (boundW !== null) x = x < 0 ? 0 : (x > boundW ? boundW : x);
      if (boundH !== null) y = y < 0 ? 0 : (y > boundH ? boundH : y);
    }
    return { name: p.name, x, y, score: p.score };
  });
}

/**
 * 组装 posekey 云函数的入参（契约单侧：入参结构只在此处定义）。
 *
 * @param {object} p { imageB64, width, height }
 * @returns {{region:string, purpose:string, retain:boolean, train:boolean, width:number, height:number, image:string}}
 */
function buildPoseRequest({ imageB64, width, height } = {}) {
  return {
    region: 'CN',              // 境内处理（数据不出境，与 matting 云函数同口径）
    purpose: 'pose_keypoints', // 用途：姿态关键点识别（识别类，非生成式）
    retain: false,              // 处理完即销毁
    train: false,               // 不用于训练
    width: num(width) || 0,
    height: num(height) || 0,
    image: imageB64 || '',
  };
}

module.exports = {
  KEYPOINT_NAMES,
  REASON,
  parsePoseResult,
  mapPoseToCanvas,
  buildPoseRequest,
};
