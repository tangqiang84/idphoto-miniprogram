'use strict';
// ===================== PNG 编解码（纯 Node 内置 zlib，零第三方依赖） =====================
//
// 【为什么必须手写 —— 百度人像分割接入的第一个硬约束】
// 百度人像分割 API（POST /rest/2.0/image-classify/v1/body_seg）的契约是：
//   入参 image =「图片文件」的 base64（支持 jpg/png/bmp，不含 data:image 头）
//   出参 scoremap / foreground =「PNG 文件」的 base64
// 而本项目上云链路（core/mattingCloud）传的是**原始 RGBA 像素流**、期望回的是**单通道 alpha 序列**。
// 两端都是「像素 ↔ 图片文件」的鸿沟，必须做编解码。
//
// 常规做法是 sharp / jimp / pngjs，但 **微信 CloudBase 云函数没有这些包**，
// 且项目硬约束「禁止 npm install 新包」（会触发 webpack 重排风险，见《项目资产与工具手册》）。
// 好在 Node 自带 zlib，PNG 容器本身只是「chunk + CRC32 + deflate + 行过滤器」，
// 约 200 行即可覆盖我们需要的子集（8bit、非隔行、colorType 0/2/4/6）。
//
// 【覆盖范围与失败语义 —— 重要】
// 只支持 bitDepth=8、interlace=0、compression=0。遇到其他格式**直接抛错**，
// 由调用方降级到影子实现 —— 宁可降级，也不要静默产出错误的 alpha。
//
// 框架无关：只依赖 Node zlib，可在单测里直接 require（云函数与测试共用同一份）。

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_GRAY = 0;        // 灰度（scoremap 属此类）
const COLOR_RGB = 2;         // RGB
const COLOR_GRAY_ALPHA = 4;  // 灰度 + alpha
const COLOR_RGBA = 6;        // RGBA（foreground 属此类）
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }; // colorType → 通道数（3=palette，仅登记不做像素解析）

// ===================== CRC32（PNG chunk 校验） =====================
const CRC_TABLE = (function buildCrcTable() {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// ===================== 编码：RGBA 像素 → PNG =====================
// rgba: Uint8ClampedArray / Uint8Array / Buffer，长度 >= w*h*4
// 行过滤器固定用 0（None）：实现简单、可逆；deflate 会处理其余压缩。
function encodePNG(rgba, width, height) {
  if (!(width > 0) || !(height > 0)) throw new Error('png.encode: 尺寸非法');
  const need = width * height * 4;
  if (!rgba || rgba.length < need) throw new Error('png.encode: 像素数据不足');
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    raw[o] = 0; // filter type 0
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = rgba[y * stride + x] & 0xff;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;            // bitDepth
  ihdr[9] = COLOR_RGBA;   // colorType
  ihdr[10] = 0;           // compression
  ihdr[11] = 0;           // filter
  ihdr[12] = 0;           // interlace
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ===================== 解码：PNG → RGBA 像素 =====================
// 统一输出 RGBA（4 通道），调用方不必关心源图的 colorType：
//   colorType 0（灰度）      → R=G=B=gray, A=255
//   colorType 4（灰度+alpha）→ R=G=B=gray, A=alpha
//   colorType 2（RGB）       → A=255
//   colorType 6（RGBA）      → 原样
// 返回 { width, height, colorType, data }，data 为 Uint8ClampedArray（长度 w*h*4）
function decodePNG(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || SIG.compare(buf, 0, 8) !== 0) throw new Error('png.decode: 不是合法 PNG（签名不匹配）');
  let pos = 8;
  let ihdr = null;
  const idat = [];
  let sawEnd = false;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new Error('png.decode: chunk 长度越界');
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { sawEnd = true; pos = dataEnd + 4; break; }
    pos = dataEnd + 4; // 跳过 CRC
  }
  if (!ihdr) throw new Error('png.decode: 缺少 IHDR');
  if (!sawEnd) throw new Error('png.decode: 缺少 IEND（文件可能 truncated）');
  if (!idat.length) throw new Error('png.decode: 缺少 IDAT');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const compression = ihdr[10];
  const filterMethod = ihdr[11];
  const interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error(`png.decode: 不支持的位深 ${bitDepth}（仅支持 8）`);
  if (compression !== 0) throw new Error('png.decode: 不支持的压缩方式');
  if (filterMethod !== 0) throw new Error('png.decode: 不支持的过滤器方式');
  if (interlace !== 0) throw new Error('png.decode: 不支持隔行扫描 PNG');
  const ch = CHANNELS[colorType];
  if (!ch || colorType === 3) throw new Error(`png.decode: 不支持的 colorType ${colorType}`);

  const rawAll = Buffer.concat(idat);
  let raw;
  try {
    raw = zlib.inflateSync(rawAll);
  } catch (e) {
    throw new Error('png.decode: IDAT 解压缩失败 — ' + (e && e.message));
  }
  const stride = width * ch;
  const expect = height * (stride + 1);
  if (raw.length < expect) throw new Error(`png.decode: 解压后数据不足（${raw.length} < ${expect}）`);

  const out = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8ClampedArray(stride);
  const cur = new Uint8ClampedArray(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v;
      if (ft === 0) v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) v = x + paeth(a, b, c);
      else throw new Error(`png.decode: 未知过滤器类型 ${ft}（第 ${y} 行）`);
      cur[i] = v & 0xff;
    }
    p += stride;
    // 展开为 RGBA
    const oy = y * width * 4;
    if (colorType === COLOR_GRAY) {
      for (let i = 0; i < width; i++) {
        const g = cur[i];
        out[oy + i * 4] = g; out[oy + i * 4 + 1] = g; out[oy + i * 4 + 2] = g; out[oy + i * 4 + 3] = 255;
      }
    } else if (colorType === COLOR_GRAY_ALPHA) {
      for (let i = 0; i < width; i++) {
        const g = cur[i * 2], a = cur[i * 2 + 1];
        out[oy + i * 4] = g; out[oy + i * 4 + 1] = g; out[oy + i * 4 + 2] = g; out[oy + i * 4 + 3] = a;
      }
    } else if (colorType === COLOR_RGB) {
      for (let i = 0; i < width; i++) {
        out[oy + i * 4] = cur[i * 3]; out[oy + i * 4 + 1] = cur[i * 3 + 1]; out[oy + i * 4 + 2] = cur[i * 3 + 2]; out[oy + i * 4 + 3] = 255;
      }
    } else {
      for (let i = 0; i < width * 4; i++) out[oy + i] = cur[i];
    }
    prev.set(cur);
  }
  return { width, height, colorType, data: out };
}

function paeth(a, b, c) {
  const pp = a + b - c;
  const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

module.exports = { encodePNG, decodePNG, crc32, SIG, COLOR_GRAY, COLOR_RGB, COLOR_GRAY_ALPHA, COLOR_RGBA };
