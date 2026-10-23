'use strict';
// 证件照上云增强云函数（CloudBase 原生，wx.cloud.callFunction 调用）
// 入参契约（与前端 src/core/mattingCloud.cloudMatting 一致）：
//   { region, purpose, retain, train, consent, width, height, image(base64 裁剪人像区域) }
// 返回：{ alphaB64, region }
// 合规：仅处理裁剪人像区域(非全图)、retain:false 处理完销毁、train:false 不留存、region 固定 CN（数据不出境）。
//
// ⚠️⚠️ 算法：本文件支持**三条 provider**，入参/出参契约完全一致（RGBA 像素 → alphaB64）：
//
//    1) `baidu`  —— **百度智能云「人像分割」商用 API**（真模型，2026-10-23 接入）
//       实现见 ./baiduSeg.js；需配置云函数环境变量 BAIDU_API_KEY / BAIDU_SECRET_KEY。
//       取 scoremap（灰度=置信度×255）作软 alpha。免费额度：个人 1 万次/QPS 2，企业 5 万次/QPS 5。
//       **现在就是默认路径**：配了 Key 就走真模型，没配自动回落影子实现。
//
//    2) `shadow` —— 多高斯 + 引导滤波保边的 **CPU 影子实现**（本文件 strongSegment）。
//       为什么还要留：微信 CloudBase 云函数是 CPU 环境、无 GPU，且外部 API 有额度/网络风险，
//       影子实现保证「任何情况下都能出图」。百度失败时也一律降级到这里。
//
//    3) `birefnet` —— 自有境内 GPU 实例上的真 BiRefNet，见 **`部署/birefnet/`**
//       （server.py + Dockerfile + 部署手册，《小程序发布准备包》第八节「形态 B」）。
//       适合日调用量上万、想摆脱按次计费之后切换。
//
//    切换方式：环境变量（BAIDU_API_KEY / BAIDU_SECRET_KEY / BAIDU_ENABLED）或单次调用 event.provider。
//    为什么端侧抠图（core/mattingLocal + 端侧模型）仍然存在：端侧免费、离线可用，
//    本项目策略是「端侧优先，置信不足才上云」（core/matting.js decideRoute，阈值 0.85）。

const { resolveProvider, makeBaiduSegClient } = require('./baiduSeg');

// ---------- 基础序列化 ----------
function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}
function fromBase64(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}
function encodeAlphaB64(alpha) {
  const u = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < alpha.length; i++) u[i] = Math.round(Math.max(0, Math.min(1, alpha[i])) * 255);
  return toBase64(u);
}

// ---------- 端侧基线（与前端 mattingLocal 同源逻辑） ----------
function sampleRGB(rgba, x, y, w) { const i = (y * w + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; }
function runClassicalFallback(rgba, w, h) {
  const band = 2; const bg = [];
  for (let x = 0; x < w; x++) for (let b = 0; b < band; b++) { bg.push(sampleRGB(rgba, x, b, w)); bg.push(sampleRGB(rgba, x, h - 1 - b, w)); }
  for (let y = 0; y < h; y++) for (let b = 0; b < band; b++) { bg.push(sampleRGB(rgba, b, y, w)); bg.push(sampleRGB(rgba, w - 1 - b, y, w)); }
  let mr = 0, mg = 0, mb = 0; for (const c of bg) { mr += c[0]; mg += c[1]; mb += c[2]; }
  mr /= bg.length; mg /= bg.length; mb /= bg.length;
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const d = Math.hypot(r - mr, g - mg, b - mb);
    // ⚠️ 台账 #51：原写成 `1 - d/75` —— **方向反了**（离背景越远 alpha 越低）。
    // 后果不只是这张初始 mask 反了：`strongSegment` 用 `init > 0.9` 采样「前景」像素，
    // 取到的其实是**背景色**像素 → 前景/背景两个高斯塌成同一个 → 输出退化为全场恒值
    // （合成人像实测：整图 alpha 恒为 140、前景占比 100%），影子兜底等于失效。
    // 约定与前端 `core/mattingLocal.js` 一致：**alpha = 1 表示前景（离背景色越远越接近 1）**。
    alpha[i] = Math.max(0, Math.min(1, d / 75));
  }
  return alpha;
}
function estimateQuality(alpha) {
  let fg = 0, amb = 0; const n = alpha.length;
  for (let i = 0; i < n; i++) { if (alpha[i] >= 0.5) fg++; else if (alpha[i] > 0.1 && alpha[i] < 0.9) amb++; }
  return { foregroundRatio: fg / n, ambiguousRatio: amb / n, confidence: 1 - amb / n };
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
// ⚠️ 台账 #52：原实现用 `cov[a][b] / det` 冒充 3×3 矩阵求逆 —— **这不是逆矩阵**
// （真逆 = 伴随矩阵/det）。后果：纯色/低方差簇的协方差≈0 → det≈0 → inv≈0 →
// 所有像素到两个簇的马氏距离都≈0 → alpha 恒等于 sigmoid(0+0.1)≈0.52（实测整图恒值 140）。
// 现与前端 `core/mattingLocal.js` 的 mat3Inv 口径统一（含奇异矩阵对角加 eps 后重试）。
function mat3Inv(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  const det = a * A + b * B + c * C;
  if (!isFinite(det) || Math.abs(det) < 1e-8) {
    const eps = 1e-3; // 奇异 → 对角线加小量后重试（伪逆）
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
// covInv 为扁平 9 元素数组（与前端一致）
function mahalanobis(r, g, b, mean, covInv) {
  const d = [r - mean[0], g - mean[1], b - mean[2]];
  let s = 0;
  for (let a = 0; a < 3; a++) { let t = 0; for (let b2 = 0; b2 < 3; b2++) t += d[b2] * covInv[a * 3 + b2]; s += d[a] * t; }
  return s;
}
function dist2(a, b) { let s = 0; for (let k = 0; k < 3; k++) { const d = a[k] - b[k]; s += d * d; } return s; }
function kmeans2(samples, iters) {
  if (!samples.length) return [[0, 0, 0], [255, 255, 255]];
  let m1 = samples[0].slice(), m2 = samples[samples.length - 1].slice();
  for (let it = 0; it < iters; it++) {
    const c1 = [0, 0, 0], c2 = [0, 0, 0]; let n1 = 0, n2 = 0;
    for (const s of samples) { if (dist2(s, m1) <= dist2(s, m2)) { c1[0] += s[0]; c1[1] += s[1]; c1[2] += s[2]; n1++; } else { c2[0] += s[0]; c2[1] += s[1]; c2[2] += s[2]; n2++; } }
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
function boxFilter(src, w, h, r) {
  const W = w + 1; const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; I[(y + 1) * W + (x + 1)] = src[i] + I[y * W + (x + 1)] + I[(y + 1) * W + x] - I[y * W + x]; }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w - 1, x + r), y1 = Math.min(h - 1, y + r); const sum = I[(y1 + 1) * W + (x1 + 1)] - I[(y1 + 1) * W + x0] - I[y0 * W + (x1 + 1)] + I[y0 * W + x0]; out[y * w + x] = sum / ((x1 - x0 + 1) * (y1 - y0 + 1)); }
  return out;
}
function guidedRefine(rgba, alpha, w, h, r, eps) {
  const guide = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) guide[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  const meanG = boxFilter(guide, w, h, r);
  const meanA = boxFilter(alpha, w, h, r);
  const ga = new Float32Array(w * h); for (let i = 0; i < w * h; i++) ga[i] = guide[i] * alpha[i];
  const meanGA = boxFilter(ga, w, h, r);
  const gg = new Float32Array(w * h); for (let i = 0; i < w * h; i++) gg[i] = guide[i] * guide[i];
  const meanGG = boxFilter(gg, w, h, r);
  const varG = new Float32Array(w * h); for (let i = 0; i < w * h; i++) varG[i] = meanGG[i] - meanG[i] * meanG[i];
  const a = new Float32Array(w * h); const b = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { a[i] = (meanGA[i] - meanG[i] * meanA[i]) / (varG[i] + eps); b[i] = meanA[i] - a[i] * meanG[i]; }
  const meanA2 = boxFilter(a, w, h, r); const meanB2 = boxFilter(b, w, h, r);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = meanA2[i] * guide[i] + meanB2[i];
  for (let i = 0; i < w * h; i++) out[i] = 1 / (1 + Math.exp(-(out[i] - 0.5) * 8));
  return out;
}
// 云端更强模型代理：多高斯前景/背景建模 + 引导滤波保边（优于端侧单高斯基线）
function strongSegment(rgba, w, h) {
  const band = 2; const bg = [];
  for (let x = 0; x < w; x++) for (let b = 0; b < band; b++) { bg.push(sampleRGB(rgba, x, b, w)); bg.push(sampleRGB(rgba, x, h - 1 - b, w)); }
  for (let y = 0; y < h; y++) for (let b = 0; b < band; b++) { bg.push(sampleRGB(rgba, b, y, w)); bg.push(sampleRGB(rgba, w - 1 - b, y, w)); }
  const init = runClassicalFallback(rgba, w, h);
  const fg = []; for (let i = 0; i < w * h; i++) if (init[i] > 0.9) fg.push(sampleRGB(rgba, i % w, (i / w) | 0, w));
  const bgG = clusterGaussians(bg.length ? bg : [[0, 0, 0]]);
  const alpha = new Float32Array(w * h);
  if (!fg.length) return guidedRefine(rgba, init, w, h, 4, 1e-3);
  const fgG = clusterGaussians(fg);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    let dBg = Infinity, dFg = Infinity;
    for (const gx of bgG) { const d = mahalanobis(r, g, b, gx.mean, gx.covInv); if (d < dBg) dBg = d; }
    for (const gx of fgG) { const d = mahalanobis(r, g, b, gx.mean, gx.covInv); if (d < dFg) dFg = d; }
    alpha[i] = sigmoid((dBg - dFg) * 0.8 + 0.1);
  }
  const refined = guidedRefine(rgba, alpha, w, h, 4, 1e-3);
  const qRef = estimateQuality(refined); const qInit = estimateQuality(init);
  return qRef.confidence >= qInit.confidence - 1e-3 ? refined : init;
}

// ---------- provider 路由 ----------
// 两条实现，契约完全一致（入 RGBA 像素 → 出 alphaB64），可随时切换/回退：
//   1) 'baidu'  —— 百度智能云人像分割（真模型，需配置 BAIDU_API_KEY / BAIDU_SECRET_KEY）
//   2) 'shadow' —— 本地多高斯 + 引导滤波（CPU 影子实现，无外部依赖、永不失败）
// 选择逻辑：event.provider 显式指定 > 环境变量配置自动判定 > 影子兜底。
// 【铁律】百度这条路失败**一律降级影子实现**，绝不让用户拿不到图；降级原因随结果回传，便于排查。
function pickProvider(event, env) {
  const e = env || process.env;
  const forced = (event && event.provider) || '';
  if (forced === 'shadow') return { provider: 'shadow', reason: '调用方显式指定影子实现' };
  const enabled = String(e.BAIDU_ENABLED || 'true').toLowerCase() !== 'false';
  const plan = resolveProvider({
    apiKey: e.BAIDU_API_KEY || '',
    secretKey: e.BAIDU_SECRET_KEY || '',
    enabled,
  });
  if (forced === 'baidu' && plan.provider === 'shadow') {
    return { provider: 'shadow', reason: '调用方指定百度，但凭据未配置（' + plan.reason + '）' };
  }
  return plan;
}

// 百度 API 的输入尺寸边界（最短边 15px / 最长边 4096px）；越界没必要浪费一次调用
function baiduSizeOk(w, h) {
  const min = Math.min(w, h), max = Math.max(w, h);
  return min >= 15 && max <= 4096;
}

// ---------- 云函数主逻辑 ----------
// 抽成独立函数并支持注入 clientFactory：单测可在**不联网**的前提下覆盖
// 「百度成功 / 百度失败降级 / 未配置凭据」三条完整路径（项目约束：改完必实跑验证）。
async function handleMatting(event, opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const makeClient = o.clientFactory || ((cfg) => makeBaiduSegClient(cfg));
  // 合规闸门：仅处理裁剪后人像区域、境内、不留存
  if (event.consent !== 'faceCloudEnhance') {
    return { error: 'AC5: 缺少上云增强授权', code: 403 };
  }
  if (event.region !== 'CN') {
    return { error: '数据出境被拒绝', code: 451 };
  }
  try {
    const bytes = fromBase64(event.image);
    const rgba = new Uint8ClampedArray(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const w = event.width, h = event.height;

    // 【静默失败防线 —— 台账 #50】
    // 若 image 数据长度 < w*h*4（常见原因：云端测试面板里 image 填了 "<RGBA base64>" 之类的占位符、
    // 或前端裁剪窗口与像素数不匹配），后续所有像素读取都会越界返回 undefined → 运算得 NaN →
    // alpha **全 0 且不报错**，调用方拿到「成功」的空结果，排查成本极高。
    // 因此在解码图像之前就做尺寸自洽校验，明确报 400。
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      return { error: `尺寸参数非法：width=${w} height=${h}（须为正整数）`, code: 400 };
    }
    if (rgba.length < w * h * 4) {
      return {
        error: `图像数据与尺寸不匹配：收到 ${rgba.length} 字节，${w}×${h} 需要 ${w * h * 4} 字节（检查 image 是否为真实 RGBA base64，而非占位符）`,
        code: 400,
      };
    }

    const plan = pickProvider(event, env);
    if (plan.provider === 'baidu') {
      if (!baiduSizeOk(w, h)) {
        const enhanced = strongSegment(rgba, w, h);
        return {
          alphaB64: encodeAlphaB64(enhanced), region: 'CN',
          provider: 'shadow', providerMeta: { fallbackFrom: 'baidu', reason: `尺寸越界 ${w}x${h}（百度要求最短边≥15、最长边≤4096）` },
        };
      }
      try {
        const client = makeClient({
          apiKey: env.BAIDU_API_KEY,
          secretKey: env.BAIDU_SECRET_KEY,
        });
        const r = await client.segment(rgba, w, h);
        return {
          alphaB64: encodeAlphaB64(r.alpha), region: 'CN',
          provider: 'baidu',
          providerMeta: { ...r.meta, host: client.host },
        };
      } catch (e) {
        // 降级：绝不让上云失败导致无图。日志只记错误码与原因，不记任何像素（AC8）
        const reason = String((e && e.message) || e);
        console.warn('[matting] baidu 失败，降级影子实现：' + reason);
        const enhanced = strongSegment(rgba, w, h);
        return {
          alphaB64: encodeAlphaB64(enhanced), region: 'CN',
          provider: 'shadow',
          providerMeta: {
            fallbackFrom: 'baidu', reason,
            code: e && e.code != null ? e.code : null,
            retryable: !!(e && e.retryable),
          },
        };
      }
    }

    const enhanced = strongSegment(rgba, w, h);
    return {
      alphaB64: encodeAlphaB64(enhanced), region: 'CN',
      provider: 'shadow', providerMeta: { reason: plan.reason },
    };
  } catch (e) {
    return { error: String((e && e.message) || e), code: 500 };
  }
}

// ---------- 云函数入口 ----------
exports.main = async (event, context) => handleMatting(event || {}, {});
// 供单测注入（不联网覆盖全路径）；云函数运行时不会用到
exports.handleMatting = handleMatting;
exports.pickProvider = pickProvider;
