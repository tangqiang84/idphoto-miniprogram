'use strict';
// 受限美颜（PRD E 章 / AC2 / E1 / E2，任务 #38）
//
// 【合规红线，最高优先级】
//   · 本小程序为个人主体、定位证件照审核合规，所有处理默认处于「合规模式」。
//   · E1 允许项：磨皮、美白、亮眼（均轻度）。
//   · E2 禁止项：瘦脸、大眼、重塑五官 —— 合规模式下硬拦截（控件置灰 + 代码层断言拦截）。
//   · 任何绕过尝试（向 applyBeauty 传入禁止项）一律抛错并提示 COMPLIANCE_MSG，绝不悄悄执行。
//
// 【实现策略（务实，非训练模型）】
//   · 磨皮：保边表面模糊（edge-preserving surface blur）。先算一次可分离高斯模糊，再按
//     逐像素「边缘幅度」决定平滑强度——平坦皮肤区平滑、五官/发丝边缘保细节（避免把脸磨成假人）。
//   · 美白：轻度亮度抬升（对高光留余量，防过曝）。
//   · 亮眼：复用磨皮的模糊做非锐化掩膜（unsharp），轻度提升中高频清晰度，使眼睛更通透；
//     不依赖人脸关键点（本 App 无眼部 landmark），属全局轻度锐化，已在 UI 文案如实标注「轻度」。
//   · 全部为端侧 RGBA 像素运算，不出设备、不调用任何云端模型。
//
// 【性能】可分离高斯 O(w·h·r)，默认 r 随图尺寸自适应（min(w,h)/280，1–6）。
//   证件照工作画布通常 ≤ 1600 边，单张 1–2 次模糊 + 1 遍合成，中端机百毫秒内。

// 合规模式总开关（个人主体默认常开；如未来有合规的企业主体版本，可在此处统一切换）
const COMPLIANCE_MODE = true;

// 合规模式拦截提示（E2：尝试开启被禁美颜项时提示）
const COMPLIANCE_MSG = '为保证审核通过，合规模式禁止改动五官（瘦脸/大眼/重塑）';

// 美颜项目录：allowed=false 的项在合规模式下被硬拦截
const BEAUTY_CATALOG = {
  smooth:  { id: 'smooth',  label: '磨皮',     allowed: true },
  whiten:  { id: 'whiten',  label: '美白',     allowed: true },
  brighten: { id: 'brighten', label: '亮眼',   allowed: true },
  slim:    { id: 'slim',    label: '瘦脸',     allowed: false },
  bigeye:  { id: 'bigeye',  label: '大眼',     allowed: false },
  reshape: { id: 'reshape', label: '重塑五官', allowed: false },
};

// 边缘判定阈值：逐像素平滑残差（RGB 最大通道差）超过此值视为边缘，保细节不磨。
// 经验值：证件照 8bit 通道下，明显边缘残差远大于 24；皮肤/背景平坦区远低于此。
const EDGE_TOL = 24;

// 美白系数（whiten∈[0,1] 时，每通道最大提亮幅度 = 0.4×whiten）
const WHITEN_K = 0.4;

// 亮眼（非锐化）系数（brighten∈[0,1] 时，高频增益 = 0.6×brighten）
const UNSHARP_K = 0.6;

// 检查 ops 中是否含被禁项；含则抛错（E2 硬拦截，AC2 验收依据）
function assertCompliance(ops) {
  if (!ops || typeof ops !== 'object') return;
  for (const key of Object.keys(ops)) {
    const item = BEAUTY_CATALOG[key];
    if (item && item.allowed === false && ops[key]) {
      throw new Error(COMPLIANCE_MSG);
    }
  }
}

// 一维高斯核（半径 r，sigma=r/2），已归一化
function gaussianKernel(r) {
  const radius = Math.max(0, Math.floor(r));
  const sigma = radius <= 0 ? 0.5 : radius / 2;
  const k = radius * 2 + 1;
  const kernel = new Float32Array(k);
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const x = i - radius;
    const v = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel[i] = v;
    sum += v;
  }
  if (sum > 0) for (let i = 0; i < k; i++) kernel[i] /= sum;
  return { kernel, radius };
}

// 横向可分离模糊（处理 alpha，但美颜仅改 RGB；alpha 直接透传）
function blurH(src, dst, w, h, radius, kernel) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = -radius; i <= radius; i++) {
        let xx = x + i;
        if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        const idx = (row + xx) * 4;
        const kw = kernel[i + radius];
        r += src[idx] * kw;
        g += src[idx + 1] * kw;
        b += src[idx + 2] * kw;
        a += src[idx + 3] * kw;
      }
      const o = (row + x) * 4;
      dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = a;
    }
  }
}

// 纵向可分离模糊
function blurV(src, dst, w, h, radius, kernel) {
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = -radius; i <= radius; i++) {
        let yy = y + i;
        if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
        const idx = (yy * w + x) * 4;
        const kw = kernel[i + radius];
        r += src[idx] * kw;
        g += src[idx + 1] * kw;
        b += src[idx + 2] * kw;
        a += src[idx + 3] * kw;
      }
      const o = (y * w + x) * 4;
      dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = a;
    }
  }
}

/**
 * 受限美颜主入口（原地处理 rgba，返回同一缓冲）。
 *
 * @param {Uint8ClampedArray} rgba  像素缓冲（RGBA，length = w*h*4）
 * @param {number} w
 * @param {number} h
 * @param {object} ops  { smooth?:0..1, whiten?:0..1, brighten?:0..1 }
 *                      仅允许 E1 项；若误传 E2 禁止项（slim/bigeye/reshape 非零），抛 COMPLIANCE_MSG。
 * @returns {Uint8ClampedArray} 同一 rgba 缓冲（已就地修改）
 */
function applyBeauty(rgba, w, h, ops) {
  if (!rgba || !w || !h) return rgba;
  // E2 硬拦截：任何被禁项一律抛错，绝不执行
  assertCompliance(ops || {});

  const smooth = ops && typeof ops.smooth === 'number' ? ops.smooth : 0;
  const whiten = ops && typeof ops.whiten === 'number' ? ops.whiten : 0;
  const brighten = ops && typeof ops.brighten === 'number' ? ops.brighten : 0;
  if (smooth <= 0 && whiten <= 0 && brighten <= 0) return rgba;

  // 半径随图尺寸自适应
  const radius = Math.max(1, Math.round(Math.min(w, h) / 280));
  const { kernel } = gaussianKernel(radius);

  // 两次可分离模糊得到平滑图（与 rgba 分离，便于后续逐像素合成）
  const tmp = new Uint8ClampedArray(rgba.length);
  blurH(rgba, tmp, w, h, radius, kernel);
  const blur = new Uint8ClampedArray(rgba.length);
  blurV(tmp, blur, w, h, radius, kernel);

  const n = w * h * 4;
  for (let i = 0; i < n; i += 4) {
    const origR = rgba[i], origG = rgba[i + 1], origB = rgba[i + 2];

    // 1) 保边磨皮：平滑残差 = 原图 - 模糊；边缘幅度大则保细节。
    const dR = origR - blur[i];
    const dG = origG - blur[i + 1];
    const dB = origB - blur[i + 2];
    const mag = Math.max(Math.abs(dR), Math.abs(dG), Math.abs(dB)); // 边缘幅度
    const edge = mag > EDGE_TOL ? 1 : mag / EDGE_TOL; // 0=平坦, 1=边缘
    const keep = 1 - smooth * (1 - edge); // 平坦→1-smooth(磨), 边缘→1(保)
    let sR = blur[i] + dR * keep;
    let sG = blur[i + 1] + dG * keep;
    let sB = blur[i + 2] + dB * keep;

    // 2) 美白：轻度亮度抬升（高光留余量）
    if (whiten > 0) {
      const k = whiten * WHITEN_K;
      sR = sR + (255 - sR) * k;
      sG = sG + (255 - sG) * k;
      sB = sB + (255 - sB) * k;
    }

    // 3) 亮眼：复用模糊做非锐化（提升中高频清晰度，使眼睛更通透）
    if (brighten > 0) {
      const k = brighten * UNSHARP_K;
      sR = sR + (sR - blur[i]) * k;
      sG = sG + (sG - blur[i + 1]) * k;
      sB = sB + (sB - blur[i + 2]) * k;
    }

    rgba[i] = sR < 0 ? 0 : sR > 255 ? 255 : sR;
    rgba[i + 1] = sG < 0 ? 0 : sG > 255 ? 255 : sG;
    rgba[i + 2] = sB < 0 ? 0 : sB > 255 ? 255 : sB;
    // alpha 透传（原图不透明，保持）
    rgba[i + 3] = rgba[i + 3];
  }

  return rgba;
}

module.exports = {
  COMPLIANCE_MODE,
  COMPLIANCE_MSG,
  BEAUTY_CATALOG,
  assertCompliance,
  applyBeauty,
  gaussianKernel,
  EDGE_TOL,
  WHITEN_K,
  UNSHARP_K,
};
