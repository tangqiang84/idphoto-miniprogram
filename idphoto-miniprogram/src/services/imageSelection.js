'use strict';
// 新基础库使用chooseMedia，旧基础库保留chooseImage；仅规范取图返回值，不处理人像。
async function selectAlbum(platform) {
  const traceId = 'pick-' + Date.now();
  const failed = (code, message, cancelled = false) => ({ ok: false, error: { code, message, cancelled, traceId } });
  try {
    let result; let item; let path;
    if (typeof platform.chooseMedia === 'function') {
      result = await platform.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['original', 'compressed'] });
      item = result?.tempFiles?.[0]; path = item?.tempFilePath;
    } else if (typeof platform.chooseImage === 'function') {
      result = await platform.chooseImage({ count: 1, sourceType: ['album'], sizeType: ['original', 'compressed'] });
      item = result?.tempFiles?.[0]; path = result?.tempFilePaths?.[0];
    } else return failed('PICK_UNAVAILABLE', '当前基础库不支持相册选择，请升级微信');
    if (typeof path !== 'string' || !path) return failed('PICK_EMPTY', '未取得有效照片，请重新选择');
    return { ok: true, image: { path, size: typeof item?.size === 'number' && Number.isFinite(item.size) && item.size >= 0 ? item.size : undefined } };
  } catch (cause) {
    if (/cancel|取消/i.test(String(cause?.errMsg || cause?.message || ''))) return failed('PICK_CANCELLED', '已取消选择', true);
    return failed('PICK_FAILED', '读取图片失败，请重试');
  }
}
module.exports = { selectAlbum };
