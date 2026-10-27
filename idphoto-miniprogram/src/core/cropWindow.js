'use strict';
// 交互式裁剪窗（纯逻辑，可单测；框架无关）
//
// 【为什么要有】P2.5「裁剪·选择范围」= 用户在照片上**拖动/缩放**选取画面范围，
// 裁剪框比例锁定目标规格（避免成品拉伸变形）。原型的 s_crop 屏就是这件事。
// 此前代码只有「智能构图」（core/headCrop.js 按头占比反解裁剪框）——
// 那一步是**系统建议**，不是用户操作；用户要自己选范围时没有入口（= 用户反馈「没看到裁剪步骤」的另一半根因）。
//
// 【本模块职责】把用户拖出来的框，校正成**合法**的裁剪窗：
//   · 比例锁定：宽高比必须等于目标规格像素比（拖动/缩放都不改比例）
//   · 完全落在原图内
//   · 最小尺寸（防止裁到只剩几像素）
//
// 【坐标系】原图像素坐标（左上角为原点），与 core/headCrop.js / planWindowOutput 一致。

// 裁剪窗最小边长（像素）：小于此值输出不可用
const MIN_CROP_EDGE = 32;

/**
 * 校正用户拖动的裁剪窗：比例锁定 + 限制在图内 + 最小尺寸。
 *
 * @param {object} win 用户框 { x, y, w, h }（原图像素坐标，允许越界，会被夹回）
 * @param {number} srcW 原图宽
 * @param {number} srcH 原图高
 * @param {number} targetRatio 目标宽高比（targetW / targetH）
 * @returns {{x:number,y:number,w:number,h:number,ratio:number}|null} 合法裁剪窗；参数非法返回 null
 */
function clampCropWindow(win, srcW, srcH, targetRatio) {
  if (!win || !(srcW > 0) || !(srcH > 0) || !(targetRatio > 0)) return null;
  const w0 = Number(win.w);
  const h0 = Number(win.h);
  if (!(w0 > 0) || !(h0 > 0)) return null;

  // 比例锁定：以宽为准推高（拖动时宽是主轴；缩放时用户看到的就是等比框）
  let w = Math.min(w0, srcW);
  let h = w / targetRatio;
  if (h > srcH) {
    h = srcH;
    w = h * targetRatio;
  }
  // 最小尺寸：太小则按比例放大到最小边长（受图边界约束）
  if (w < MIN_CROP_EDGE) {
    w = Math.min(MIN_CROP_EDGE, srcW);
    h = w / targetRatio;
  }
  if (h < MIN_CROP_EDGE) {
    h = Math.min(MIN_CROP_EDGE, srcH);
    w = h * targetRatio;
  }
  // 位置夹回图内
  let x = Number(win.x);
  let y = Number(win.y);
  if (!isFinite(x)) x = 0;
  if (!isFinite(y)) y = 0;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > srcW) x = srcW - w;
  if (y + h > srcH) y = srcH - h;
  if (x < 0) x = 0;
  if (y < 0) y = 0;

  return { x, y, w, h, ratio: targetRatio };
}

/**
 * 居中最大裁剪窗（默认建议，与 planOutput 的居中口径一致）。
 * @param {number} srcW @param {number} srcH @param {number} targetRatio
 */
function centerCropWindow(srcW, srcH, targetRatio) {
  if (!(srcW > 0) || !(srcH > 0) || !(targetRatio > 0)) return null;
  let w = srcW;
  let h = w / targetRatio;
  if (h > srcH) {
    h = srcH;
    w = h * targetRatio;
  }
  return { x: (srcW - w) / 2, y: (srcH - h) / 2, w, h, ratio: targetRatio };
}

/**
 * 判断两个裁剪窗是否等价（用于「有没有改动」的判断，避免无意义重跑）。
 */
function sameCropWindow(a, b, tol = 1) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
    && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
}

module.exports = { clampCropWindow, centerCropWindow, sameCropWindow, MIN_CROP_EDGE };
