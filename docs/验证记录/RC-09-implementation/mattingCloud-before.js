'use strict';
// 上云增强接入契约 + 真实调用（BiRefNet / RMBG-2.0 境内 GPU 云函数）
//
// 合规内嵌（对齐《证件照小程序 PRD 正文 MVP v0.1》）：
//   - I3 / 第171行：仅上传【裁剪后的人像区域】(非全图)，境内传输
//   - 第171行：处理完即销毁、不用于模型训练留存 → 请求体携带 retain:false / train:false
//   - 第224行 / 隐私矩阵 faceCloudEnhance：上云须【单独授权】，未授权不启动(AC5)
//   - 第226行 / 数据不出境：endpoint 必须为境内，fail-closed 阻断跨境
//   - 第232行 / AC8：审计日志只含元数据(尺寸/耗时/置信/区域)，绝不携带人脸像素
//
// 框架无关：real adapter 由调用方注入(wx.request / fetch)，core 不依赖小程序运行时，
// 以便 Node 单测与 PoC 复用同一份逻辑。

const { estimateQuality, runClassicalFallback, gaussianFromSamples, mahalanobis, sampleRGB, sigmoid } = require('./mattingLocal');
const { bytesToBase64, base64ToBytes } = require('./base64');

// ===================== 序列化（base64，Node/小程序通用） =====================
// ⚠️ 2026-10-27（任务 #52 续）：小程序运行时没有 Buffer / btoa / atob，
//    原实现最后落到 Buffer.from(...) → ReferenceError → 上云链路在小程序端必然失败。
//    改用纯 JS 实现（core/base64.js），Node 与小程序行为一致（单测与 Buffer 逐字节比对）。
function toBase64(bytes) {
  return bytesToBase64(bytes);
}
function fromBase64(b64) {
  return base64ToBytes(b64);
}
function encodeAlphaB64(alpha) {
  const u = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < alpha.length; i++) u[i] = Math.round(Math.max(0, Math.min(1, alpha[i])) * 255);
  return toBase64(u);
}
function decodeAlphaB64(b64, n) {
  const u = fromBase64(b64);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = (u[i] || 0) / 255;
  // 实际字节数 ≠ 期望像素数 → 说明云端返回的 alpha 尺寸与请求不一致（需按比例还原）
  f.__len = u.length;
  return f;
}

// ===================== 裁剪人像区域（非全图，I3/第171行） =====================
// 基于本地 alpha 求前景包围盒，padding 后裁出子图；只上传该区域，减少数据外泄面。
/** 按给定矩形裁剪出子图（含 alpha 同步裁剪） */
function cropRect(rgba, alpha, w, h, r) {
  const x0 = Math.max(0, Math.min(w - 1, Math.round(r.x)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(r.y)));
  const cw = Math.max(1, Math.min(w - x0, Math.round(r.w)));
  const ch = Math.max(1, Math.min(h - y0, Math.round(r.h)));
  const sub = new Uint8ClampedArray(cw * ch * 4);
  const subA = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const si = ((y0 + y) * w + (x0 + x)) * 4;
    const di = (y * cw + x) * 4;
    sub[di] = rgba[si]; sub[di + 1] = rgba[si + 1]; sub[di + 2] = rgba[si + 2]; sub[di + 3] = rgba[si + 3];
    subA[y * cw + x] = alpha[(y0 + y) * w + (x0 + x)];
  }
  return { rgba: sub, alpha: subA, w: cw, h: ch, x: x0, y: y0, full: x0 === 0 && y0 === 0 && cw === w && ch === h };
}

function cropForeground(rgba, alpha, w, h, pad) {
  pad = pad == null ? 8 : pad;
  let minX = w, minY = h, maxX = -1, maxY = -1, has = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x] >= 0.5) {
      has = true;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (!has) return { rgba, alpha, w, h, x: 0, y: 0, full: true };
  return cropRect(rgba, alpha, w, h, {
    x: Math.max(0, minX - pad), y: Math.max(0, minY - pad),
    w: Math.min(w - 1, maxX + pad) - Math.max(0, minX - pad) + 1,
    h: Math.min(h - 1, maxY + pad) - Math.max(0, minY - pad) + 1,
  });
}
/**
 * 决定「上传给云端的那块区域」（PRD I3：只上传裁剪后的人像区域，减少数据外泄面）。
 *
 * ⚠️ 2026-10-27 真机排障发现的设计缺陷（问题台账 #64）：
 *   原实现用**端侧 alpha 的前景 bbox** 作为上传区域。但端侧经典算法在难图上会产生
 *   **噪声 alpha**（前景零散、占比低）→ bbox 框不住人、反而框进大片背景 →
 *   上传的图里人只占 ~19% → 云端真模型在「人只占一小块 + 杂乱背景」的图上也给不出前景
 *   （scoremap 前景占比 0）→ 质量守门判 degenerate → 整体降级端侧 → 用户拿到烂图。
 *   **等于用不可信的信号（端侧 alpha）做关键决策**。
 *
 * 现在改为**三级策略**（按可信度从高到低）：
 *   ① 调用方给的人像区域提示（faceRegion）：T1 用人脸几何推出的区域，最可信；
 *   ② 端侧 alpha 可信（前景占比 ≥ MIN_FG_RATIO 且 bbox 面积 ≤ MAX_BBOX_RATIO）→ 用 alpha bbox；
 *   ③ 否则**回退为居中人像区**（几何裁剪，不是整图，仍满足「只上传人像区域」的合规意图）。
 *
 * ⚠️ 2026-10-27 二次修正（问题台账 #66，真机成品矩形接缝）：
 *   区域**绝不能切断人体**——证件照/自拍人像的躯干必然延续到画面底部，
 *   区域底边切在脖子/胸口处时，云端只重算区域内 alpha，区域外保留端侧 alpha
 *   （而端侧在这类图上恰恰不可信，才会走上云）→ 硬贴回必然露出矩形接缝。
 *   故：② bbox 底部过画面中线下部 → 直接延伸贴图底；③ 居中区域从顶部 2% 一路到图底。
 */
const MIN_FG_RATIO = 0.12;     // 端侧全图前景占比低于此 → 端侧 alpha 不可信
const MIN_BBOX_DENSITY = 0.35; // **bbox 内前景密度**低于此 → bbox 框不住人（框进大片背景）→ 不可信
const MAX_BBOX_RATIO = 0.7;    // 前景 bbox 占全图超过此 → 说明框不住人、框进了大片背景
const BBOX_PAD_MIN = 16;       // alpha bbox 外扩下限（px，原固定 8 太小，边缘信息不足）
const BBOX_PAD_RATIO = 0.08;   // alpha bbox 外扩比例（按 bbox 长边）
const BOTTOM_EXTEND_Y = 0.5;   // bbox 底部超过画面高度此比例 → 躯干必然延续，延伸贴图底
const EDGE_SNAP = 0.1;         // bbox 边距图边小于此比例 → 直接贴边（消灭窄条残留）
const CENTER_REGION_W = 0.8;   // 居中回退区域宽占比
const CENTER_REGION_TOP = 0.02;// 居中回退区域顶留白占比（底部贴图底）

function pickUploadRegion(rgba, alpha, w, h, hintRegion) {
  const full = { x: 0, y: 0, w, h, mode: 'full' };
  // ① 调用方提供的人像区域（人脸几何）优先
  if (hintRegion && hintRegion.w > 8 && hintRegion.h > 8) {
    const x = Math.max(0, Math.min(w - 1, Math.round(hintRegion.x)));
    const y = Math.max(0, Math.min(h - 1, Math.round(hintRegion.y)));
    const cw = Math.max(1, Math.min(w - x, Math.round(hintRegion.w)));
    const ch = Math.max(1, Math.min(h - y, Math.round(hintRegion.h)));
    return { x, y, w: cw, h: ch, mode: 'face_region' };
  }
  // ② 端侧 alpha 是否可信
  //    判据一：全图前景占比（太低 → alpha 几乎没抓到人）
  //    判据二：**bbox 内的前景密度**（bbox 是"框住人"的区域，密度低 → 框里大半是背景 → 不可信）
  //    注：可信度判定用**原始 bbox**；通过后再做外扩/贴边/贴底（#66：区域不能切断人体）
  const q = estimateQuality(alpha);
  const fgRatio = q.foregroundRatio;
  if (fgRatio >= MIN_FG_RATIO) {
    const c = cropForeground(rgba, alpha, w, h);
    if (!c.full) {
      const areaRatio = (c.w * c.h) / (w * h);
      let fgInBox = 0;
      for (let i = 0; i < c.alpha.length; i++) if (c.alpha[i] >= 0.5) fgInBox++;
      const density = fgInBox / (c.w * c.h);
      if (density >= MIN_BBOX_DENSITY && areaRatio <= MAX_BBOX_RATIO) {
        // 外扩：固定 8px 太小（切断发丝/轮廓信息），改为 bbox 长边的 8%（下限 16px）
        const pad = Math.max(BBOX_PAD_MIN, Math.round(Math.max(c.w, c.h) * BBOX_PAD_RATIO));
        let x0 = c.x - pad, y0 = c.y - pad, x1 = c.x + c.w - 1 + pad, y1 = c.y + c.h - 1 + pad;
        // 贴边：距图边 <10% 的窄条留在外面既无信息量又会留接缝，直接贴边
        if (x0 < w * EDGE_SNAP) x0 = 0;
        if (y0 < h * EDGE_SNAP) y0 = 0;
        if (x1 > w * (1 - EDGE_SNAP)) x1 = w - 1;
        // 贴底（#66 关键）：bbox 底部已越过画面中线下部 → 躯干/肩膀必然延续到图底，必须延伸
        if (c.y + c.h - 1 > h * BOTTOM_EXTEND_Y) y1 = h - 1;
        x0 = Math.max(0, x0); y0 = Math.max(0, y0);
        x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1);
        return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, mode: 'alpha_bbox', fgRatio, density };
      }
    }
  }
  // ③ 回退：居中人像区（人像通常在画面中央；**底部贴图底**——躯干必然延续，#66）
  const cw = Math.max(16, Math.round(w * CENTER_REGION_W));
  const x = Math.max(0, Math.round((w - cw) / 2));
  const y = Math.max(0, Math.round(h * CENTER_REGION_TOP));
  return { x, y, w: Math.min(cw, w - x), h: h - y, mode: 'center_region', fgRatio };
}

// ===================== 云端 alpha 去斑（scoremap 背景噪声抑制，问题台账 #66） =====================
// 百度 scoremap 是软 alpha：发丝半透明是优点，但**复杂背景下会有孤立的中低值噪声斑块**
// （真机实测：矩形上传区内的蓝底斑驳）。这些斑块远离人体，合成时把原背景又混了回来。
// 判据：alpha 中低值（<0.35）且 r 邻域内没有强前景（≥0.6）→ 是孤立噪声，清零。
// 发丝/轮廓过渡带紧邻人体强前景，密度门控不会误伤。
function cleanCloudAlpha(alpha, w, h) {
  const strong = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) strong[i] = alpha[i] >= 0.6 ? 1 : 0;
  const dens = boxFilter(strong, w, h, 6); // 13×13 邻域内强前景密度
  const out = Float32Array.from(alpha);
  for (let i = 0; i < w * h; i++) {
    if (out[i] < 0.35 && dens[i] < 0.02) out[i] = 0;
  }
  return out;
}

// ===================== 云端 alpha 贴回全图（v2：门控 + 羽化，问题台账 #66） =====================
// v1 硬贴回的教训：区域内用云端 alpha、区域外**无脑保留端侧 alpha**——而端侧在
// 「需要上云的图」上恰恰不可信（实测墙面被误判前景、整片泥浆值 0.15~0.5），
// 区域边界处两套 alpha 各说各话 → 成品露出矩形接缝、区域外原背景残留。
//
// v2 策略：
//   1) 区域外：不再直接信端侧，按「云端前景在区域边界的接触位置」做行/列门控 ——
//      云端说人从左边界第 y 行跨出 → 只保留左条带第 y 行的端侧前景（S 曲线固化），
//      其余行归零（背景）。人的躯干得以延续，墙面泥浆被清掉。
//   2) 门控保留区内再做一次阈值：端侧 ≥0.5 才保留（真机复跑发现：门打开后
//      0.15~0.5 的墙面泥浆仍会以 ~35% 不透明度糊在成品底角，必须再卡一道）。
//   3) 保留区的判定分两层（关键教训：区域外的端侧 alpha 整体不可信——
//      真机实测西装延续带的端侧值全是 0.48~0.51 的泥浆，西装与墙它根本分不开）：
//      - 传入了 rgba（正常链路）→ **颜色一致性是唯一保留标准**：门开的行/列里，
//        颜色与边界云端前景参考色相近 → 高置信人像延续，直接给近不透明（0.92）；
//        墙面/污渍色 → 清零。密度与端侧数值均不参与（它们在这类图上都是噪声）。
//      - 无 rgba（单测/旧调用兜底）→ 端侧 ≥0.5 + 17×17 邻域密度 ≥0.25 + S 曲线固化。
//   4) 区域内侧 6px 羽化带：云端 alpha 与「同口径门控后的」端侧值平滑过渡，消灭边界台阶。
//   5) crop.full（区域=整图）→ 直接返回云端 alpha，无需任何拼接。
function placeBack(fullAlpha, subAlpha, crop, w, h, rgba) {
  if (crop.full) return subAlpha;
  const GATE = 0.5;    // 云端前景「接触到边」的判定阈值；同时复用为端侧保留阈值
  const BAND = 3;      // 看边界内侧几 px 判定接触（抗 1px 毛刺）
  const FEATHER = 6;   // 区域内侧羽化带宽（px）
  const COLOR_GATE = 80; // 颜色一致性闸：与边界云端前景参考色的 RGB 距离上限
  const x0 = crop.x, y0 = crop.y;
  const x1 = crop.x + crop.w - 1, y1 = crop.y + crop.h - 1;
  const firm = (v) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };

  // ① 边界接触门控表：左/右边按行，顶/底边按列
  const rowGateL = new Uint8Array(h), rowGateR = new Uint8Array(h);
  const colGateT = new Uint8Array(w), colGateB = new Uint8Array(w);
  for (let yy = 0; yy < crop.h; yy++) {
    for (let b = 0; b < BAND && b < crop.w; b++) {
      if (subAlpha[yy * crop.w + b] >= GATE) rowGateL[y0 + yy] = 1;
      if (subAlpha[yy * crop.w + crop.w - 1 - b] >= GATE) rowGateR[y0 + yy] = 1;
    }
  }
  for (let xx = 0; xx < crop.w; xx++) {
    for (let b = 0; b < BAND && b < crop.h; b++) {
      if (subAlpha[b * crop.w + xx] >= GATE) colGateT[x0 + xx] = 1;
      if (subAlpha[(crop.h - 1 - b) * crop.w + xx] >= GATE) colGateB[x0 + xx] = 1;
    }
  }

  // 端侧强前景密度图（密度闸用）：孤立的强值斑点密度低，成片的躯干延续密度高
  const strongLocal = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) strongLocal[i] = fullAlpha[i] >= GATE ? 1 : 0;
  const densLocal = boxFilter(strongLocal, w, h, 8); // 17×17 邻域
  const MIN_LOCAL_DENSITY = 0.25;

  // 边界云端前景参考色（颜色闸用）：每条边的每行/列，取边界内侧云端前景像素的加权平均色
  // 人无跨出（门关闭）的行/列无参考色——反正门控已拦，无需颜色判断
  const refL = new Array(h).fill(null), refR = new Array(h).fill(null);
  const refT = new Array(w).fill(null), refB = new Array(w).fill(null);
  if (rgba) {
    const avgRef = (hits) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const pi of hits) { r += rgba[pi]; g += rgba[pi + 1]; b += rgba[pi + 2]; n++; }
      return n ? [r / n, g / n, b / n] : null;
    };
    for (let yy = 0; yy < crop.h; yy++) {
      const hitsL = [], hitsR = [];
      for (let b = 0; b < BAND && b < crop.w; b++) {
        if (subAlpha[yy * crop.w + b] >= GATE) hitsL.push(((y0 + yy) * w + x0 + b) * 4);
        if (subAlpha[yy * crop.w + crop.w - 1 - b] >= GATE) hitsR.push(((y0 + yy) * w + x1 - b) * 4);
      }
      if (x0 > 0 && hitsL.length) refL[y0 + yy] = avgRef(hitsL);
      if (x1 < w - 1 && hitsR.length) refR[y0 + yy] = avgRef(hitsR);
    }
    for (let xx = 0; xx < crop.w; xx++) {
      const hitsT = [], hitsB = [];
      for (let b = 0; b < BAND && b < crop.h; b++) {
        if (subAlpha[b * crop.w + xx] >= GATE) hitsT.push(((y0 + b) * w + x0 + xx) * 4);
        if (subAlpha[(crop.h - 1 - b) * crop.w + xx] >= GATE) hitsB.push(((y1 - b) * w + x0 + xx) * 4);
      }
      if (y0 > 0 && hitsT.length) refT[x0 + xx] = avgRef(hitsT);
      if (y1 < h - 1 && hitsB.length) refB[x0 + xx] = avgRef(hitsB);
    }
  }
  const colorOk = (x, y, refs) => {
    if (!rgba) return true; // 未传 rgba → 跳过颜色闸（单测/旧调用兼容）
    for (const ref of refs) {
      if (!ref) continue;
      const i = (y * w + x) * 4;
      const dr = rgba[i] - ref[0], dg = rgba[i + 1] - ref[1], db = rgba[i + 2] - ref[2];
      if (Math.sqrt(dr * dr + dg * dg + db * db) > COLOR_GATE) return false;
    }
    return true;
  };

  // 端侧值的「保留口径」（见函数头注释第 3 条）：
  //   有 rgba → 门控 + 颜色一致性（人像延续近不透明；墙色清零）
  //   无 rgba → 门控 + 端侧 ≥GATE + 密度闸 + S 曲线固化（兜底）
  const CONTINUATION_ALPHA = 0.92; // 颜色确认的人像延续：近不透明（西装/衬衫延续带）
  const gatedLocal = (x, y, edgeL, edgeR, edgeT, edgeB) => {
    const i = y * w + x;
    const refs = [];
    if (edgeL) { if (!rowGateL[y]) return 0; if (refL[y]) refs.push(refL[y]); }
    if (edgeR) { if (!rowGateR[y]) return 0; if (refR[y]) refs.push(refR[y]); }
    if (edgeT) { if (!colGateT[x]) return 0; if (refT[x]) refs.push(refT[x]); }
    if (edgeB) { if (!colGateB[x]) return 0; if (refB[x]) refs.push(refB[x]); }
    if (rgba) {
      if (!refs.length) return 0; // 门开但无参考色（理论不发生）→ 保守清零
      return colorOk(x, y, refs) ? CONTINUATION_ALPHA : 0;
    }
    const lv = fullAlpha[i];
    if (lv < GATE) return 0;
    if (densLocal[i] < MIN_LOCAL_DENSITY) return 0;
    return firm(lv);
  };

  // ② 区域外：门控 + 阈值后的端侧固化值（人跨出的行/列才保留，其余归零）
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue; // 区域内下一步填
      out[y * w + x] = gatedLocal(x, y, x < x0, x > x1, y < y0, y > y1);
    }
  }

  // ③ 区域内：云端 alpha；靠图像内侧的边界留 6px 羽化带，与同口径门控端侧值平滑过渡
  for (let yy = 0; yy < crop.h; yy++) {
    for (let xx = 0; xx < crop.w; xx++) {
      const i = (y0 + yy) * w + (x0 + xx);
      const cv = subAlpha[yy * crop.w + xx];
      // 只在与「图内区域」相邻的边羽化；贴图边的边界外没有像素，无需羽化
      let d = Infinity;
      const nearL = x0 > 0 && xx < FEATHER;
      const nearR = x1 < w - 1 && crop.w - 1 - xx < FEATHER;
      const nearT = y0 > 0 && yy < FEATHER;
      const nearB = y1 < h - 1 && crop.h - 1 - yy < FEATHER;
      if (x0 > 0) d = Math.min(d, xx);
      if (x1 < w - 1) d = Math.min(d, crop.w - 1 - xx);
      if (y0 > 0) d = Math.min(d, yy);
      if (y1 < h - 1) d = Math.min(d, crop.h - 1 - yy);
      if (d >= FEATHER) { out[i] = cv; continue; }
      const t = (d + 1) / (FEATHER + 1);
      const wgt = t * t * (3 - 2 * t);
      const lv = gatedLocal(x0 + xx, y0 + yy, nearL, nearR, nearT, nearB);
      out[i] = cv * wgt + lv * (1 - wgt);
    }
  }
  return out;
}

// ===================== 上传降采样 / 回贴放大 =====================
// 降采样 RGBA（面积平均，缩小时比最近邻干净，避免混色边）
function downsampleRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const rx = sw / dw, ry = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * ry), y1 = Math.min(sh - 1, Math.ceil((y + 1) * ry) - 1);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * rx), x1 = Math.min(sw - 1, Math.ceil((x + 1) * rx) - 1);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
        }
      }
      const di = (y * dw + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
    }
  }
  return out;
}

// 双线性放大单通道 alpha（Float32Array 0~1）
function upscaleAlpha(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const rx = sw / dw, ry = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * ry, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * rx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1];
      const c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

// ===================== 上传像素封顶（载荷保护） =====================
// 【2026-10-23 owner 决策 600dpi 全工具开放后新增】
// 微信 CloudBase `wx.cloud.callFunction` 的 data 字段大小上限为 5MB（官方文档）。
// 上云链路传的是 base64(RGBA)，体积 = 像素数 × 4 × 4/3(base64 膨胀) ≈ 像素数 × 5.3 字节。
//   800px 工作图（约 64 万像素）→ base64 约 3.4MB，逼近上限；
//   600dpi 工作图可到 1600px（约 256 万像素）→ base64 约 13.6MB，**必然超限抛错**。
// 官方建议：大数据字段用 wx.cloud.CDN 标记后走 CDN（返回 url），而非直接塞进 data。
// 本项目的解法（无需改云函数契约）：
//   上云**只用于精修 alpha 边缘**，不需要与成品同分辨率 ——
//   因此上传前把裁剪区域降采样到 UPLOAD_MAX_PIXELS 以内，
//   云端返回的 alpha 再双线性放大回原尺寸贴回全图。
//   代价：边缘精度略降（放大插值），收益：链路在 600dpi 下仍能跑通，且保留
//   「仅上传裁剪后人像区域、不上传全图」的合规属性（PRD I3 / 第 7 章）。
const UPLOAD_MAX_PIXELS = 640000; // ≈ 800×800，与 300dpi 档既有行为基本一致

// ===================== 境内 endpoint 断言（数据不出境，fail-closed） =====================
// 无法物理探测机房位置，采用「白名单 + 境内后缀」启发式；任一不满足即阻断，绝不把人脸送跨境。
// 说明：'.baidubce.com' 为百度智能云中国大陆节点（人像分割 API 主机 aip.baidubce.com）。
// 本项目由**云函数**调用它（小程序端不直连，端侧只连 cloud://），此处登记是为了让
// 「境内断言」这一条规则在涉及百度链路时同样成立 —— 若哪天有人把百度调用搬进前端，
// assertDomestic 会认可该主机，但密钥入前端的风险另由代码评审把关。
const DOMESTIC_SUFFIX = ['.cn', '.tencentcloudapi.com', '.myqcloud.com', '.aliyuncs.com', '.huaweicloud.com', '.volcengine.com', '.baidubce.com'];
function isDomesticSuffix(host) {
  const h = (host || '').toLowerCase();
  return DOMESTIC_SUFFIX.some((s) => h.endsWith(s));
}
function assertDomestic(endpoint, trustedHosts) {
  if (!endpoint) throw new Error('cloud: 未配置上云 endpoint');
  // CloudBase 云函数（cloud:// 协议）由微信/腾讯境内环境保证，天然不出境，豁免域名白名单校验
  if (typeof endpoint === 'string' && endpoint.startsWith('cloud://')) return true;
  let host;
  try { host = new URL(endpoint).hostname; } catch (e) { throw new Error('cloud: endpoint 非法 — ' + endpoint); }
  const ok = (Array.isArray(trustedHosts) && trustedHosts.includes(host)) || isDomesticSuffix(host);
  if (!ok) {
    throw new Error(`cloud: endpoint 非境内(${host})，违反数据不出境合规，已阻断（如需放行请加入 trustedHosts 白名单）`);
  }
  return true;
}

// ===================== 真实 adapter（注入 wx.request / fetch） =====================
// adapter.call(reqJSON) → 返回 { alphaB64, region }
// 由调用方在小程序侧用 wx.request、在 h5/Node 侧用 fetch 实现；core 不内置网络。
// ===================== 云端结果接受判据（任务：接入百度商用 API） =====================
// 【为什么不能继续用 confidence 比较 —— 一个会让真模型被误杀的坑】
// 原判据：云端 confidence < 本地 confidence → 判定「上云变差」并降级。
// 而 confidence = 1 - ambiguousRatio（alpha 落在 0.1~0.9 的比例）。
// 端侧经典基线输出的是**接近二值**的 alpha（中间值少 → ambiguous 低 → confidence 高）；
// 真模型（百度 scoremap / BiRefNet）输出的是**软 alpha**，发丝、半透明衣边天然落在
// 0.1~0.9 → ambiguous 更高 → confidence 更低。**质量更好，分数却更差**。
// 若沿用旧判据，真模型会被 100% 误判为「变差」而降级，等于白接。
//
// 新判据（真实模型走前景占比合理性，不再比 confidence）：
//   ① 退化检测：云端前景占比 <0.5% 或 >99.5% → 模型没分割出人/整图当人，判失败
//   ② 偏移检测：**仅当端侧 alpha 可信时**（confidence ≥ CONF_THRESHOLD=0.85）才比对——
//      与本地前景占比差 >0.25 → 两者分歧过大，判失败（保守起见退回本地）。
//      ⚠️ 台账 #68（2026-10-27 批量真实头像验收发现）：端侧不可信时**禁止**拿它当参照系——
//      端侧置信低正是上云的原因，此时它的前景占比是泥浆值（实测 images(4)：端侧 0.748 vs
//      云端 0.304，云端才是对的；123.png：端侧 0.58 vs 云端 0.95，人占满小图，云端也是对的），
//      拿不可信参照系做偏移门 = 把云端正确答案误杀（同 #64「用不可信信号做关键决策」）。
//      端侧不可信时只保留退化检测 + providerMeta 元数据记录。
//   ③ 其余情况接受真模型结果（软 alpha 的「歧义多」是优点不是缺点）
// 非真模型（local-stub 离线验证用）维持原豁免；未知 provider 维持原 confidence 比较。
const LOCAL_TRUST_CONF = 0.85; // 与 matting.js 的 CONF_THRESHOLD 同值：端侧路由阈值即端侧可信度阈值
function shouldAcceptCloudAlpha({ cloudAlpha, localAlpha, provider } = {}) {
  const qc = estimateQuality(cloudAlpha);
  const ql = estimateQuality(localAlpha);
  const meta = { cloudConf: qc.confidence, localConf: ql.confidence, cloudFg: qc.foregroundRatio, localFg: ql.foregroundRatio };
  if (provider === 'local-stub') return { accept: true, reason: 'local-stub 离线链路，豁免比对', ...meta };
  if (qc.foregroundRatio < 0.005 || qc.foregroundRatio > 0.995) {
    return { accept: false, reason: 'cloud_foreground_degenerate', ...meta };
  }
  if (provider === 'baidu' || provider === 'birefnet') {
    if (ql.confidence >= LOCAL_TRUST_CONF && Math.abs(qc.foregroundRatio - ql.foregroundRatio) > 0.25) {
      return { accept: false, reason: 'cloud_foreground_shift', ...meta };
    }
    return { accept: true, reason: ql.confidence >= LOCAL_TRUST_CONF ? 'real_model_soft_alpha' : 'real_model_local_untrusted', ...meta };
  }
  if (qc.confidence < ql.confidence - 1e-3) return { accept: false, reason: 'cloud_confidence_lower', ...meta };
  return { accept: true, reason: 'confidence_ok', ...meta };
}

/**
 * 路2（自有/HTTP）上云 adapter。
 * @param {{endpoint:string, trustedHosts:string[], authToken?:string, fetchImpl?:Function, region?:string}} cfg
 *   `authToken` / `fetchImpl` 为**可选**：路2 未启用时 `services/index.ts` 只传
 *   `{endpoint, trustedHosts, region}`（该处为占位配置，见问题台账 #12）。
 */
function makeHttpAdapter({ endpoint, trustedHosts, authToken, fetchImpl, region = 'CN' }) {
  assertDomestic(endpoint, trustedHosts);
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  return {
    endpoint, trustedHosts, kind: 'http',
    async call(req) {
      if (!doFetch) throw new Error('cloud: 运行环境无 fetch/wx.request，无法发起上云请求');
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent': 'faceCloudEnhance', Authorization: authToken ? `Bearer ${authToken}` : '' },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error('cloud http ' + res.status);
      const json = await res.json();
      return {
        alphaB64: json.alphaB64 || json.alpha,
        region: json.region || region,
        provider: json.provider || null,          // 'baidu' / 'shadow' / 'birefnet' / null
        providerMeta: json.providerMeta || null,  // 含降级原因、上传像素、耗时等元数据
      };
    },
  };
}

// ===================== 本地 BiRefNet 影子实现（沙箱可跑通链路，明确标注非真模型） =====================
// 沙箱无 GPU / 出不了 HuggingFace，无法真正部署 BiRefNet；本 stub 用「经典基线初值 + 引导滤波保边精细化」
// 模拟云端高精度模型的能力（边缘更干净、抗背景噪声），让链路在本地真实跑通、质量可对比。
// 真 BiRefNet 部署后，仅需把 adapter 换成 makeHttpAdapter（同契约），stub 可整体替换。
function boxFilter(src, w, h, r) {
  const W = w + 1;
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    I[(y + 1) * W + (x + 1)] = src[i] + I[y * W + (x + 1)] + I[(y + 1) * W + x] - I[y * W + x];
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w - 1, x + r), y1 = Math.min(h - 1, y + r);
    const sum = I[(y1 + 1) * W + (x1 + 1)] - I[(y1 + 1) * W + x0] - I[y0 * W + (x1 + 1)] + I[y0 * W + x0];
    out[y * w + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1));
  }
  return out;
}
// 引导滤波：以原图灰度引导，对 alpha 做保边平滑（BiRefNet 相对经典基线的主要优势点）
function guidedRefine(rgba, alpha, w, h, r, eps) {
  const guide = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) guide[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const meanG = boxFilter(guide, w, h, r);
  const meanA = boxFilter(alpha, w, h, r);
  const ga = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) ga[i] = guide[i] * alpha[i];
  const meanGA = boxFilter(ga, w, h, r);
  const gg = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gg[i] = guide[i] * guide[i];
  const meanGG = boxFilter(gg, w, h, r);
  const varG = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) varG[i] = meanGG[i] - meanG[i] * meanG[i];
  const a = new Float32Array(w * h);
  const b = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    a[i] = (meanGA[i] - meanG[i] * meanA[i]) / (varG[i] + eps);
    b[i] = meanA[i] - a[i] * meanG[i];
  }
  const meanA2 = boxFilter(a, w, h, r);
  const meanB2 = boxFilter(b, w, h, r);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = meanA2[i] * guide[i] + meanB2[i];
  // 边缘锐化：把平滑后的软 alpha 拉回更干净的二值边界（模拟高精度模型收边）
  for (let i = 0; i < w * h; i++) out[i] = 1 / (1 + Math.exp(-(out[i] - 0.5) * 8));
  return out;
}
// 多高斯（2 分量）聚类：近似云端高精度模型对多模态背景/前景的更强建模能力
function dist2(a, b) { let s = 0; for (let k = 0; k < 3; k++) { const d = a[k] - b[k]; s += d * d; } return s; }
function kmeans2(samples, iters) {
  if (samples.length === 0) return [[0, 0, 0], [255, 255, 255]];
  let m1 = samples[0].slice(), m2 = samples[samples.length - 1].slice();
  for (let it = 0; it < iters; it++) {
    const c1 = [0, 0, 0], c2 = [0, 0, 0]; let n1 = 0, n2 = 0;
    for (const s of samples) {
      if (dist2(s, m1) <= dist2(s, m2)) { c1[0] += s[0]; c1[1] += s[1]; c1[2] += s[2]; n1++; }
      else { c2[0] += s[0]; c2[1] += s[1]; c2[2] += s[2]; n2++; }
    }
    if (n1) m1 = [c1[0] / n1, c1[1] / n1, c1[2] / n1];
    if (n2) m2 = [c2[0] / n2, c2[1] / n2, c2[2] / n2];
  }
  return [m1, m2];
}
function clusterGaussians(samples) {
  const [m1, m2] = kmeans2(samples, 6);
  const g1 = gaussianFromSamples(samples.filter((s) => dist2(s, m1) <= dist2(s, m2)).concat([m1]));
  const g2 = gaussianFromSamples(samples.filter((s) => dist2(s, m2) < dist2(s, m1)).concat([m2]));
  return [g1, g2];
}
// 云端「更强模型」代理：多高斯前景/背景建模 + 引导滤波保边（优于端侧单高斯基线）
function strongSegment(rgba, w, h) {
  const band = 2;
  const bg = [], fg = [];
  for (let x = 0; x < w; x++) for (let b = 0; b < band; b++) {
    bg.push(sampleRGB(rgba, x, b, w)); bg.push(sampleRGB(rgba, x, h - 1 - b, w));
  }
  for (let y = 0; y < h; y++) for (let b = 0; b < band; b++) {
    bg.push(sampleRGB(rgba, b, y, w)); bg.push(sampleRGB(rgba, w - 1 - b, y, w));
  }
  // 初值：单高斯快速定位前景种子
  const init = runClassicalFallback(rgba, w, h);
  for (let i = 0; i < w * h; i++) if (init[i] > 0.9) fg.push(sampleRGB(rgba, i % w, (i / w) | 0, w));
  const bgG = clusterGaussians(bg.length ? bg : [[0, 0, 0]]);
  const alpha = new Float32Array(w * h);
  if (fg.length === 0) return guidedRefine(rgba, init, w, h, 4, 1e-3); // 无前景种子 → 回退初值精化
  const fgG = clusterGaussians(fg);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    let dBg = Infinity, dFg = Infinity;
    for (const gx of bgG) { const d = mahalanobis(r, g, b, gx.mean, gx.covInv); if (d < dBg) dBg = d; }
    for (const gx of fgG) { const d = mahalanobis(r, g, b, gx.mean, gx.covInv); if (d < dFg) dFg = d; }
    alpha[i] = sigmoid((dBg - dFg) * 0.8 + 0.1);
  }
  const refined = guidedRefine(rgba, alpha, w, h, 4, 1e-3);
  // 上云增强语义：云端高精度模型应 ≥ 端侧基线。若精化反而引入歧义，回退端侧初值（不退化）。
  const qRef = estimateQuality(refined);
  const qInit = estimateQuality(init);
  return qRef.confidence >= qInit.confidence - 1e-3 ? refined : init;
}

function makeLocalBiRefStub({ trustedHosts, endpoint = 'https://cn-gpu-fn.example.cn/matting', region = 'CN' } = {}) {
  return {
    endpoint: assertDomestic(endpoint, trustedHosts) ? endpoint : endpoint,
    trustedHosts, kind: 'local-stub',
    async call(req) {
      // 真实链路会经 JSON 序列化往返；stub 同样走 base64 编解码，验证序列化契约无误
      const bytes = fromBase64(req.image);
      const rgba = new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      // 云端更强模型代理：多高斯 + 引导滤波保边精化（明显优于端侧单高斯基线）
      const enhanced = strongSegment(rgba, req.width, req.height);
      return { alphaB64: encodeAlphaB64(enhanced), region };
    },
  };
}

// ===================== 上云增强主入口 =====================
// 入参：
//   rgba/alpha/width/height  : 端侧初值
//   adapter                 : makeHttpAdapter | makeLocalBiRefStub（注入）
//   consents                : 已授予的授权项数组，须含 'faceCloudEnhance'(AC5)
//   audit(stageMeta)        : 审计回调，仅收到元数据，绝不传像素(AC8)
// 返回：
//   { alpha, backend, confidence, degraded, cloudMeta }
async function cloudMatting({ rgba, alpha, width, height, adapter, consents = [], audit, tool = 'T1', faceRegion = null } = {}) {
  if (!adapter) throw new Error('cloud: 未注入 adapter');
  if (!consents.includes('faceCloudEnhance')) {
    // AC5：缺少上云增强单独授权，阻断（绝不降级偷偷上传）
    audit && audit({ stage: 'blocked_no_consent', tool, hasPixel: false });
    throw new Error('AC5: 缺少上云增强(faceCloudEnhance)单独授权，已阻断上传');
  }
  // 数据不出境：注入的 adapter 已在构造时断言境内；这里二次校验 endpoint
  assertDomestic(adapter.endpoint, adapter.trustedHosts);

  // 仅裁剪人像区域(非全图，I3/第171行)
  // ⚠️ 区域选择改用 pickUploadRegion：端侧 alpha 不可信时不再用它框人（问题台账 #64）
  const region = pickUploadRegion(rgba, alpha, width, height, faceRegion);
  const crop = cropRect(rgba, alpha, width, height, region);
  if (audit) {
    audit({
      stage: 'upload_region', mode: region.mode, fgRatio: region.fgRatio == null ? null : Math.round(region.fgRatio * 1000) / 1000,
      rect: { x: region.x, y: region.y, w: region.w, h: region.h }, tool, hasPixel: false,
    });
  }

  // 上传降采样（载荷保护，见 UPLOAD_MAX_PIXELS 注释）：
  // 上云只为精修 alpha 边缘，不必与成品同分辨率；超限时降采样以适配 5MB 载荷上限。
  let upW = crop.w, upH = crop.h;
  let upRgba = crop.rgba;
  let downSampled = false;
  if (crop.w * crop.h > UPLOAD_MAX_PIXELS) {
    const k = Math.sqrt(UPLOAD_MAX_PIXELS / (crop.w * crop.h));
    upW = Math.max(1, Math.round(crop.w * k));
    upH = Math.max(1, Math.round(crop.h * k));
    upRgba = downsampleRGBA(crop.rgba, crop.w, crop.h, upW, upH);
    downSampled = true;
  }

  const req = {
    region: 'CN',
    purpose: 'matting_enhance',
    retain: false,        // 处理完即销毁
    train: false,         // 不做模型训练留存
    consent: 'faceCloudEnhance',
    width: upW,
    height: upH,
    image: toBase64(upRgba), // 仅裁剪区域像素，base64
  };

  const t0 = Date.now();
  let resp;
  try {
    resp = await adapter.call(req);
  } catch (e) {
    // 网络/鉴权失败 → 降级端侧（第258/292行：上云失败有降级提示）
    audit && audit({
      stage: 'cloud_fail',
      error: String((e && e.message) || e),
      payloadKb: Math.round((req.image || '').length / 1024), // 载荷体积（排查 callFunction 体积限制）
      uploadPx: upW * upH,
      degraded: true, hasPixel: false,
    });
    return { alpha, backend: 'cloud->edge', confidence: estimateQuality(alpha).confidence, degraded: true, reason: 'network_or_auth', cloudMeta: { latencyMs: Date.now() - t0 } };
  }
  const dt = Date.now() - t0;

  const subAlphaRaw = decodeAlphaB64(resp.alphaB64, upW * upH);
  // 若上传时降采样过，把 alpha 双线性放大回裁剪区原始尺寸再贴回全图
  const subAlphaUp = downSampled
    ? upscaleAlpha(subAlphaRaw, upW, upH, crop.w, crop.h)
    : subAlphaRaw;
  // 去斑（#66）：scoremap 软 alpha 的孤立背景噪声清零后再参与判责与贴回，
  // 否则复杂背景图合成后矩形区内会看到斑驳的原背景残影
  const subAlpha = cleanCloudAlpha(subAlphaUp, crop.w, crop.h);
  // 传入 rgba：启用颜色一致性闸（区域外保留的躯干延续必须与边界云端前景同色，#66）
  const enhanced = placeBack(alpha, subAlpha, crop, width, height, rgba);
  // 子图尺度公平比较：云端只看到裁剪区域(见 PRD 第171行仅上传裁剪人像区域)，
  // 与全图像素数无关，避免尺度差异造成的歧义占比偏差误判「上云变差」。
  // 云端身份：真模型（baidu/birefnet）走「前景占比合理性」判据，避免软 alpha 被误杀
  // （详见 shouldAcceptCloudAlpha 的函数级注释）
  const provider = resp.provider || (adapter.kind === 'local-stub' ? 'local-stub' : null);
  const verdict = shouldAcceptCloudAlpha({ cloudAlpha: subAlpha, localAlpha: crop.alpha, provider });
  if (!verdict.accept) {
    // 上云结果异常 → 降级，避免变差
    audit && audit({
      stage: 'cloud_degraded_quality', reason: verdict.reason, provider,
      cloudConf: verdict.cloudConf, localConf: verdict.localConf,
      cloudFg: verdict.cloudFg, localFg: verdict.localFg,
      // 云端返回的元数据（source=scoremap/foreground、personNum=是否检测到人、图尺寸）——
      // 排查「云端说没人」到底是模型没认出人还是我们解码口径不对（2026-10-27 真机排障）
      providerMeta: resp.providerMeta || null,
      uploadPx: upW * upH,
      cloudAlphaBytes: subAlphaRaw.__len || 0,
      expectedAlphaBytes: upW * upH,
      degraded: true, hasPixel: false,
    });
    return {
      alpha, backend: 'cloud->edge', confidence: verdict.localConf, degraded: true,
      reason: verdict.reason,
      cloudMeta: { latencyMs: dt, provider, providerMeta: resp.providerMeta || null },
    };
  }
  // AC8：审计只记元数据，无像素
  audit && audit({ stage: 'cloud_ok', latencyMs: dt, region: resp.region || 'CN', confidence: verdict.cloudConf, retained: false, provider, hasPixel: false });
  return {
    alpha: enhanced, backend: 'cloud', confidence: estimateQuality(enhanced).confidence, degraded: false,
    cloudMeta: { latencyMs: dt, region: resp.region || 'CN', retained: false, provider, providerMeta: resp.providerMeta || null },
  };
}

module.exports = {
  // 序列化
  toBase64, fromBase64, encodeAlphaB64, decodeAlphaB64,
  // 裁剪
  cropForeground, cropRect, placeBack, cleanCloudAlpha,
  // 上传区域选择（三级策略：人脸区域 → alpha bbox → 居中回退，问题台账 #64）
  pickUploadRegion, MIN_FG_RATIO, MIN_BBOX_DENSITY, MAX_BBOX_RATIO,
  // 境内断言
  assertDomestic, isDomesticSuffix,
  // 云端判据
  shouldAcceptCloudAlpha,
  // adapter
  makeHttpAdapter, makeLocalBiRefStub,
  // 主入口
  cloudMatting,
  // stub 内部（供测试/PoC 复用）
  guidedRefine,
};
