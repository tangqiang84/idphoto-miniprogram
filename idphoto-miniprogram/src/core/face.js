'use strict';
// 人脸定位与头部占比计算（纯逻辑，可单测；框架无关，不引用任何平台 API）
//
// 【为什么要有这个模块】2026-10-23 任务 #4。
// 此前 T4 内联 detectHeadRatio、T3 内联 estimateHeadHeight 各自实现了一套人脸定位，
// 系数还不一致（T4 用 1.35 外推、T3 用 1/0.65≈1.538），T1 则完全没有（PRD B3 / 功能清单 T1-16 未做）。
// 本模块把「关键点 → 脸高 → 头长 → 占比」收敛成唯一一套口径，页面层只负责喂像素。
//
// 【口径定义】（与《证件照规格官方口径对照表.md》第五章一致）
//   · 官方口径的头长 = 头顶（含头发）→ 下巴；
//   · 微信/腾讯 106 点关键点只覆盖脸部轮廓（发际线 → 下巴），不含头发顶部；
//   · 故：头长 = 脸长 ÷ FACE_LENGTH_RATIO（工程经验值，见下），头顶 = 下巴 − 头长；
//   · 头高占比 = 头长 ÷ 照片高度（最终成品图高，不是原图高）。
//
// 【平台差异】微信官方未公布 106 点的分组索引，因此本模块【不使用任何硬编码索引】：
//   全部由几何统计得出（上下分位数抗离群点），并用 detectRect 做人脸框自洽性交叉校验。
//   平台 API 调用（VisionKit / wx.faceDetect）在 src/services/faceService.ts，不在本文件。

// 脸长（发际线→下巴）÷ 头长（头顶→下巴）。
// 工程经验值：一般人的头顶到发际线约占头长的 1/4，故脸长 ≈ 0.74 × 头长。
// 误差来源：发型（长发/光头）、拍摄角度。UI 一律标注「估算」，不冒充精确测量。
const FACE_LENGTH_RATIO = 0.74;

// 降级估算：头长 ÷ 人像包围盒高（证件照构图常见约 3.3 倍头高 → 0.30）。
// 仅在平台完全不支持人脸检测时使用，quality 标 'estimated'，报告须提示「估算」。
const HEAD_BBOX_RATIO = 0.30;

// 有效关键点数下限（106 点为完整集；低于此值视为检测不可信）
const MIN_LANDMARK_COUNT = 10;

// 上下各裁掉的离群点比例（1% ≈ 106 点中 1 个）
const OUTLIER_TRIM = 0.02;

// 离群点判定阈值：极端值与「次极端值」的距离 > 整体跨度的该比例，才认定为孤立飞点。
// 【重要】不能用「固定裁掉两端 N 个点」的做法 —— 106 点关键点的最高点/最低点本身就是
// 发际线上沿与下巴，固定裁剪会系统性低估脸长约 4%，使合格照片被误判为不合规。
// 改为「只剔除与邻居明显脱节的孤立飞点」，正常点集零偏差。
const OUTLIER_GAP = 0.15;

// 关键点超出图像边界的容忍倍数（超出即认为坐标系异常 → 判为不可信）
const BOUNDS_TOLERANCE = 2;

// 人脸框与关键点跨度的一致性区间（矩形面积比），超出 → 质量降级
const RECT_SPAN_MIN = 0.6;
const RECT_SPAN_MAX = 2.2;

// 脸长占图高的合理区间（低于下限说明脸太小/远景，测量不可信）
const FACE_SPAN_MIN_RATIO = 0.12;
const FACE_SPAN_MAX_RATIO = 0.98;

// ---------- 基础工具 ----------

// 排序数组的分位数（p ∈ [0,1]）
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

// 校验一组关键点是否可用（数量足够、坐标为有限数）
function isValidPoints(points) {
  if (!Array.isArray(points) || points.length < MIN_LANDMARK_COUNT) return false;
  for (const p of points) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    if (!isFinite(p.x) || !isFinite(p.y)) return false;
  }
  return true;
}

// 关键点是否落在图像范围内（坐标系异常检测）
function pointsWithinImage(points, imageWidth, imageHeight) {
  const maxX = imageWidth * BOUNDS_TOLERANCE;
  const maxY = imageHeight * BOUNDS_TOLERANCE;
  for (const p of points) {
    if (p.x < -1 || p.y < -1 || p.x > maxX || p.y > maxY) return false;
  }
  return true;
}

// ---------- 关键点几何 ----------

// 关键点的垂直跨度（脸长）：上沿取最高关键点、下沿取最低关键点。
// 离群点处理：仅当极端值与「次极端值」的距离超过整体跨度的 OUTLIER_GAP 时，
// 才认定该极端值是孤立飞点并剔除（正常 106 点零偏差，避免系统性低估脸长）。
// 返回 {topY, bottomY, span}；不可用返回 null。
function faceVerticalSpan(points) {
  if (!isValidPoints(points)) return null;
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  if (ys.length < 2) return null;

  let topY = ys[0];
  let bottomY = ys[ys.length - 1];
  const rawSpan = bottomY - topY;
  if (!(rawSpan > 0)) return null;

  // 顶部孤立飞点：次高点与最高点脱节 → 用次高点
  if (ys.length >= 3 && (ys[1] - ys[0]) > rawSpan * OUTLIER_GAP) {
    topY = ys[1];
  }
  // 底部孤立飞点：次低点与最低点脱节 → 用次低点
  if (ys.length >= 3 && (ys[ys.length - 1] - ys[ys.length - 2]) > rawSpan * OUTLIER_GAP) {
    bottomY = ys[ys.length - 2];
  }

  const span = bottomY - topY;
  if (!(span > 0)) return null;
  return { topY, bottomY, span };
}

// 多张人脸时取主脸（人脸框面积最大者）；无 rect 时按关键点包围盒面积比较。
function pickPrimaryFace(faces) {
  if (!Array.isArray(faces) || !faces.length) return null;
  let best = null;
  let bestArea = -1;
  for (const f of faces) {
    if (!f) continue;
    const pts = f.points || [];
    const rect = f.rect || null;
    let area = 0;
    if (rect && rect.width > 0 && rect.height > 0) {
      area = rect.width * rect.height;
    } else if (pts.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      area = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
    }
    if (area > bestArea) { bestArea = area; best = f; }
  }
  return best;
}

// ---------- 头部度量 ----------

// 由关键点计算头部度量。
// 输入：{ points, rect?, imageWidth, imageHeight, confidence? }
// rect 统一形状 { x, y, width, height }（服务层已把两种平台格式归一）
// 输出 metrics 或 null
function headMetricsFromLandmarks({ points, rect, imageWidth, imageHeight, confidence } = {}) {
  if (!imageWidth || !imageHeight) return null;
  if (!pointsWithinImage(points || [], imageWidth, imageHeight)) return null;
  const span = faceVerticalSpan(points);
  if (!span) return null;

  const faceSpanPx = span.span;
  const faceSpanRatio = faceSpanPx / imageHeight;
  if (faceSpanRatio > FACE_SPAN_MAX_RATIO) return null;

  const headLengthPx = faceSpanPx / FACE_LENGTH_RATIO;
  const chinY = span.bottomY;
  const crownY = chinY - headLengthPx;

  // 面部水平中心（任务 #24 自动裁剪用）：取关键点 x 的中位数。
  // 用中位数而非 (minX+maxX)/2 —— 后者会被单个横向飞点带偏；
  // 中位数对孤立飞点免疫，与本模块「只剔孤立飞点」的降级纪律一致。
  const xs = points.map((p) => p.x).sort((a, b) => a - b);
  const faceCenterX = percentile(xs, 0.5);

  const notes = [];
  let quality = 'good';

  if (faceSpanRatio < FACE_SPAN_MIN_RATIO) {
    quality = 'low';
    notes.push('人脸在画面中过小（远景/全身照），头部占比测量误差大');
  }
  if (crownY < 0) {
    notes.push('头顶超出画面边界，头部占比按可见部分估算');
  }

  // 人脸框自洽性交叉校验：detectRect 高度与关键点脸长应大致同量级
  if (rect && rect.width > 0 && rect.height > 0 && faceSpanPx > 0) {
    const ratio = rect.height / faceSpanPx;
    if (ratio < RECT_SPAN_MIN || ratio > RECT_SPAN_MAX) {
      quality = quality === 'good' ? 'low' : quality;
      notes.push('人脸框与关键点不自洽，测量可信度降低');
    }
  }

  return {
    source: 'landmarks',
    quality,
    confidence: typeof confidence === 'number' ? confidence : null,
    crownY,
    chinY,
    faceTopY: span.topY,
    faceSpanPx,
    headLengthPx,
    faceSpanRatio,
    faceCenterX,
    notes,
  };
}

// 降级估算：没有人脸检测能力时，用抠图得到的人像包围盒估头长。
// 输入：{ bbox: {x,y,w,h}, imageWidth, imageHeight }
function headMetricsFromBBox({ bbox, imageWidth, imageHeight } = {}) {
  if (!bbox || !(bbox.h > 0) || !imageHeight) return null;
  const headLengthPx = bbox.h * HEAD_BBOX_RATIO;
  const crownY = bbox.y;
  const chinY = crownY + headLengthPx;
  return {
    source: 'estimate',
    quality: 'estimated',
    confidence: null,
    crownY,
    chinY,
    faceTopY: crownY,
    faceSpanPx: headLengthPx * FACE_LENGTH_RATIO,
    headLengthPx,
    faceSpanRatio: (headLengthPx * FACE_LENGTH_RATIO) / imageHeight,
    // 估算路径无关键点 → 用人像包围盒中心作为「面部水平中心」的近似
    faceCenterX: bbox.x + bbox.w / 2,
    notes: ['当前环境不支持人脸检测，头部占比由人像比例估算，仅供参考'],
  };
}

// ---------- 占比计算 ----------

// 在给定窗口（裁剪区）内计算头长占窗口高度的比例。
// 窗口 win = { x, y, width, height }（图像坐标系）。
// 窗口把头顶或下巴切掉时，按【可见部分】计（与审核员在成品图上量的口径一致）。
// 返回 { ratio, visibleHeadPx, clamped, window } 或 null
function ratioWithinWindow(metrics, win) {
  if (!metrics || !win || !(win.height > 0)) return null;
  const winTop = win.y;
  const winBottom = win.y + win.height;
  const top = Math.max(metrics.crownY, winTop);
  const bottom = Math.min(metrics.chinY, winBottom);
  const visibleHeadPx = bottom - top;
  if (!(visibleHeadPx > 0)) return null;
  return {
    ratio: visibleHeadPx / win.height,
    visibleHeadPx,
    clamped: metrics.crownY < winTop || metrics.chinY > winBottom,
    window: win,
  };
}

// 平台无关的度量组装：优先关键点，其次包围盒估算。
// 输入：{ points, rect, bbox, imageWidth, imageHeight, confidence }
// 输出 { ok, metrics, ratio|null }（ratio 以整图为窗口）
//
// 【降级纪律】只有「压根没有关键点」（平台不支持人脸检测）才允许用几何估算兜底；
// 若关键点存在但坐标系异常/度量失败，一律判为不可用 ——
// 绝不用估算值静默冒充实测，否则合规结论会被一个错误的估算污染。
function analyzeFace({ points, rect, bbox, imageWidth, imageHeight, confidence } = {}) {
  let metrics = null;
  const hasPoints = Array.isArray(points) && points.length > 0;
  if (hasPoints) {
    metrics = headMetricsFromLandmarks({ points, rect, imageWidth, imageHeight, confidence });
    if (!metrics) return { ok: false, metrics: null, ratio: null, reason: 'landmarks-unusable' };
  } else if (bbox) {
    metrics = headMetricsFromBBox({ bbox, imageWidth, imageHeight });
  }
  if (!metrics) return { ok: false, metrics: null, ratio: null };
  const r = ratioWithinWindow(metrics, { x: 0, y: 0, width: imageWidth, height: imageHeight });
  return { ok: true, metrics, ratio: r ? r.ratio : null, windowResult: r };
}

module.exports = {
  FACE_LENGTH_RATIO,
  HEAD_BBOX_RATIO,
  MIN_LANDMARK_COUNT,
  OUTLIER_TRIM,
  FACE_SPAN_MIN_RATIO,
  FACE_SPAN_MAX_RATIO,
  RECT_SPAN_MIN,
  RECT_SPAN_MAX,
  percentile,
  isValidPoints,
  pointsWithinImage,
  faceVerticalSpan,
  pickPrimaryFace,
  headMetricsFromLandmarks,
  headMetricsFromBBox,
  ratioWithinWindow,
  analyzeFace,
};
