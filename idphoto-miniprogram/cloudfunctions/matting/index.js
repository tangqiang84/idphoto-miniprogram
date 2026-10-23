'use strict';
// 证件照上云增强云函数（CloudBase 原生，wx.cloud.callFunction 调用）
// 入参契约（与前端 src/core/mattingCloud.cloudMatting 一致）：
//   { region, purpose, retain, train, consent, width, height, image(base64 裁剪人像区域) }
// 返回：{ alphaB64, region }
// 合规：仅处理裁剪人像区域(非全图)、retain:false 处理完销毁、train:false 不留存、region 固定 CN（数据不出境）。
// 算法：当前为强抠图影子实现（多高斯+引导滤波保边，优于端侧单高斯基线）；
//       真 BiRefNet 经同契约替换即可（入参/出参不变）。

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
    alpha[i] = Math.max(0, Math.min(1, 1 - d / 75));
  }
  return alpha;
}
function estimateQuality(alpha) {
  let fg = 0, amb = 0; const n = alpha.length;
  for (let i = 0; i < n; i++) { if (alpha[i] >= 0.5) fg++; else if (alpha[i] > 0.1 && alpha[i] < 0.9) amb++; }
  return { foregroundRatio: fg / n, ambiguousRatio: amb / n, confidence: 1 - amb / n };
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function gaussianFromSamples(samples) {
  const mean = [0, 0, 0]; for (const s of samples) { mean[0] += s[0]; mean[1] += s[1]; mean[2] += s[2]; }
  const k = samples.length || 1; mean[0] /= k; mean[1] /= k; mean[2] /= k;
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const s of samples) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] += (s[a] - mean[a]) * (s[b] - mean[b]);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a][b] /= k;
  const det = cov[0][0] * (cov[1][1] * cov[2][2] - cov[1][2] * cov[2][1]) - cov[0][1] * (cov[1][0] * cov[2][2] - cov[1][2] * cov[2][0]) + cov[0][2] * (cov[1][0] * cov[2][1] - cov[1][1] * cov[2][0]) + 1e-6;
  const inv = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) inv[a][b] = cov[a][b] / det;
  return { mean, covInv: inv };
}
function mahalanobis(r, g, b, mean, covInv) {
  const d = [r - mean[0], g - mean[1], b - mean[2]];
  let s = 0; for (let a = 0; a < 3; a++) { let t = 0; for (let b = 0; b < 3; b++) t += d[b] * covInv[a][b]; s += d[a] * t; }
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

// ---------- 云函数入口 ----------
exports.main = async (event, context) => {
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
    const enhanced = strongSegment(rgba, w, h);
    return { alphaB64: encodeAlphaB64(enhanced), region: 'CN' };
  } catch (e) {
    return { error: String((e && e.message) || e), code: 500 };
  }
};
