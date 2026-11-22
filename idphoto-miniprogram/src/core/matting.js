'use strict';
// 抠图服务契约 + 路由判定
// 端侧由平台注入固定模型；默认使用传统算法，不等同于真实模型验收
// 上云按provider区分模型自报、传统算法与模拟；境内/数据承诺另需部署证据
// 上云链路见 src/core/mattingCloud.js（裁剪上传 / 境内断言 / 单独授权 / 审计无像素）

const { localMatting, estimateQuality, collectEdgeSamples } = require('./mattingLocal');
const { cloudMatting } = require('./mattingCloud');
const { resolveBackground, sampleGradient } = require('./color');

const { withTimeout } = require('./asyncUtils');
const { mattingEvidence, failureCode } = require('./mattingEvidence');

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
/** @param {any} input */
async function segment(input = {}) {
  const { rgba, width, height, session, spec, modelInfo, cloud, consents, audit, tool, bgSamples, forceCloud, modelTimeoutMs = 15000 } = input;
  if (!rgba || !width || !height) throw new Error('segment: 缺少 rgba/width/height');
  input.check?.();
  const start = Date.now();
  const reasons = modelInfo?.reasonCode ? [modelInfo.reasonCode] : [];
  let res;
  try {
    res = await withTimeout(localMatting(rgba, width, height, { session, spec, bgSamples, cooperative: !!input.check, check: input.check }), modelTimeoutMs, 'MODEL_INFERENCE_TIMEOUT');
    if (res.alpha.length !== width * height || res.alpha.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('MODEL_ALPHA_INVALID');
  } catch (error) {
    if (!session) throw error;
    reasons.push(/TIMEOUT/.test(String(error?.message || '')) ? 'MODEL_INFERENCE_TIMEOUT' : 'MODEL_INFERENCE_FAILED');
    audit?.({ stage: 'model_fallback', code: reasons[reasons.length - 1], hasPixel: false });
    input.check?.();
    res = await localMatting(rgba, width, height, { bgSamples, cooperative: !!input.check, check: input.check });
  }
  input.check?.();
  const canForce = !!forceCloud && !!cloud?.adapter && (consents || []).includes('faceCloudEnhance');
  const route = decideRoute(res.quality.confidence, canForce);
  const base = { width, height, maskSize: width * height, confidence: res.quality.confidence,
    ambiguousRatio: res.quality.ambiguousRatio, foregroundRatio: res.quality.foregroundRatio,
    backend: res.backend, route, alpha: res.alpha };
  const finish = (result, cloudAttempted = false) => {
    const backend = result.backend === 'cloud->edge' ? res.backend : result.backend;
    if (result.cloudMeta?.provider === 'shadow' && result.cloudMeta?.providerMeta?.fallbackFrom) reasons.push(failureCode({ code: result.cloudMeta.providerMeta.code }));
    const evidence = mattingEvidence({ backend, provider: backend === 'cloud' ? result.cloudMeta?.provider : null,
      adapterKind: cloud?.adapter?.kind, modelId: backend.startsWith('onnx:') ? spec?.id : null,
      modelRevision: backend.startsWith('onnx:') ? modelInfo?.modelRevision : result.cloudMeta?.providerMeta?.version,
      artifactSha256: backend.startsWith('onnx:') ? spec?.sha256 : null,
      inputSize: spec?.inputSize, reasonCodes: [...reasons, ...(result.reasonCode ? [result.reasonCode] : [])],
      initializationMs: modelInfo?.initializationMs, cloudAttempted, latencyMs: Date.now() - start, cloudLatencyMs: result.cloudMeta?.latencyMs });
    return { ...result, evidence, degraded: !!result.degraded || reasons.some((x) => x !== 'MODEL_DISABLED'),
      reasonCodes: evidence.reasonCodes, qualityReviewed: false };
  };
  if (route === 'edge') return finish(base);
  if (!(consents || []).includes('faceCloudEnhance')) return finish({ ...base, degraded: true, cloudError: 'cloud_consent_missing', reasonCode: 'CLOUD_CONSENT_MISSING' });
  if (!cloud?.adapter) return finish({ ...base, degraded: true, cloudError: 'cloud_unavailable', reasonCode: 'CLOUD_UNAVAILABLE' });
  let cloudRes;
  try { cloudRes = await cloudMatting({ rgba, alpha: res.alpha, width, height, adapter: cloud.adapter, consents: consents || [], audit, tool, check: input.check }); input.check?.(); }
  catch (error) {
    input.check?.();
    if (/^(CONSENT_|SESSION_)/.test(String(error?.code || '')) || String(error?.message || '').startsWith('AC5')) throw error;
    const code = failureCode(error);
    audit?.({ stage: 'cloud_fallback', code, hasPixel: false });
    return finish({ ...base, degraded: true, cloudError: code, reasonCode: code }, true);
  }
  if (cloudRes.degraded) return finish({ ...base, backend: cloudRes.backend, degraded: true,
    cloudMeta: cloudRes.cloudMeta, cloudError: cloudRes.reason || null, reasonCode: cloudRes.reasonCode || 'CLOUD_RESULT_REJECTED' }, true);
  return finish({ ...base, backend: 'cloud', alpha: cloudRes.alpha, confidence: cloudRes.confidence,
    cloudMeta: cloudRes.cloudMeta, degraded: cloudRes.cloudMeta?.provider === 'shadow' || cloud?.adapter?.kind === 'local-stub' }, true);
}

// 用 alpha 合成背景；返回合成后 RGBA（Uint8ClampedArray，长度 w*h*4）
//
// 【2026-10-28 渐变底支持】bgHex 现在接受三种形态（core/color.js 的 resolveBackground 归一化）：
//   · null / undefined → 纯白（既有行为，零回归）
//   · string（HEX）    → 纯色（既有行为，零回归）
//   · {type:'gradient', from, to, angle} → 线性渐变（新增）
// 形态由 resolveBackground 统一解析，非法输入一律回落到白色（不抛，避免打断导出链路）。
function composite(rgba, alpha, width, height, bgHex) {
  const bg = resolveBackground(bgHex == null ? '#ffffff' : bgHex);
  const out = new Uint8ClampedArray(width * height * 4);
  if (bg.type === 'gradient') {
    // 渐变：逐像素取色（背景色随位置变化，前景仍按 alpha 混合）
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const c = sampleGradient(bg, x, y, width, height);
        const a = Math.max(0, Math.min(1, alpha[i]));
        out[i * 4] = rgba[i * 4] * a + c[0] * (1 - a);
        out[i * 4 + 1] = rgba[i * 4 + 1] * a + c[1] * (1 - a);
        out[i * 4 + 2] = rgba[i * 4 + 2] * a + c[2] * (1 - a);
        out[i * 4 + 3] = 255;
      }
    }
    return out;
  }
  const br = bg.rgb ? bg.rgb[0] : 255;
  const bg2 = bg.rgb ? bg.rgb[1] : 255;
  const bb = bg.rgb ? bg.rgb[2] : 255;
  for (let i = 0; i < width * height; i++) {
    const a = Math.max(0, Math.min(1, alpha[i]));
    out[i * 4] = rgba[i * 4] * a + br * (1 - a);
    out[i * 4 + 1] = rgba[i * 4 + 1] * a + bg2 * (1 - a);
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
  if (backend === 'cloud') return '云端来源待核验';
  if (backend === 'classical' || backend === 'edge') return '本地传统算法（非AI模型）';
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
