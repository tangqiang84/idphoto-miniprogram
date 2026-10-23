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
//   ② 偏移检测：与本地前景占比差 >0.25 → 两者分歧过大，判失败（保守起见退回本地）
//   ③ 其余情况接受真模型结果（软 alpha 的「歧义多」是优点不是缺点）
// 非真模型（local-stub 离线验证用）维持原豁免；未知 provider 维持原 confidence 比较。
function shouldAcceptCloudAlpha({ cloudAlpha, localAlpha, provider } = {}) {
  const qc = estimateQuality(cloudAlpha);
  const ql = estimateQuality(localAlpha);
  const meta = { cloudConf: qc.confidence, localConf: ql.confidence, cloudFg: qc.foregroundRatio, localFg: ql.foregroundRatio };
  if (provider === 'local-stub') return { accept: true, reason: 'local-stub 离线链路，豁免比对', ...meta };
  if (qc.foregroundRatio < 0.005 || qc.foregroundRatio > 0.995) {
    return { accept: false, reason: 'cloud_foreground_degenerate', ...meta };
  }
  if (provider === 'baidu' || provider === 'birefnet') {
    if (Math.abs(qc.foregroundRatio - ql.foregroundRatio) > 0.25) {
      return { accept: false, reason: 'cloud_foreground_shift', ...meta };
    }
    return { accept: true, reason: 'real_model_soft_alpha', ...meta };
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
    audit && audit({ stage: 'cloud_fail', error: String((e && e.message) || e), degraded: true, hasPixel: false });
    return { alpha, backend: 'cloud->edge', confidence: estimateQuality(alpha).confidence, degraded: true, reason: 'network_or_auth', cloudMeta: { latencyMs: Date.now() - t0 } };
  }
  const dt = Date.now() - t0;

  const subAlphaRaw = decodeAlphaB64(resp.alphaB64, upW * upH);
  // 若上传时降采样过，把 alpha 双线性放大回裁剪区原始尺寸再贴回全图
  const subAlpha = downSampled
    ? upscaleAlpha(subAlphaRaw, upW, upH, crop.w, crop.h)
    : subAlphaRaw;
  const enhanced = placeBack(alpha, subAlpha, crop, width, height);
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
  cropForeground, placeBack,
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
