/**
 * T6 冲印排版 · 上游成品图承接（PRD K1 入口①：从 T1 导出页「另存为排版版」进入）
 *
 * 纯函数模块（CommonJS，可 Node 单测）：
 *   - decodeSrcParam(raw)   安全解码 URL 参数，非法/为空一律返回 ''（绝不抛错）
 *   - handoffMessage(ok)    承接结果的中文提示（成功/失败两档）
 *   - resolveHandoff(raw, info)  依据「参数 + 读到的图片信息」给出承接结论
 *
 * 为什么要抽成纯函数：
 *   1. 页面里读路由参数 + 读图尺寸的组合逻辑有 4 种分支（无参 / 参数非法 / 读不到图 / 读成功），
 *      写在组件里只能靠真机/模拟器验证，抽出来可 Node 单测锁死；
 *   2. **读不到上游图必须能降级**（提示用户手动从相册选），绝不能白屏或崩页面。
 */

/** 安全解码：空值/非字符串 → ''；非法百分号编码 → 原样返回 */
function decodeSrcParam(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  if (!s) return '';
  try {
    s = decodeURIComponent(s);
  } catch (e) {
    // 保留原值（非法转义不应导致整页崩）
  }
  return s.trim();
}

/** 承接提示文案 */
function handoffMessage(ok) {
  return ok
    ? '已接收上一步导出的证件照，可直接选相纸导出'
    : '未能读取上一步的照片，请从相册重新选择';
}

/**
 * 承接结论
 * @param {any} raw  路由参数 src（原样，可能带百分号编码）
 * @param {any} info 读到的图片信息 {width,height}；读不到时传 null
 * @returns {{ok:boolean, src:string, width?:number, height?:number, message:string}}
 */
function resolveHandoff(raw, info) {
  const src = decodeSrcParam(raw);
  if (!src) {
    return { ok: false, src: '', message: handoffMessage(false) };
  }
  if (!info || !info.width || !info.height) {
    return { ok: false, src, message: handoffMessage(false) };
  }
  return {
    ok: true,
    src,
    width: info.width,
    height: info.height,
    message: handoffMessage(true),
  };
}

module.exports = {
  decodeSrcParam,
  handoffMessage,
  resolveHandoff,
};
