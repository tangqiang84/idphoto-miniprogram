'use strict';
// 抠图服务契约 + 路由判定
// 端侧真实能力见 src/core/mattingLocal.js（经典基线 / RMBG-1.4 接入契约）
// 上云增强：BiRefNet / RMBG-2.0（境内 GPU 云函数，处理完即销毁、不训练）
// 上云链路见 src/core/mattingCloud.js（裁剪上传 / 境内断言 / 单独授权 / 审计无像素）

const { localMatting, estimateQuality } = require('./mattingLocal');
const { cloudMatting } = require('./mattingCloud');

const CONF_THRESHOLD = 0.85; // 端侧置信度阈值，低于则触发上云增强

// 根据置信度决定处理路由
function decideRoute(confidence) {
  return confidence >= CONF_THRESHOLD ? 'edge' : 'cloud';
}

// 抠图入口：端侧优先；置信不足且注入上云能力时，真实调用上云增强并带降级
// input: { rgba, width, height, session?, cloud?, consents?, audit?, tool? }
//   cloud   : { adapter } —— makeHttpAdapter / makeLocalBiRefStub（由调用方注入）
//   consents: 已授予授权项数组，须含 'faceCloudEnhance' 才允许上云(AC5)
//   audit   : 审计回调(stageMeta)，仅收元数据，无像素(AC8)
async function segment({ rgba, width, height, session, cloud, consents, audit, tool } = {}) {
  if (!rgba || !width || !height) throw new Error('segment: 缺少 rgba/width/height');
  const res = await localMatting(rgba, width, height, { session });
  const route = decideRoute(res.quality.confidence);
  const base = {
    width, height,
    maskSize: width * height,
    confidence: res.quality.confidence,
    ambiguousRatio: res.quality.ambiguousRatio,
    foregroundRatio: res.quality.foregroundRatio,
    backend: res.backend,
    route,
    alpha: res.alpha,
  };

  // 端侧已足够（置信≥阈值），或未注入上云能力 → 直接返回端侧结果
  if (route === 'edge' || !cloud || !cloud.adapter) return base;

  // 路由上云增强
  let cloudRes;
  try {
    cloudRes = await cloudMatting({
      rgba, alpha: res.alpha, width, height,
      adapter: cloud.adapter,
      consents: consents || [],
      audit, tool,
    });
  } catch (e) {
    // AC5 未授权等硬阻断：上抛，由调用方提示用户去授权（绝不以端侧静默替代授权）
    if (String(e && e.message || e).startsWith('AC5')) throw e;
    return { ...base, degraded: true, cloudError: String(e && e.message || e) };
  }
  if (cloudRes.degraded) {
    return { ...base, backend: cloudRes.backend, degraded: true, cloudMeta: cloudRes.cloudMeta };
  }
  return { ...base, backend: 'cloud', alpha: cloudRes.alpha, confidence: cloudRes.confidence, degraded: false, cloudMeta: cloudRes.cloudMeta };
}

// 用 alpha 合成纯色背景；返回合成后 RGBA（Uint8ClampedArray，长度 w*h*4）
function composite(rgba, alpha, width, height, bgHex) {
  const s = (bgHex || '#ffffff').replace('#', '');
  const br = parseInt(s.slice(0, 2), 16);
  const bg = parseInt(s.slice(2, 4), 16);
  const bb = parseInt(s.slice(4, 6), 16);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = Math.max(0, Math.min(1, alpha[i]));
    out[i * 4] = rgba[i * 4] * a + br * (1 - a);
    out[i * 4 + 1] = rgba[i * 4 + 1] * a + bg * (1 - a);
    out[i * 4 + 2] = rgba[i * 4 + 2] * a + bb * (1 - a);
    out[i * 4 + 3] = 255;
  }
  return out;
}

module.exports = {
  CONF_THRESHOLD, decideRoute, segment, composite, estimateQuality, localMatting,
  // 上云增强（来自 mattingCloud）
  cloudMatting,
};
