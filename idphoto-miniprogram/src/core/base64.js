/**
 * 纯 JS base64 编解码（CommonJS，Node 与微信小程序通用）。
 *
 * 为什么不能用现成的（2026-10-27 真机排障发现，任务 #52 续）：
 *   小程序运行时**既没有 `Buffer`（Node 内置）也没有 `btoa`/`atob`（浏览器 API）**。
 *   原 `core/mattingCloud.js` 的写法是：
 *       Buffer 有 → 用 Buffer；否则 btoa 有 → 用 btoa；否则 → Buffer.from(...)
 *   在小程序里前两个判断都不成立，最后落到 `Buffer.from(...)` → 抛
 *   **ReferenceError: Buffer is not defined** → 上云链路在小程序端**必然失败**。
 *   而此前失败被静默降级（degraded）吞掉，路由又几乎不走云端，
 *   于是「上云增强从来没在小程序端跑通过」这个 P0 缺陷一直没暴露。
 *
 * 本模块：**不依赖任何运行时 API**，纯查表实现，Node 单测与小程序行为完全一致。
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字节数组 → base64 字符串 */
function bytesToBase64(bytes) {
  const len = bytes.length;
  let out = '';
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : undefined;
    const b2 = i + 2 < len ? bytes[i + 2] : undefined;
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 0x03) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : CHARS[((b1 & 0x0f) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : CHARS[b2 & 0x3f];
  }
  return out;
}

/** base64 字符串 → 字节数组（自动忽略 '=' 与空白） */
function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  let buf = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = CHARS.indexOf(clean[i]);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[p++] = (buf >> bits) & 0xff;
    }
  }
  return out.subarray(0, p);
}

module.exports = { bytesToBase64, base64ToBytes, CHARS };
