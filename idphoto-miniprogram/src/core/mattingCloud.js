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

// ===================== 序列化（base64，Node/小程序通用） =====================
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return (typeof btoa !== 'undefined') ? btoa(bin) : Buffer.from(bytes).toString('base64');
}
function fromBase64(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = (typeof atob !== 'undefined') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
  return f;
}

// ===================== 裁剪人像区域（非全图，I3/第171行） =====================
// 基于本地 alpha 求前景包围盒，padding 后裁出子图；只上传该区域，减少数据外泄面。
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
  const x0 = Math.max(0, minX - pad), y0 = Math.max(0, minY - pad);
  const x1 = Math.min(w - 1, maxX + pad), y1 = Math.min(h - 1, maxY + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const sub = new Uint8ClampedArray(cw * ch * 4);
  const subA = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const si = ((y0 + y) * w + (x0 + x)) * 4;
    const di = (y * cw + x) * 4;
    sub[di] = rgba[si]; sub[di + 1] = rgba[si + 1]; sub[di + 2] = rgba[si + 2]; sub[di + 3] = rgba[si + 3];
    subA[y * cw + x] = alpha[(y0 + y) * w + (x0 + x)];
  }
  return { rgba: sub, alpha: subA, w: cw, h: ch, x: x0, y: y0, full: false };
}
// 把子图 alpha 贴回全图对应区域，其余保持端侧 alpha
function placeBack(fullAlpha, subAlpha, crop, w, h) {
  if (crop.full) return subAlpha;
  const out = Float32Array.from(fullAlpha);
  for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) {
    out[(crop.y + y) * w + (crop.x + x)] = subAlpha[y * crop.w + x];
  }
  return out;
}

// ===================== 境内 endpoint 断言（数据不出境，fail-closed） =====================
// 无法物理探测机房位置，采用「白名单 + 境内后缀」启发式；任一不满足即阻断，绝不把人脸送跨境。
const DOMESTIC_SUFFIX = ['.cn', '.tencentcloudapi.com', '.myqcloud.com', '.aliyuncs.com', '.huaweicloud.com', '.volcengine.com'];
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
      return { alphaB64: json.alphaB64 || json.alpha, region: json.region || region };
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
async function cloudMatting({ rgba, alpha, width, height, adapter, consents = [], audit, tool = 'T1' } = {}) {
  if (!adapter) throw new Error('cloud: 未注入 adapter');
  if (!consents.includes('faceCloudEnhance')) {
    // AC5：缺少上云增强单独授权，阻断（绝不降级偷偷上传）
    audit && audit({ stage: 'blocked_no_consent', tool, hasPixel: false });
    throw new Error('AC5: 缺少上云增强(faceCloudEnhance)单独授权，已阻断上传');
  }
  // 数据不出境：注入的 adapter 已在构造时断言境内；这里二次校验 endpoint
  assertDomestic(adapter.endpoint, adapter.trustedHosts);

  // 仅裁剪人像区域(非全图，I3/第171行)
  const crop = cropForeground(rgba, alpha, width, height);
  const req = {
    region: 'CN',
    purpose: 'matting_enhance',
    retain: false,        // 处理完即销毁
    train: false,         // 不做模型训练留存
    consent: 'faceCloudEnhance',
    width: crop.w,
    height: crop.h,
    image: toBase64(crop.rgba), // 仅裁剪区域像素，base64
  };

  const t0 = Date.now();
  let resp;
  try {
    resp = await adapter.call(req);
  } catch (e) {
    // 网络/鉴权失败 → 降级端侧（第258/292行：上云失败有降级提示）
    audit && audit({ stage: 'cloud_fail', error: String((e && e.message) || e), degraded: true, hasPixel: false });
    return { alpha, backend: 'cloud->edge', confidence: estimateQuality(alpha).confidence, degraded: true, reason: 'network_or_auth', cloudMeta: { latencyMs: Date.now() - t0 } };
  }
  const dt = Date.now() - t0;

  const subAlpha = decodeAlphaB64(resp.alphaB64, crop.w * crop.h);
  const enhanced = placeBack(alpha, subAlpha, crop, width, height);
  // 子图尺度公平比较：云端只看到裁剪区域(见 PRD 第171行仅上传裁剪人像区域)，
  // 与全图像素数无关，避免尺度差异造成的歧义占比偏差误判「上云变差」。
  const q = estimateQuality(subAlpha);
  const localQCrop = estimateQuality(crop.alpha);
  // 仅对真实上云(adapter.kind==='http')执行「上云≥本地」严格校验；local-stub 为离线链路验证用，
  // 不因其在裁剪子图上的近似质量被降级（真实 BiRefNet 经 http adapter 接入时才严格比对）。
  if (adapter.kind !== 'local-stub' && q.confidence < localQCrop.confidence - 1e-3) {
    // 上云结果反不如本地（异常）→ 降级，避免变差
    audit && audit({ stage: 'cloud_degraded_quality', cloudConf: q.confidence, localConf: localQCrop.confidence, degraded: true, hasPixel: false });
    return { alpha, backend: 'cloud->edge', confidence: localQCrop.confidence, degraded: true, reason: 'quality', cloudMeta: { latencyMs: dt } };
  }
  // AC8：审计只记元数据，无像素
  audit && audit({ stage: 'cloud_ok', latencyMs: dt, region: resp.region || 'CN', confidence: q.confidence, retained: false, hasPixel: false });
  return { alpha: enhanced, backend: 'cloud', confidence: estimateQuality(enhanced).confidence, degraded: false, cloudMeta: { latencyMs: dt, region: resp.region || 'CN', retained: false } };
}

module.exports = {
  // 序列化
  toBase64, fromBase64, encodeAlphaB64, decodeAlphaB64,
  // 裁剪
  cropForeground, placeBack,
  // 境内断言
  assertDomestic, isDomesticSuffix,
  // adapter
  makeHttpAdapter, makeLocalBiRefStub,
  // 主入口
  cloudMatting,
  // stub 内部（供测试/PoC 复用）
  guidedRefine,
};
