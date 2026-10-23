'use strict';
// 端侧抠图（本地优先）
//   - runClassicalFallback：真实可运行的经典算法（边界采样背景色 + 双边高斯模型 + 软 alpha + 羽化），
//     零依赖、任意环境可跑，作为端侧保底与 PoC 质量基线。
//   - runRealModel / preprocess：RMBG-1.4（onnxruntime）接入契约，设备侧部署权重后自动接管。
//   - estimateQuality：由 alpha 产出 confidence，喂给路由决策（歧义像素多 / 前景异常 → 置信低 → 上云增强）。

// ===================== 数学工具 =====================
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function mat3Inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  let det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-8) {
    const eps = 1e-3; // 奇异→加小量伪逆
    return mat3Inv([a + eps, b, c, d, e + eps, f, g, h, i + eps]);
  }
  const id = 1 / det;
  return [A * id, B * id, C * id, D * id, E * id, F * id, G * id, H * id, I * id];
}

function gaussianFromSamples(samples) {
  const k = samples.length || 1;
  const mean = [0, 0, 0];
  for (const s of samples) { mean[0] += s[0]; mean[1] += s[1]; mean[2] += s[2]; }
  mean[0] /= k; mean[1] /= k; mean[2] /= k;
  const cov = new Array(9).fill(0);
  for (const s of samples) {
    const dx = s[0] - mean[0], dy = s[1] - mean[1], dz = s[2] - mean[2];
    cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz;
    cov[3] += dy * dx; cov[4] += dy * dy; cov[5] += dy * dz;
    cov[6] += dz * dx; cov[7] += dz * dy; cov[8] += dz * dz;
  }
  for (let i = 0; i < 9; i++) cov[i] /= k;
  return { mean, covInv: mat3Inv(cov) };
}

function mahalanobis(r, g, b, mean, covInv) {
  const x0 = r - mean[0], x1 = g - mean[1], x2 = b - mean[2];
  const d = x0 * (covInv[0] * x0 + covInv[1] * x1 + covInv[2] * x2)
    + x1 * (covInv[3] * x0 + covInv[4] * x1 + covInv[5] * x2)
    + x2 * (covInv[6] * x0 + covInv[7] * x1 + covInv[8] * x2);
  return Math.sqrt(Math.max(0, d));
}

function feather(alpha, w, h, radius) {
  const out = new Float32Array(alpha.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0, cnt = 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      acc += alpha[yy * w + xx]; cnt++;
    }
    out[y * w + x] = cnt ? acc / cnt : 0;
  }
  alpha.set(out);
}

function sampleRGB(rgba, x, y, w) {
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2]];
}

// ===================== 经典本地抠图（真实算法） =====================
// 输入：rgba Uint8ClampedArray/Uint8Array（w*h*4）；输出：alpha Float32Array（0~1），长度 w*h
function runClassicalFallback(rgba, w, h) {
  const n = w * h;
  const alpha = new Float32Array(n);
  const band = 2;
  const bgSamples = [];
  for (let x = 0; x < w; x++) for (let b = 0; b < band; b++) {
    bgSamples.push(sampleRGB(rgba, x, b, w));
    bgSamples.push(sampleRGB(rgba, x, h - 1 - b, w));
  }
  for (let y = 0; y < h; y++) for (let b = 0; b < band; b++) {
    bgSamples.push(sampleRGB(rgba, b, y, w));
    bgSamples.push(sampleRGB(rgba, w - 1 - b, y, w));
  }
  const bg = gaussianFromSamples(bgSamples);
  const fgSamples = [];
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const d = mahalanobis(r, g, b, bg.mean, bg.covInv);
    const a = sigmoid((d - 2.0) * 1.2);
    alpha[i] = a;
    if (a > 0.7) fgSamples.push([r, g, b]);
  }
  if (fgSamples.length > 0) {
    const fg = gaussianFromSamples(fgSamples);
    for (let i = 0; i < n; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      const dFg = mahalanobis(r, g, b, fg.mean, fg.covInv);
      const dBg = mahalanobis(r, g, b, bg.mean, bg.covInv);
      // 近前景(dFg小)、远背景(dBg大) → 高 alpha；符号修正避免反转
      alpha[i] = sigmoid((dBg - dFg) * 0.8 + 0.2);
    }
  }
  feather(alpha, w, h, 1);
  return alpha;
}

// ===================== 质量评估（输出 confidence 喂路由） =====================
function estimateQuality(alphaFlat) {
  const n = alphaFlat.length || 1;
  let ambiguous = 0, fg = 0;
  for (let i = 0; i < alphaFlat.length; i++) {
    const a = alphaFlat[i];
    if (a > 0.2 && a < 0.8) ambiguous++;
    if (a >= 0.5) fg++;
  }
  const ambiguousRatio = ambiguous / n;
  const foregroundRatio = fg / n;
  const fgAnomaly = foregroundRatio < 0.05 || foregroundRatio > 0.95;
  let confidence = 1 - ambiguousRatio;
  if (fgAnomaly) confidence *= 0.6; // 几乎全前景/全背景 → 可能误判
  confidence = Math.max(0, Math.min(1, confidence));
  return { confidence, ambiguousRatio, foregroundRatio, fgAnomaly };
}

// ===================== RMBG-1.4 接入契约（设备侧部署后启用） =====================
// 预处理：resize 到 size×size + ImageNet 归一化 + HWC→CHW float32
function preprocess(rgba, w, h, size) {
  const src = resizeBilinearRGBA(rgba, w, h, size, size);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const out = new Float32Array(3 * size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const si = (y * size + x) * 4;
    out[(0 * size + y) * size + x] = (src[si] / 255 - mean[0]) / std[0];
    out[(1 * size + y) * size + x] = (src[si + 1] / 255 - mean[1]) / std[1];
    out[(2 * size + y) * size + x] = (src[si + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

function resizeBilinearRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * sy, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * sx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c];
        const cc = src[(y1 * sw + x0) * 4 + c], d = src[(y1 * sw + x1) * 4 + c];
        out[(y * dw + x) * 4 + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return out;
}

function resizeBilinear(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * sy, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * sx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

// session：已加载的 onnxruntime InferenceSession（RMBG-1.4）
// 约定：输入 [1,3,1024,1024] float32（本 preprocess 产出），输出 [1,1,1024,1024] 0~1 alpha
async function runRealModel(session, rgba, w, h, size = 1024) {
  const input = preprocess(rgba, w, h, size);
  // Tensor 构造器按运行时注入，源码内不做静态 require：
  // 小程序端用 onnxruntime-web 的 session.env.Tensor，Node/PoC 端用 onnxruntime-node 的 ort.Tensor。
  // 这样小程序打包链不会去解析 Node 原生依赖 onnxruntime-node（否则 webpack 编译失败）。
  const OrtTensor = (session.env && session.env.Tensor) || session.Tensor;
  if (typeof OrtTensor !== 'function') {
    throw new Error('runRealModel: 需要注入 onnxruntime 的 Tensor 构造器（小程序端 session.env.Tensor / Node 端 ort.Tensor）');
  }
  const tensor = new OrtTensor('float32', input, [1, 3, size, size]);
  const feeds = {};
  feeds[session.inputNames[0]] = tensor;
  const out = await session.run(feeds);
  const raw = out[session.outputNames[0]].data; // [1,1,1024,1024]
  return resizeBilinear(raw, size, size, w, h);
}

// 端侧统一入口：有 session 走真实模型，否则走经典基线
async function localMatting(rgba, w, h, opts = {}) {
  let alpha, backend;
  if (opts.session) {
    alpha = await runRealModel(opts.session, rgba, w, h, opts.size || 1024);
    backend = 'rmbg-1.4';
  } else {
    alpha = runClassicalFallback(rgba, w, h);
    backend = 'classical';
  }
  const quality = estimateQuality(alpha);
  return { alpha, quality, backend, width: w, height: h };
}

module.exports = {
  sigmoid, mat3Inv, gaussianFromSamples, mahalanobis, feather, sampleRGB,
  runClassicalFallback, estimateQuality, preprocess,
  resizeBilinear, resizeBilinearRGBA, runRealModel, localMatting,
};
