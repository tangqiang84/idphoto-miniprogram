// 隐私同意契约（个保法敏感个人信息·单独同意）
// 不同工具触发不同授权项；换装须独立单独授权。

const CONSENT_ITEMS = {
  faceLocal: { id: 'faceLocal', label: '人脸本地处理', desc: '仅在设备端抠图，不上传', required: true },
  faceCloudEnhance: {
    id: 'faceCloudEnhance',
    label: '上云增强',
    // ⚠️ 个保法第 23 条：向第三方提供个人信息，须告知**接收方名称**并取得单独同意。
    // 2026-10-23 起云端增强由「百度智能云·人像分割」接口完成（云函数内调用，密钥不进包体），
    // 故文案必须点名接收方；改 provider（如换自部署 BiRefNet）时此处须同步改。
    desc: '仅上传裁剪后的人像区域，交由境内第三方服务「百度智能云·人像分割」完成抠图增强，处理完即销毁，不用于模型训练',
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
