/**
 * 上传文件格式 / 大小硬校验（PRD A2 / 验收 AC3）
 *
 * - 支持格式：JPG / PNG / WebP（与 PRD A2「支持从相册选择 JPG / PNG / WebP」一致）
 * - 单张大小上限：10MB（PRD A2「单张 ≤ 10MB」；验收「超大文件（>10MB）→ 拦截」）
 *
 * 设计要点：
 * 1. 纯函数、CommonJS，可被 Node `node:test` 单测，不依赖 Taro/wx 运行时。
 * 2. 格式判定：优先看路径扩展名；扩展名缺失/无法判定时，用 getImageInfo 返回的
 *    `type` 兜底（微信相册/拍照返回的临时路径不一定带扩展名）。两者都非法才拦截。
 * 3. 大小判定：传入的 bytes 来自 chooseImage.tempFiles[].size 或 getFileInfo.size；
 *    若字节数无法取得（<0 / 非数字），按「降级放行」处理，避免误杀真实用户
 *    （宁可少拦一次，不可错杀正常图片）。
 * 4. 调用方（useImagePicker）在「取图后、进入处理(onImage)前」调用 validateUpload，
 *    不通过则提示并 return，绝不进入抠图/换底等处理链路。
 */

// 允许的扩展名（小写）。jpeg 与 jpg 等价。
const ALLOWED_FORMATS = ['jpg', 'jpeg', 'png', 'webp'];

// 单张大小上限（字节）：10MB。
const MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * 从路径中取扩展名（不含点，小写）。
 * 处理：query string、hash、无扩展名、全大写等。
 * @param {string} p 文件路径或 URL
 * @returns {string} 扩展名或空串
 */
function getExt(p) {
  if (!p || typeof p !== 'string') return '';
  // 去掉 query / hash
  let s = p.split('?')[0].split('#')[0];
  const i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return ''; // 无点 / 末尾点
  // 防止出现路径段（如 a.b/c）误判：取最后一个斜杠之后的部分
  const seg = s.slice(s.lastIndexOf('/') + 1);
  const j = seg.lastIndexOf('.');
  if (j < 0 || j === seg.length - 1) return '';
  return seg.slice(j + 1).toLowerCase();
}

/**
 * 格式校验（PRD A2）。
 * @param {string} path 文件路径
 * @param {string} [type] getImageInfo 返回的 type（如 'png'/'jpg'）
 * @returns {{ok:boolean, reason?:'format', message?:string, source?:'ext'|'type'}}
 */
function checkFormat(path, type) {
  const ext = getExt(path);
  if (ALLOWED_FORMATS.includes(ext)) {
    return { ok: true, source: 'ext' };
  }
  const t = String(type || '').toLowerCase();
  if (ALLOWED_FORMATS.includes(t)) {
    return { ok: true, source: 'type' };
  }
  return {
    ok: false,
    reason: 'format',
    message: '仅支持 JPG / PNG / WebP 格式，请选择对应图片',
  };
}

/**
 * 大小校验（PRD A2，≤10MB）。
 * @param {number} bytes 文件字节数；-1 / 非数字表示无法取得（降级放行）
 * @returns {{ok:boolean, reason?:'size', message?:string, degraded?:boolean}}
 */
function checkSize(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) {
    // 无法判定大小 → 放行（不误杀），标记降级
    return { ok: true, degraded: true };
  }
  if (bytes > MAX_SIZE_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    return {
      ok: false,
      reason: 'size',
      message: `图片过大（约 ${mb}MB），需 ≤ 10MB，请压缩后重试`,
    };
  }
  return { ok: true };
}

/**
 * 组合校验：格式 + 大小（PRD A2 硬拦截入口）。
 * @param {string} path 文件路径
 * @param {string} [type] getImageInfo 返回的 type
 * @param {number} [bytes] 文件字节数（无法取得传 -1）
 * @returns {{ok:boolean, reason?:'format'|'size', message?:string, source?:string, degraded?:boolean}}
 */
function validateUpload(path, type, bytes) {
  const fmt = checkFormat(path, type);
  if (!fmt.ok) return fmt;
  const sz = checkSize(bytes);
  if (!sz.ok) return sz;
  return { ok: true, degraded: sz.degraded };
}

module.exports = {
  ALLOWED_FORMATS,
  MAX_SIZE_BYTES,
  getExt,
  checkFormat,
  checkSize,
  validateUpload,
};
