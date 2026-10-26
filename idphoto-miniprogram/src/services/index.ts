// 业务服务聚合：复用 core 纯逻辑 + UI 层辅助
// core 为框架无关纯 JS，Taro(weapp) 与 Node 测试共用同一份实现。
import { getSpec, getPixelSize, listSpecs, BG, BG_LABELS, DPI_STD, DPI_HD, specLabel } from '../core/specLibrary';
import { check } from '../core/compliance';
import { decideRoute, CONF_THRESHOLD, segment, composite, compositeTransparent, cloudMatting, collectEdgeSamples } from '../core/matting';
import { makeHttpAdapter, makeLocalBiRefStub, assertDomestic, cropForeground, encodeAlphaB64, decodeAlphaB64 } from '../core/mattingCloud';
import { makeCloudFnAdapter } from './cloudFnAdapter';
import { requiredConsents, buildConsentRecord, CONSENT_ITEMS, TOOL_CONSENTS } from '../core/privacy';
import { alphaBBox, suitPlacement, suitCompose } from '../core/suit';
import { planOutput, planWindowOutput, planDetectImage, MIN_WORK_EDGE, MAX_WORK_EDGE, MAX_WORK_PIXELS, DETECT_EDGE, WIN_MARGIN_RATIO } from '../core/compose';
import { planHeadCrop, targetHeadRatio, HEAD_TOP_GAP_RATIO, CHIN_BOTTOM_GAP_RATIO } from '../core/headCrop';
import { detectFace, measureHeadRatio, measureHeadMetrics, ratioWithinWindow } from './faceService';
import { applyBeauty, COMPLIANCE_MODE, COMPLIANCE_MSG, BEAUTY_CATALOG, assertCompliance } from '../core/beauty';
import {
  EDGE_MODEL_CONFIG, configureEdgeModel, setOrtRuntime, getOrtRuntime,
  getEdgeSession, prepareModelForSegment, getModelStatus,
} from './modelService';

// ===== 上云增强：部署配置与 adapter 工厂 =====
// 部署时把 endpoint 改成你的【境内】GPU 云函数地址；trustedHosts 用于数据不出境白名单校验(fail-closed)。
// 路1（CloudBase 原生）走 buildCloudFnAdapter，不读此处 endpoint；路2（自有/HTTP）走 buildCloudAdapter。
export const CLOUD_CONFIG = {
  endpoint: 'https://cn-gpu-fn.your-domain.cn/matting', // 占位：路2 时替换为真实境内云函数地址
  trustedHosts: ['cn-gpu-fn.your-domain.cn'],
  region: 'CN',
};
// 路2（生产/HTTP）：真实上云（adapter 内部按运行环境选 wx.request / fetch）
export function buildCloudAdapter(overrides = {}) {
  return makeHttpAdapter({ ...CLOUD_CONFIG, ...overrides });
}
// 离线/PoC 用：本地 BiRefNet 影子实现，链路可跑通但非真模型
export function buildLocalStubAdapter(overrides = {}) {
  return makeLocalBiRefStub({ ...CLOUD_CONFIG, ...overrides });
}
// 路1（CloudBase 原生，已选）：基于 wx.cloud.callFunction 的 adapter，后台合法域名零配置
export function buildCloudFnAdapter(overrides = {}) {
  return makeCloudFnAdapter(overrides);
}

export {
  // 规格库
  getSpec, getPixelSize, listSpecs, BG, BG_LABELS, DPI_STD, DPI_HD, specLabel,
  // 合规引擎
  check,
  // 抠图
  decideRoute, CONF_THRESHOLD, segment, composite, compositeTransparent, cloudMatting, collectEdgeSamples,
  // 换装（T3 端侧贴图合成）
  alphaBBox, suitPlacement, suitCompose,
  // 输出构图规划（600dpi 动态工作图尺寸 + 裁剪窗口，三页共用）
  planOutput, MIN_WORK_EDGE, MAX_WORK_EDGE, MAX_WORK_PIXELS,
  // 自动裁剪（任务 #24：按规格头占比反解裁剪框 + 区域化工作画布 + 检测用图）
  planWindowOutput, planDetectImage, DETECT_EDGE, WIN_MARGIN_RATIO,
  planHeadCrop, targetHeadRatio, HEAD_TOP_GAP_RATIO, CHIN_BOTTOM_GAP_RATIO,
  // 人脸定位（任务 #4：VisionKit 优先 + faceDetect 降级，端侧完成）
  detectFace, measureHeadRatio, measureHeadMetrics, ratioWithinWindow,
  // 端侧真模型（任务 #3：权重管理 + session 加载 + 优雅降级；默认关闭，零回归）
  EDGE_MODEL_CONFIG, configureEdgeModel, setOrtRuntime, getOrtRuntime,
  getEdgeSession, prepareModelForSegment, getModelStatus,
  // 上云增强（CLOUD_CONFIG 与各 build*Adapter 已在上方 export const/function 直接导出，此处不重复导出）
  makeHttpAdapter, makeLocalBiRefStub, assertDomestic, cropForeground, encodeAlphaB64, decodeAlphaB64,
  // 隐私
  requiredConsents, buildConsentRecord, CONSENT_ITEMS, TOOL_CONSENTS,
  // 受限美颜（任务 #38 / PRD E 章 / AC2）
  applyBeauty, COMPLIANCE_MODE, COMPLIANCE_MSG, BEAUTY_CATALOG, assertCompliance,
};
