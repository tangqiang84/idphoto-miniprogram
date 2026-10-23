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
  let scale = needScale;
  let cappedBy = null;

  // B. 质量下限
  if (scale * srcLong < minEdge) scale = minEdge / srcLong;
  // C. 性能上限（长边）
  if (scale * srcLong > maxEdge) {
    scale = maxEdge / srcLong;
    cappedBy = 'maxEdge';
  }
  // C. 性能上限（总像素）
  if (srcW * srcH * scale * scale > maxPixels) {
    scale = Math.sqrt(maxPixels / (srcW * srcH));
    cappedBy = 'maxPixels';
  }
  // 源图小于质量下限时不再放大（放大无收益，白白耗性能）
  if (scale > 1 && srcLong < minEdge) scale = 1;

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

module.exports = {
  planOutput,
  MIN_WORK_EDGE,
  MAX_WORK_EDGE,
  MAX_WORK_PIXELS,
};
