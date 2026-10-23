'use strict';
// 端侧抠图（本地优先）
//   - runClassicalFallback：真实可运行的经典算法（边界采样背景色 + 双边高斯模型 + 软 alpha + 羽化），
//     零依赖、任意环境可跑，作为端侧保底与 PoC 质量基线。
//   - runRealModel / preprocess：RMBG-1.4（onnxruntime）接入契约，设备侧部署权重后自动接管。
//   - estimateQuality：由 alpha 产出 confidence，喂给路由决策（歧义像素多 / 前景异常 → 置信低 → 上云增强）。

// 模型规格表（输入尺寸 / 归一化 / 输出后处理）—— 任务 #3 起由 core/mattingModel 统一声明，
// 避免把某个模型的参数硬编码进推理代码（详见 mattingModel.js 头注释）。
const mattingModel = require('./mattingModel');

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

// 采集画布四边 band 像素宽的环带，作为背景色估计样本。
// 抽出为独立函数的原因（任务 #24）：T1 自动裁剪会把工作画布缩到「裁剪窗 + 余量」，
// 此时画布四边不再是原图边缘（可能压在头发/肩膀上），
// 背景色估计会失准。故允许调用方在【整图】上先采一次，再用 bgSamples 注进来。
// 纯像素读取，可单测。
function collectEdgeSamples(rgba, w, h, band = 2) {
  const out = [];
  if (!(w > 0) || !(h > 0)) return out;
  const b = Math.max(1, Math.min(band, Math.floor(Math.min(w, h) / 2) || 1));
  for (let x = 0; x < w; x++) for (let k = 0; k < b; k++) {
    out.push(sampleRGB(rgba, x, k, w));
    out.push(sampleRGB(rgba, x, h - 1 - k, w));
  }
  for (let y = 0; y < h; y++) for (let k = 0; k < b; k++) {
    out.push(sampleRGB(rgba, k, y, w));
    out.push(sampleRGB(rgba, w - 1 - k, y, w));
  }
  return out;
}

// ===================== 经典本地抠图（真实算法） =====================
// 输入：rgba Uint8ClampedArray/Uint8Array（w*h*4）；输出：alpha Float32Array（0~1），长度 w*h
//
// 【bgSamples 注入】任务 #24：默认仍用本画布四边环带估计背景色（行为不变，T2/T3/T4 无回归）。
// 当工作画布被缩小到「裁剪窗 + 余量」（T1 自动裁剪）时，四边可能压在头发/肩膀上，
// 此时可由调用方在【整图】上 collectEdgeSamples 后注入，得到与整图抠图一致的背景色估计。
function runClassicalFallback(rgba, w, h, opts = {}) {
  const n = w * h;
  const alpha = new Float32Array(n);
  const bgSamples = (opts && Array.isArray(opts.bgSamples) && opts.bgSamples.length >= 3)
    ? opts.bgSamples
    : collectEdgeSamples(rgba, w, h, 2);
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

// ===================== 真模型推理（规格驱动，设备侧部署权重后启用） =====================
// 【2026-10-23 任务 #3 修正】原实现把「输入尺寸 1024 + ImageNet 归一化」写死，
// 那是按 RMBG-1.4 的规格写的。本项目已改用 MODNet（512 / 归一化到 [-1,1]），
// 沿用旧参数会让模型输出失真且不报错 —— 最难排查的那类 bug。
// 现改为从 core/mattingModel 的规格表取参数，模型自己声明输入尺寸与归一化方式。
//
// 预处理：resize 到 size×size + 按规格归一化 + HWC→CHW float32
function preprocess(rgba, w, h, spec) {
  return mattingModel.preprocess(rgba, w, h, spec);
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

// session：已加载的 onnxruntime InferenceSession（规格见 core/mattingModel）
// spec   ：模型规格对象（含 inputSize/normalize/output），不传时按 1024+ImageNet 兜底（旧行为）
//
// Tensor 构造器按运行时注入，源码内不做静态 require：
// 小程序端用 onnxruntime-web 的 session.env.Tensor，Node/PoC 端用 onnxruntime-node 的 ort.Tensor。
// 这样小程序打包链不会去解析 Node 原生依赖 onnxruntime-node（否则 webpack 编译失败），
// 也满足项目硬约束「禁止在项目内 npm install 新包」。
async function runRealModel(session, rgba, w, h, spec) {
  const s = mattingModel.normalizeSpec(spec) || mattingModel.normalizeSpec(1024);
  const size = s.inputSize;
  const input = preprocess(rgba, w, h, s);
  const OrtTensor = (session.env && session.env.Tensor) || session.Tensor;
  if (typeof OrtTensor !== 'function') {
    throw new Error('runRealModel: 需要注入 onnxruntime 的 Tensor 构造器（小程序端 session.env.Tensor / Node 端 ort.Tensor）');
  }
  const tensor = new OrtTensor('float32', input, [1, 3, size, size]);
  const feeds = {};
  // 输入名优先取规格声明（MODNet 导出常为 'input'），其次取 session 自报
  const inName = (spec && spec.inputName) || (session.inputNames && session.inputNames[0]);
  if (!inName) throw new Error('runRealModel: 无法确定模型输入名（spec.inputName 与 session.inputNames 均为空）');
  feeds[inName] = tensor;
  const out = await session.run(feeds);
  const outName = (session.outputNames && session.outputNames[0]);
  const raw = out[outName] ? out[outName].data : out[Object.keys(out)[0]].data;
  // 后处理：按规格把 logits / 显著图 / 已归一化的 matte 统一映射到 0~1，再 resize 回原尺寸
  return mattingModel.postprocess(raw, s, w, h);
}

// 端侧统一入口：有 session 走真实模型，否则走经典基线
// opts.bgSamples 透传给经典基线（任务 #24，缺省行为不变）
// opts.spec      模型规格（驱动输入尺寸/归一化/输出后处理）
//
// 【重要】真模型推理失败**不在此处吞掉**：上层（modelService.segmentWithModel）负责
// 捕获并降级到经典基线。理由：静默降级会让「模型坏了」表现为「抠图质量变差」，
// 用户和日志都看不到原因。降级必须是显式、可观测、有提示的决策。
async function localMatting(rgba, w, h, opts = {}) {
  let alpha, backend;
  if (opts.session) {
    alpha = await runRealModel(opts.session, rgba, w, h, opts.spec);
    backend = 'onnx:' + ((opts.spec && opts.spec.id) || 'unknown');
  } else {
    alpha = runClassicalFallback(rgba, w, h, { bgSamples: opts.bgSamples });
    backend = 'classical';
  }
  const quality = estimateQuality(alpha);
  return { alpha, quality, backend, width: w, height: h };
}

module.exports = {
  sigmoid, mat3Inv, gaussianFromSamples, mahalanobis, feather, sampleRGB,
  collectEdgeSamples,
  runClassicalFallback, estimateQuality, preprocess,
  resizeBilinear, resizeBilinearRGBA, runRealModel, localMatting,
};
