'use strict';
// 抠图服务契约 + 路由判定
// 端侧真实能力见 src/core/mattingLocal.js（经典基线 / RMBG-1.4 接入契约）
// 上云增强：BiRefNet / RMBG-2.0（境内 GPU 云函数，处理完即销毁、不训练）
// 上云链路见 src/core/mattingCloud.js（裁剪上传 / 境内断言 / 单独授权 / 审计无像素）

const { localMatting, estimateQuality, collectEdgeSamples } = require('./mattingLocal');
const { cloudMatting } = require('./mattingCloud');

const CONF_THRESHOLD = 0.85; // 端侧置信度阈值，低于则触发上云增强

// 根据置信度决定处理路由
// forceCloud：调用方明确要求走云端（如质量评估判定「背景复杂」——**置信高 ≠ 质量好**，
//              端侧经典算法在复杂背景上可能"自信地抠错"，任务 #51）
function decideRoute(confidence, forceCloud = false) {
  if (forceCloud) return 'cloud';
  return confidence >= CONF_THRESHOLD ? 'edge' : 'cloud';
}

// 抠图入口：端侧优先；置信不足且注入上云能力时，真实调用上云增强并带降级
// input: { rgba, width, height, session?, cloud?, consents?, audit?, tool?, bgSamples? }
//   cloud   : { adapter } —— makeHttpAdapter / makeLocalBiRefStub（由调用方注入）
//   consents: 已授予授权项数组，须含 'faceCloudEnhance' 才允许上云(AC5)
//   audit   : 审计回调(stageMeta)，仅收元数据，无像素(AC8)
//   bgSamples: 背景色采样集（任务 #24）。经典基线的背景色由「画布四边」估计，
//              T1 自动裁剪把工作画布缩小到「裁剪窗+余量」后四边可能压在人体上，
//              故允许调用方在整图上先采一次注入。缺省不传 → 沿用四边采样（行为不变）。
async function segment({ rgba, width, height, session, cloud, consents, audit, tool, bgSamples, forceCloud } = {}) {
  if (!rgba || !width || !height) throw new Error('segment: 缺少 rgba/width/height');
  const res = await localMatting(rgba, width, height, { session, bgSamples });
  // 强制上云的前提：已注入上云能力 + 已授权 faceCloudEnhance（AC5）
  // 未授权时不强制（更不能因强制而抛 AC5 阻断用户），按原置信度路由
  const canForce =
    !!forceCloud &&
    !!cloud && !!cloud.adapter &&
    (consents || []).indexOf('faceCloudEnhance') >= 0;
  const route = decideRoute(res.quality.confidence, canForce);
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
    const msg = String((e && e.message) || e);
    if (msg.startsWith('AC5')) throw e;
    // ⚠️ 降级原因必须可见（任务 #52 教训 + 2026-10-27 真机排障）：
    //    静默降级会让「云端根本没调通」被误判成「效果就这样」——真机现场就是如此
    console.warn('[cloud-fallback]', msg);
    return { ...base, degraded: true, cloudError: msg };
  }
  if (cloudRes.degraded) {
    // #67：降级原因码必须透传到 UI，禁止一句「云端不可用」合并所有分支
    return { ...base, backend: cloudRes.backend, degraded: true, cloudMeta: cloudRes.cloudMeta, cloudError: cloudRes.reason || null };
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

// 透明底合成：保留 alpha 通道（PRD C3 透明底 PNG 导出）。
// 前景 RGB 保留原值，A 通道 = 抠图 alpha*255；背景区域 A=0（全透明）。
// 返回 RGBA（Uint8ClampedArray，长度 w*h*4），配合 canvasToTempFilePath fileType:'png' 使用。
function compositeTransparent(rgba, alpha, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = Math.max(0, Math.min(1, alpha[i]));
    out[i * 4] = rgba[i * 4];
    out[i * 4 + 1] = rgba[i * 4 + 1];
    out[i * 4 + 2] = rgba[i * 4 + 2];
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/** 后端名 → 用户可读标签（'classical'/'edge' → 端侧；'cloud' → 云端精修） */
function backendLabel(backend) {
  if (backend === 'cloud') return '云端精修';
  if (backend === 'classical' || backend === 'edge') return '端侧';
  return String(backend || '');
}

module.exports = {
  CONF_THRESHOLD, decideRoute, segment, composite, compositeTransparent, estimateQuality, localMatting,
  backendLabel,
  // 上云增强（来自 mattingCloud）
  cloudMatting,
  // 背景色采样（来自 mattingLocal，任务 #24 区域化裁剪用）
  collectEdgeSamples,
};
