'use strict';
// 输出构图规划（纯逻辑，可单测；框架无关）
//
// 【2026-10-23 owner 决策】600dpi 全工具开放（免费）后，本模块负责回答一个问题：
// 「给定源图尺寸与目标像素尺寸，工作图该取多大、裁剪窗口在哪、会不会被放大糊掉？」
//
// 为什么需要它（三页原本各自手写同一段缩放/裁剪逻辑，口径不一）：
//   1. 300dpi 时代目标最大 626px（413×626），固定 800px 工作图长边就够用；
//      600dpi 目标最大 1252px（827×1252 / 美签 1200×1200）—— 沿用 800px 会输出
//      「从 800px 放大来的假印刷级」，边缘发虚，属于虚假宣传。
//   2. 但工作图也不是越大越好：端侧逐像素抠图是 O(像素数)，
//      Node 实测 800px=216ms、1252px=556ms（手机端约慢 3~5 倍），
//      内存也随之线性上升（RGBA + alpha + canvas ≈ 每百万像素 20MB+）。
//
// 规划原则：
//   A. 「够用即止」：先算出让**裁剪窗口像素 ≥ 目标像素**所需的最小缩放，
//      这样输出是 1:1 或缩小采样，绝不放大。
//   B. 「质量下限」：工作图长边不低于 800px（抠图质量与头部占比检测的可靠性下限）。
//   C. 「性能上限」：工作图长边不超过 maxEdge，且总像素不超过 maxPixels（内存保护）。
//   D. 源图分辨率不足时**如实标记 upscale=true**，由页面提示用户
//      「原图分辨率不足，放大不会更清晰」，不静默输出糊图。
//
// 术语：
//   srcW/srcH   源图（原始尺寸，chooseImage sizeType=original）
//   targetW/H   目标成品像素（规格 × dpi 换算）
//   workW/H     工作图尺寸（端侧抠图/合成的实际画布）
//   sx/sy/sw/sh 裁剪窗口（工作图坐标系）—— 成品图 = 工作图该窗口放大/缩放到 target

// 质量下限：低于此长边，端侧抠图边缘质量与头部占比检测可靠性明显下降
const MIN_WORK_EDGE = 800;
// 性能上限：端侧逐像素抠图的耗时/内存保护（Node 实测 1252px≈556ms）
const MAX_WORK_EDGE = 1600;
// 像素总数上限：约 2.2M 像素 ≈ RGBA 8.8MB / alpha 8.8MB / canvas 8.8MB
const MAX_WORK_PIXELS = 2200000;

// 检测用图的长边（T1 自动裁剪需要在**绘制工作图之前**先测出人脸位置）。
// 取 1200 的理由：人脸检测要足够的像素细节（106 点关键点在人脸高度 < 100px 时不可靠），
// 同时离屏画布 RGBA 内存 = 长边²×4 ≈ 5.8MB，可接受。
const DETECT_EDGE = 1200;

// 按指定裁剪窗规划工作画布时，工作区域向外的余量比例（相对裁剪窗长边）。
// 用途：抠图（segment）在工作画布上做，若画布正好等于裁剪窗，
// 人像在画布边缘被硬切 → 抠图 alpha 在边缘质量下降（合成底色后可见瑕疵）。
// 给 15% 余量让肩/臂在画布内自然过渡，瑕疵落在成品区之外。
const WIN_MARGIN_RATIO = 0.15;

/**
 * 把缩放倍率限制在「质量下限」与「性能上限」之间（planOutput 与 planWindowOutput 共用）。
 * 口径与 planOutput 原实现逐条一致，抽成函数是为了避免两处逻辑漂移。
 * @param {number} scale 待限制的倍率
 * @param {number} regionW 区域宽（源图像素）
 * @param {number} regionH 区域高（源图像素）
 * @param {{minEdge?:number,maxEdge?:number,maxPixels?:number}} [opts]
 * @returns {{scale:number, cappedBy:null|string}}
 */
function clampScale(scale, regionW, regionH, opts = {}) {
  const minEdge = opts.minEdge == null ? MIN_WORK_EDGE : opts.minEdge;
  const maxEdge = opts.maxEdge == null ? MAX_WORK_EDGE : opts.maxEdge;
  const maxPixels = opts.maxPixels == null ? MAX_WORK_PIXELS : opts.maxPixels;
  const regionLong = Math.max(regionW, regionH);
  let cappedBy = null;

  // B. 质量下限
  if (scale * regionLong < minEdge) scale = minEdge / regionLong;
  // C. 性能上限（长边）
  if (scale * regionLong > maxEdge) {
    scale = maxEdge / regionLong;
    cappedBy = 'maxEdge';
  }
  // C. 性能上限（总像素）
  if (regionW * regionH * scale * scale > maxPixels) {
    scale = Math.sqrt(maxPixels / (regionW * regionH));
    cappedBy = 'maxPixels';
  }
  // 区域本身小于质量下限时不再放大（放大无收益，白白耗性能）
  if (scale > 1 && regionLong < minEdge) scale = 1;

  return { scale, cappedBy };
}

/**
 * 计算工作图尺寸与裁剪窗口。
 * @param {number} srcW 源图宽
 * @param {number} srcH 源图高
 * @param {number} targetW 目标成品宽（px）
 * @param {number} targetH 目标成品高（px）
 * @param {{minEdge?:number,maxEdge?:number,maxPixels?:number}} [opts]
 * @returns {{
 *   workW:number, workH:number,
 *   sx:number, sy:number, sw:number, sh:number,
 *   scale:number, needScale:number,
 *   upscale:boolean, srcTooSmall:boolean, cappedBy:null|string,
 *   reason:string
 * }|null}
 */
function planOutput(srcW, srcH, targetW, targetH, opts = {}) {
  if (!srcW || !srcH || !targetW || !targetH) return null;
  const minEdge = opts.minEdge == null ? MIN_WORK_EDGE : opts.minEdge;
  const maxEdge = opts.maxEdge == null ? MAX_WORK_EDGE : opts.maxEdge;
  const maxPixels = opts.maxPixels == null ? MAX_WORK_PIXELS : opts.maxPixels;

  const tr = targetW / targetH;   // 目标宽高比
  const ar = srcW / srcH;         // 源图宽高比

  // 源图按目标宽高比可切出的最大窗口（源分辨率下）
  const cropFullW = ar >= tr ? srcH * tr : srcW;
  const cropFullH = ar >= tr ? srcH : srcW / tr;

  // 让裁剪窗口像素 ≥ 目标像素所需的缩放（needScale ≥ 1 表示源图本身不够大）
  const needScale = Math.max(targetW / cropFullW, targetH / cropFullH);

  const srcLong = Math.max(srcW, srcH);
  const clamped = clampScale(needScale, srcW, srcH, { minEdge, maxEdge, maxPixels });
  const scale = clamped.scale;
  const cappedBy = clamped.cappedBy;

  const workW = Math.max(1, Math.round(srcW * scale));
  const workH = Math.max(1, Math.round(srcH * scale));

  // 工作图内的目标宽高比裁剪窗口（居中）
  const wr = workW / workH;
  let sw, sh;
  if (wr >= tr) {
    sh = workH;
    sw = workH * tr;
  } else {
    sw = workW;
    sh = workW / tr;
  }
  const sx = (workW - sw) / 2;
  const sy = (workH - sh) / 2;

  // 放大判定：裁剪窗口像素 < 目标像素 ⇒ 成品是放大来的
  const upscale = sw < targetW - 0.5 || sh < targetH - 0.5;
  // 源图分辨率不足：即便按 needScale 放大也无法达到目标像素
  const srcTooSmall = needScale > 1;

  let reason = '';
  if (srcTooSmall) {
    reason = '原图分辨率不足，放大不会更清晰';
  } else if (upscale && cappedBy === 'maxEdge') {
    reason = '已达端侧处理分辨率上限，输出为放大结果';
  } else if (upscale && cappedBy === 'maxPixels') {
    reason = '已达端侧处理内存上限，输出为放大结果';
  } else if (upscale) {
    reason = '输出为放大结果';
  }

  return {
    workW, workH,
    sx, sy, sw, sh,
    scale, needScale,
    upscale, srcTooSmall, cappedBy,
    reason,
  };
}

/**
 * 按【指定裁剪窗】规划工作画布（T1 自动裁剪用，任务 #24）。
 *
 * 与 planOutput 的区别：
 *   planOutput —— 工作画布 = 整张源图缩放，裁剪窗 = 目标宽高比下的最大窗口（居中）。
 *   本函数   —— 工作画布 = 【裁剪窗 + 余量】这一块区域的缩放，裁剪窗 = 指定的窗口。
 *
 * 为什么需要它：按头占比反解出的裁剪窗通常比「最大窗口」小得多
 * （例：原片 3000×4000 全身照，头占比 12%，目标一寸 66% ⇒ 裁剪窗只有原片的 ~1/4 面积）。
 * 若仍按「整图缩放到 1600 长边」处理，裁剪窗在工作图上只剩几百像素 → 成品是放大出来的糊图。
 * 改为「只把要用到的那块区域放大到足够像素」，才能既满足头占比又保住清晰度。
 *
 * @param {number} srcW 源图宽
 * @param {number} srcH 源图高
 * @param {number} targetW 目标成品宽（px）
 * @param {number} targetH 目标成品高（px）
 * @param {{sx:number, sy:number, sw:number, sh:number}} win 裁剪窗（源图坐标）
 * @param {{margin?:number,minEdge?:number,maxEdge?:number,maxPixels?:number}} [opts]
 * @returns {{
 *   regionX:number, regionY:number, regionW:number, regionH:number,
 *   workW:number, workH:number,
 *   sx:number, sy:number, sw:number, sh:number,
 *   scale:number, needScale:number,
 *   upscale:boolean, srcTooSmall:boolean, cappedBy:null|string,
 *   reason:string
 * }|null}
 */
function planWindowOutput(srcW, srcH, targetW, targetH, win, opts = {}) {
  if (!srcW || !srcH || !targetW || !targetH) return null;
  if (!win || !(win.sw > 0) || !(win.sh > 0)) return null;
  const minEdge = opts.minEdge == null ? MIN_WORK_EDGE : opts.minEdge;
  const maxEdge = opts.maxEdge == null ? MAX_WORK_EDGE : opts.maxEdge;
  const maxPixels = opts.maxPixels == null ? MAX_WORK_PIXELS : opts.maxPixels;
  const margin = opts.margin == null ? WIN_MARGIN_RATIO : opts.margin;

  // 工作区域 = 裁剪窗向外扩 margin（贴边时把余量让给另一侧，保证区域尺寸不缩水）
  const m = Math.round(Math.max(win.sw, win.sh) * margin);
  let regionX = win.sx - m;
  let regionY = win.sy - m;
  let regionW = win.sw + 2 * m;
  let regionH = win.sh + 2 * m;
  if (regionX < 0) { regionW += regionX; regionX = 0; }
  if (regionY < 0) { regionH += regionY; regionY = 0; }
  if (regionX + regionW > srcW) regionW = srcW - regionX;
  if (regionY + regionH > srcH) regionH = srcH - regionY;
  if (!(regionW > 0) || !(regionH > 0)) return null;

  // 让【裁剪窗】像素 ≥ 目标像素所需的缩放
  const needScale = Math.max(targetW / win.sw, targetH / win.sh);
  const clamped = clampScale(needScale, regionW, regionH, { minEdge, maxEdge, maxPixels });
  const scale = clamped.scale;
  const cappedBy = clamped.cappedBy;

  const workW = Math.max(1, Math.round(regionW * scale));
  const workH = Math.max(1, Math.round(regionH * scale));

  // 裁剪窗在工作图坐标系中的位置
  const sx = (win.sx - regionX) * scale;
  const sy = (win.sy - regionY) * scale;
  const sw = win.sw * scale;
  const sh = win.sh * scale;

  const upscale = sw < targetW - 0.5 || sh < targetH - 0.5;
  const srcTooSmall = needScale > 1;

  let reason = '';
  if (srcTooSmall) {
    reason = '原图分辨率不足，放大不会更清晰';
  } else if (upscale && cappedBy === 'maxEdge') {
    reason = '已达端侧处理分辨率上限，输出为放大结果';
  } else if (upscale && cappedBy === 'maxPixels') {
    reason = '已达端侧处理内存上限，输出为放大结果';
  } else if (upscale) {
    reason = '输出为放大结果';
  }

  return {
    regionX, regionY, regionW, regionH,
    workW, workH,
    sx, sy, sw, sh,
    scale, needScale,
    upscale, srcTooSmall, cappedBy,
    reason,
  };
}

/**
 * 规划「检测用图」的尺寸：源图等比缩放到长边 DETECT_EDGE（源图本身更小则不放大）。
 * 用于在绘制工作图之前先测出人脸位置（任务 #24）。
 */
function planDetectImage(srcW, srcH, opts = {}) {
  if (!srcW || !srcH) return null;
  const edge = opts.edge == null ? DETECT_EDGE : opts.edge;
  const srcLong = Math.max(srcW, srcH);
  const scale = srcLong > edge ? edge / srcLong : 1;
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
    scale,
  };
}

module.exports = {
  planOutput,
  planWindowOutput,
  planDetectImage,
  clampScale,
  MIN_WORK_EDGE,
  MAX_WORK_EDGE,
  MAX_WORK_PIXELS,
  DETECT_EDGE,
  WIN_MARGIN_RATIO,
};
