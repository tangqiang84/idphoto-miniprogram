// 隐私同意契约（个保法敏感个人信息·单独同意）
// 不同工具触发不同授权项；换装须独立单独授权。

const CONSENT_ITEMS = {
  faceLocal: { id: 'faceLocal', label: '人脸本地处理', desc: '仅在设备端抠图，不上传', required: true },
  faceCloudEnhance: {
    id: 'faceCloudEnhance',
    label: '上云增强',
    desc: '仅上传裁剪后的人像区域至境内服务器，处理完即销毁，不用于模型训练',
    required: false,
  },
  suitSwap: {
    id: 'suitSwap',
    label: 'AI换装',
    desc: '云端合成职业装，仅换装不改五官，需单独授权',
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
};

function requiredConsents(tool) {
  return (TOOL_CONSENTS[tool] || []).map((k) => CONSENT_ITEMS[k]).filter(Boolean);
}

function buildConsentRecord(tool, granted) {
  const need = requiredConsents(tool).map((c) => c.id);
  const missing = need.filter((id) => !granted.includes(id));
  return {
    tool,
    granted: need.filter((id) => granted.includes(id)),
    missing,
    ready: missing.length === 0,
  };
}

module.exports = { CONSENT_ITEMS, TOOL_CONSENTS, requiredConsents, buildConsentRecord };
