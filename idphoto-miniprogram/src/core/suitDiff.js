'use strict';
// 换装前后「脸部像素差异」检测（PRD D 章验收 / AC6）
//
// 【为什么需要它】换装链路（core/suit.js 的 suitCompose）**只贴** alpha>0.5 且模板不透明
// 的像素，正常情况下脸部区域像素应当**完全不变**（diff ≈ 0）。
// 但「西装顶冲过下巴盖住嘴」「模板旋转角算错盖到眼睛」这类几何事故在真机上出现过多次
// （见 suit.js 注释里的 #69 案例：place.y 冲过下巴盖脸 30px、19px）。
// 以前全库没有任何自动检测手段，只靠用户手动勾选的「我确认五官没变」自检闸兜底 ——
// 那属于**事后自证**，不是**过程校验**。本模块把「换装前后脸部逐像素比对」做成纯函数，
// 让页面层在弹出确认框之前先跑一次机器判定。
//
// 【判定口径】
//   · 只统计脸部矩形内的像素（矩形外的肩部/背景变化不算违规）；
//   · 「显著变化」= RGB 任一通道差值 > CHANNEL_THRESHOLD（默认 24，
//     24 是「肉眼几乎不可察 / 但确实被覆盖」的量级；JPEG 压缩噪声在同图内通常 < 5）；
//   · changedRatio = 显著变化的像素数 ÷ 脸部矩形像素数；
//   · changedRatio <= maxChangedRatio（默认 0.02，即最多 2%）→ pass。
//
// 【脸框不可用时必须如实说】
// 脸框为空 / 越界 / 面积为 0 时，**不能**静默当成「不通过」（那会拦死所有没做人脸检测的
// 流程），也**不能**假装「检测通过」（那会让 AC6 变成一句空话）。
// 故：pass=true（不阻断用户）+ reason='no_face_rect' + checked=false + detail 说明原因，
// 由调用方决定是否弹窗告知「本次未能自动核验，请人工确认」。
//
// 纯函数、无平台依赖，Node 可直接单测。

const DEFAULT_MAX_CHANGED_RATIO = 0.02; // 允许最多 2% 脸部像素发生显著变化
const DEFAULT_CHANNEL_THRESHOLD = 24; // 单通道差值 > 24 才算「显著变化」

function isNum(v) {
  return typeof v === 'number' && isFinite(v);
}

/** 缺省结果（未做实际比对） */
function skipped(reason, detail, extra) {
  return {
    changed: 0,
    total: 0,
    changedRatio: 0,
    maxDiff: 0,
    pass: true,
    reason,
    detail: detail || '',
    checked: false,
    ...(extra || {}),
  };
}

/**
 * 解析图像尺寸：
 *   1) opts.width / opts.height；
 *   2) faceRect.imageWidth / faceRect.imageHeight（调用方已知的画布尺寸）；
 *   3) 只知一边时，用缓冲区像素总数补出另一边（width*height 必须 <= 像素总数）；
 *   4) 都拿不到 → 无法定位像素，返回 unknown（不猜、不静默通过）。
 */
function resolveImageSize(totalPixels, faceRect, opts) {
  let width = isNum(opts.width) ? opts.width : null;
  let height = isNum(opts.height) ? opts.height : null;
  if (!width && faceRect && isNum(faceRect.imageWidth)) width = faceRect.imageWidth;
  if (!height && faceRect && isNum(faceRect.imageHeight)) height = faceRect.imageHeight;
  if (width && !height) height = totalPixels / width;
  if (height && !width) width = totalPixels / height;
  if (!width || !height) return null;
  if (!(width > 0) || !(height > 0)) return null;
  if (width * height > totalPixels) return null;
  return { width: Math.floor(width), height: Math.floor(height) };
}

/**
 * 比较换装前后的脸部区域像素差异。
 *
 * @param {Uint8ClampedArray|number[]} before 换装前 RGBA（长度 = w*h*4）
 * @param {Uint8ClampedArray|number[]} after  换装后 RGBA（长度 = w*h*4）
 * @param {{x:number,y:number,w:number,h:number,imageWidth?:number,imageHeight?:number}} faceRect 脸部矩形（像素坐标）
 * @param {{width?:number,height?:number,maxChangedRatio?:number,channelThreshold?:number}} [opts]
 * @returns {{changed:number,total:number,changedRatio:number,maxDiff:number,pass:boolean,
 *            reason:string,detail:string,checked:boolean,maxChangedRatio:number,channelThreshold:number}}
 */
function compareFaceRegion(before, after, faceRect, opts = {}) {
  const maxChangedRatio = isNum(opts.maxChangedRatio) ? opts.maxChangedRatio : DEFAULT_MAX_CHANGED_RATIO;
  const channelThreshold = isNum(opts.channelThreshold) ? opts.channelThreshold : DEFAULT_CHANNEL_THRESHOLD;

  if (!before || !after || !before.length || !after.length) {
    return skipped('invalid_input', '缺少换装前/后的像素数据', { maxChangedRatio, channelThreshold });
  }
  if (before.length !== after.length) {
    return skipped('size_mismatch', '换装前后像素长度不一致，无法逐像素比对', { maxChangedRatio, channelThreshold });
  }
  const totalPixels = before.length / 4;
  if (!Number.isInteger(totalPixels)) {
    return skipped('invalid_input', '像素缓冲区长度不是 4 的整数倍', { maxChangedRatio, channelThreshold });
  }

  const size = resolveImageSize(totalPixels, faceRect, opts);
  if (!size) {
    return skipped(
      'unknown_image_size',
      '无法确定图像尺寸（需 opts.width/height 或 faceRect.imageWidth/imageHeight），未做比对',
      { maxChangedRatio, channelThreshold },
    );
  }

  // 脸框校验：空 / 非法 / 面积为 0 / 越界 → 不阻断，但如实给原因码
  if (!faceRect || !isNum(faceRect.x) || !isNum(faceRect.y) || !isNum(faceRect.w) || !isNum(faceRect.h)) {
    return skipped('no_face_rect', '未提供有效脸部矩形，未做比对', { maxChangedRatio, channelThreshold });
  }
  const x0 = Math.round(faceRect.x);
  const y0 = Math.round(faceRect.y);
  const rw = Math.round(faceRect.w);
  const rh = Math.round(faceRect.h);
  if (rw <= 0 || rh <= 0) {
    return skipped('no_face_rect', '脸部矩形面积为 0，未做比对', { maxChangedRatio, channelThreshold });
  }
  if (x0 < 0 || y0 < 0 || x0 + rw > size.width || y0 + rh > size.height) {
    return skipped('no_face_rect', '脸部矩形超出图像范围，未做比对', { maxChangedRatio, channelThreshold });
  }

  let changed = 0;
  let maxDiff = 0;
  for (let y = y0; y < y0 + rh; y++) {
    for (let x = x0; x < x0 + rw; x++) {
      const i = (y * size.width + x) * 4;
      const dr = Math.abs(before[i] - after[i]);
      const dg = Math.abs(before[i + 1] - after[i + 1]);
      const db = Math.abs(before[i + 2] - after[i + 2]);
      const d = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
      if (d > maxDiff) maxDiff = d;
      if (d > channelThreshold) changed++;
    }
  }

  const total = rw * rh;
  const changedRatio = total > 0 ? changed / total : 0;
  const pass = changedRatio <= maxChangedRatio;
  return {
    changed,
    total,
    changedRatio,
    maxDiff,
    pass,
    reason: pass ? 'ok' : 'face_changed',
    detail: pass
      ? `脸部显著变化像素 ${changed}/${total}（${(changedRatio * 100).toFixed(2)}%），在 ${(maxChangedRatio * 100).toFixed(0)}% 阈值内`
      : `脸部显著变化像素 ${changed}/${total}（${(changedRatio * 100).toFixed(2)}%），超过 ${(maxChangedRatio * 100).toFixed(0)}% 阈值，疑似模板覆盖到五官`,
    checked: true,
    maxChangedRatio,
    channelThreshold,
  };
}

module.exports = {
  compareFaceRegion,
  DEFAULT_MAX_CHANGED_RATIO,
  DEFAULT_CHANNEL_THRESHOLD,
};
