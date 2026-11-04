"""RC-09模型接线和可观测来源修改留存；不重复执行。"""
from pathlib import Path
r=Path(__file__).resolve().parents[2]
p=r/'idphoto-miniprogram/src/core/matting.js';s=p.read_text().replace("const CONF_THRESHOLD =", "const { withTimeout } = require('./asyncUtils');\nconst { mattingEvidence, failureCode } = require('./mattingEvidence');\n\nconst CONF_THRESHOLD =")
a=s.index('async function segment(');b=s.index('// 用 alpha 合成背景',a)
s=s[:a]+'''async function segment({ rgba, width, height, session, spec, modelInfo, cloud, consents, audit, tool, bgSamples, forceCloud, modelTimeoutMs = 15000 } = {}) {
  if (!rgba || !width || !height) throw new Error('segment: 缺少 rgba/width/height');
  const start = Date.now();
  const reasons = modelInfo?.reasonCode ? [modelInfo.reasonCode] : [];
  let res;
  try {
    res = await withTimeout(localMatting(rgba, width, height, { session, spec, bgSamples }), modelTimeoutMs, 'MODEL_INFERENCE_TIMEOUT');
    if (res.alpha.length !== width * height || res.alpha.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('MODEL_ALPHA_INVALID');
  } catch (error) {
    if (!session) throw error;
    reasons.push(/TIMEOUT/.test(String(error?.message || '')) ? 'MODEL_INFERENCE_TIMEOUT' : 'MODEL_INFERENCE_FAILED');
    res = await localMatting(rgba, width, height, { bgSamples });
  }
  const canForce = !!forceCloud && !!cloud?.adapter && (consents || []).includes('faceCloudEnhance');
  const route = decideRoute(res.quality.confidence, canForce);
  const base = { width, height, maskSize: width * height, confidence: res.quality.confidence,
    ambiguousRatio: res.quality.ambiguousRatio, foregroundRatio: res.quality.foregroundRatio,
    backend: res.backend, route, alpha: res.alpha };
  const finish = (result, cloudAttempted = false) => {
    const backend = result.backend === 'cloud->edge' ? res.backend : result.backend;
    const evidence = mattingEvidence({ backend, provider: result.cloudMeta?.provider,
      adapterKind: cloud?.adapter?.kind, modelId: backend.startsWith('onnx:') ? spec?.id : null,
      modelRevision: backend.startsWith('onnx:') ? modelInfo?.modelRevision : result.cloudMeta?.providerMeta?.version,
      inputSize: spec?.inputSize, reasonCodes: [...reasons, ...(result.reasonCode ? [result.reasonCode] : [])],
      cloudAttempted, latencyMs: Date.now() - start, cloudLatencyMs: result.cloudMeta?.latencyMs });
    return { ...result, evidence, degraded: !!result.degraded || reasons.some((x) => x !== 'MODEL_DISABLED'),
      reasonCodes: evidence.reasonCodes, qualityReviewed: false };
  };
  if (route === 'edge') return finish(base);
  if (!(consents || []).includes('faceCloudEnhance')) return finish({ ...base, degraded: true, cloudError: 'cloud_consent_missing', reasonCode: 'CLOUD_CONSENT_MISSING' });
  if (!cloud?.adapter) return finish({ ...base, degraded: true, cloudError: 'cloud_unavailable', reasonCode: 'CLOUD_UNAVAILABLE' });
  let cloudRes;
  try { cloudRes = await cloudMatting({ rgba, alpha: res.alpha, width, height, adapter: cloud.adapter, consents: consents || [], audit, tool }); }
  catch (error) {
    if (String(error?.message || '').startsWith('AC5')) throw error;
    const code = failureCode(error);
    audit?.({ stage: 'cloud_fallback', code, hasPixel: false });
    return finish({ ...base, degraded: true, cloudError: code, reasonCode: code }, true);
  }
  if (cloudRes.degraded) return finish({ ...base, backend: cloudRes.backend, degraded: true,
    cloudMeta: cloudRes.cloudMeta, cloudError: cloudRes.reason || null, reasonCode: cloudRes.reasonCode || 'CLOUD_RESULT_REJECTED' }, true);
  return finish({ ...base, backend: 'cloud', alpha: cloudRes.alpha, confidence: cloudRes.confidence,
    cloudMeta: cloudRes.cloudMeta, degraded: cloudRes.cloudMeta?.provider === 'shadow' || cloud?.adapter?.kind === 'local-stub' }, true);
}

''' + s[b:]
s=s.replace("if (backend === 'cloud') return '云端精修';", "if (backend === 'cloud') return '云端来源待核验';").replace("if (backend === 'classical' || backend === 'edge') return '端侧';", "if (backend === 'classical' || backend === 'edge') return '本地传统算法（非AI模型）';")
p.write_text(s)
p=r/'idphoto-miniprogram/src/core/mattingCloud.js';s=p.read_text();needle="const {";idx=s.find(needle)
s="const { failureCode } = require('./mattingEvidence');\n"+s
s=s.replace("error: String((e && e.message) || e),", "code: failureCode(e),")
s=s.replace("reason: 'network_or_auth', cloudMeta:", "reason: 'network_or_auth', reasonCode: failureCode(e), cloudMeta:")
p.write_text(s)
p=r/'idphoto-miniprogram/src/services/t1Processing.ts';s=p.read_text().replace("import { prepareWorkCanvas } from './pipeline';", "import { prepareWorkCanvas } from './pipeline';\nimport { prepareModelForSegment } from './modelService';")
s=s.replace("      const seg: any = await task.call(() => segment({ rgba, width: w, height: h, bgSamples: prepared.bgSamples,", "      const model = await task.call(() => prepareModelForSegment({ check: () => task.check() }));\n      const seg: any = await task.call(() => segment({ rgba, width: w, height: h, bgSamples: prepared.bgSamples,\n        session: model.session, spec: model.spec, modelInfo: model,")
s=s.replace("backend: backendLabel(seg.backend), degraded: !!seg.degraded", "backend: seg.evidence?.label || backendLabel(seg.backend), mattingEvidence: seg.evidence, degraded: !!seg.degraded")
s=s.replace('suitReason: data.suitReason, backend: data.backend, degraded:', 'suitReason: data.suitReason, backend: data.backend, mattingEvidence: data.mattingEvidence, degraded:')
p.write_text(s)
p=r/'工具链/page_flow_probe.js';s=p.read_text().replace("      if (request === './exportInspection'", "      if (request === './modelService') return load(path.resolve(ROOT, 'idphoto-miniprogram/src/services/modelService.ts'));\n      if (request === './exportInspection'")
p.write_text(s)
