// 隐私同意契约（个保法敏感个人信息·单独同意）
// 不同工具触发不同授权项；换装须独立单独授权。

const CLOUD_MATTING_DESCRIPTION = '可选：将裁剪后的人像区域发送至腾讯云 CloudBase。抠图增强可调用百度智能云人像分割。';
const CONSENT_ITEMS = {
  faceLocal: { id: 'faceLocal', label: '人脸本地处理', desc: '仅在设备端抠图，不上传', required: true },
  faceCloudEnhance: {
    id: 'faceCloudEnhance',
    label: '上云增强',
    desc: CLOUD_MATTING_DESCRIPTION + '已另行同意换装时，云端会识别人脸关键点、双肩、原衣与领口，双肩识别可调用百度智能云人体关键点服务。',
    required: false,
  },
  suitSwap: {
    id: 'suitSwap',
    label: '职业装换装',
    desc: '本地合成职业装，仅换装不改五官；使用云端关键点或衣物识别前，还须另行同意上云增强',
    required: false,
  },
};

// 各工具(T1~T5)所需同意项
const TOOL_CONSENTS = {
  T1: ['faceLocal', 'faceCloudEnhance'],
  T2: ['faceLocal', 'faceCloudEnhance'],
  T3: ['faceLocal', 'faceCloudEnhance', 'suitSwap'],
  T4: ['faceLocal'],
  T5: [],
  T6: [],
};

function requiredConsents(tool) {
  return (TOOL_CONSENTS[tool] || []).map((k) => CONSENT_ITEMS[k]).filter(Boolean);
}

function buildConsentRecord(tool, granted = [], action = 'local') {
  const face = ['T1', 'T2', 'T3', 'T4'].includes(tool);
  const needs = { collect: face ? ['faceLocal'] : [], local: face ? ['faceLocal'] : [],
    cloud: ['T1', 'T2', 'T3'].includes(tool) ? ['faceLocal', 'faceCloudEnhance'] : null,
    suit: ['T1', 'T3'].includes(tool) ? ['faceLocal', 'suitSwap'] : null,
    pose: ['T1', 'T3'].includes(tool) ? ['faceLocal', 'faceCloudEnhance', 'suitSwap'] : null };
  const need = needs[action];
  if (!need || !Object.prototype.hasOwnProperty.call(TOOL_CONSENTS, tool)) return { tool, action, granted: [], missing: ['unsupported_action'], ready: false };
  const missing = need.filter((id) => !granted.includes(id));
  return {
    tool,
    action,
    granted: need.filter((id) => granted.includes(id)),
    missing,
    ready: missing.length === 0,
  };
}

// ---------- 撤回授权方式（PRD I2 / 个保法第 15 条：撤回同意权） ----------
//
// 【为什么放在 core】撤回路径是**合规契约**，不是纯 UI 文案：
// 撤回必须「一键可达」且「撤回后立即停止后续采集/上传」。
// 把「有哪些撤回入口、撤回后哪些数据会被删」收敛到 core 一处，
// 页面层只负责渲染，避免各页面各写一套文案导致口径漂移。
//
const WITHDRAW_METHODS = [
  {
    id: 'pageToggle',
    label: '页面内撤回',
    desc: '在功能页取消对应勾选即可撤回；撤回上云仍可本地处理，撤回换装可跳过（T3须重新同意才可换装）',
    scope: '立即停止后续的采集与上传',
  },
  {
    id: 'localPurge',
    label: '本地数据清理',
    desc: '离开工具页会释放本次会话的照片及预览引用',
    scope: '微信临时文件的实际清理由平台管理',
  },
  {
    id: 'cloudDestroy',
    label: '已发出的云端请求',
    desc: '撤回后系统会丢弃仍在等待的结果，已发出的请求无法撤回',
    scope: '停止后续相关上传',
  },
];

/**
 * 撤回授权的完整说明文案（页面层直接渲染）。
 * @param {string} [tool] 工具代号（T1~T5）；不给则返回通用文案
 * @returns {{title:string, body:string, methods:Array<object>}}
 */
function withdrawalNotice(tool) {
  const scope = tool
    ? `撤回「${tool}」对应授权后立即停止相关新操作，在途结果及页面旧结果失效；已发出的请求不能撤回，手机相册内已保存文件不受影响。`
    : '撤回对应授权后停止相关新操作，在途结果及页面旧结果失效；已发出的请求不能撤回，手机相册内已保存文件不受影响。';
  return {
    title: '如何撤回授权',
    body: scope,
    methods: WITHDRAW_METHODS.map((m) => ({ ...m })),
  };
}

module.exports = {
  CONSENT_ITEMS,
  TOOL_CONSENTS,
  requiredConsents,
  buildConsentRecord,
  WITHDRAW_METHODS,
  withdrawalNotice,
};
