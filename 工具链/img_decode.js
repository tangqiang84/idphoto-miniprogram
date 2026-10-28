'use strict';
/**
 * 纯 Node 图像解码工具（PNG 自带实现 + JPEG 走 jpeg-js）
 * ============================================================================
 * 【为什么需要它】
 * 业务断言（assert_business.js）必须能读**成品像素**（底色 / 头部占比 / 花屏），
 * 而断言库要求「纯 Node，不依赖 IDE」——不能为了读图去连微信开发者工具。
 *
 * 【实现口径】
 *   · PNG：**完全自实现**（只用 Node 内置 zlib）→ 零外部依赖，任何环境都能跑，
 *     且能保留 alpha 通道（透明底 PNG 的底色判定必需）。
 *   · JPEG：自实现基线解码器不现实（需哈夫曼 + IDCT + 逐像素），故按候选路径
 *     解析 jpeg-js（**路径基于 __dirname / os.homedir() 推导，不写死 /Users/tq**）：
 *       ① 仓库内 idphoto-miniprogram/node_modules
 *       ② ~/.workbuddy/binaries/node/workspace/node_modules（miniprogram-automator 同源目录）
 *       ③ npm root -g
 *     解析不到时抛出可操作提示（而非静默返回空图 → 断言假通过）。
 *
 * 用法：
 *   const { decodeImage, isPng, isJpeg } = require('./img_decode');
 *   const img = decodeImage(path);   // { width, height, data: Uint8Array(RGBA) }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

/** 读文件 → Buffer */
function readBuffer(p) {
  return fs.readFileSync(p);
}

/** 是不是 PNG */
function isPng(buf) {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

/** 是不是 JPEG */
function isJpeg(buf) {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
}

// ---------------------------------------------------------------- PNG 解码

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解 PNG → {width,height,data:RGBA} */
function decodePng(buf) {
  if (!isPng(buf)) throw new Error('不是 PNG 文件');
  if (!buf.slice(0, 8).equals(PNG_SIG)) throw new Error('PNG 签名不匹配');

  let off = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.slice(dataStart, dataEnd);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off = dataEnd + 4; // 跳过 CRC
  }

  if (!ihdr) throw new Error('PNG 缺少 IHDR');
  if (ihdr.interlace !== 0) throw new Error('暂不支持 Adam7 隔行 PNG（interlace=1）');
  if (ihdr.compression !== 0 || ihdr.filter !== 0) throw new Error('PNG 压缩/过滤方式非标准');
  if (!idat.length) throw new Error('PNG 缺少 IDAT');

  const { width, height, bitDepth, colorType } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('PNG colorType 不支持: ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));

  // 反滤波（PNG filter）
  const out = Buffer.alloc(bytesPerLine * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    if (pos >= raw.length) throw new Error('PNG 像素数据不足（截断）');
    const ft = raw[pos++];
    const line = raw.slice(pos, pos + bytesPerLine);
    pos += bytesPerLine;
    const cur = out.slice(y * bytesPerLine, (y + 1) * bytesPerLine);
    const prev = y > 0 ? out.slice((y - 1) * bytesPerLine, y * bytesPerLine) : null;
    for (let x = 0; x < bytesPerLine; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      switch (ft) {
        case 0: cur[x] = v; break;
        case 1: cur[x] = (v + a) & 0xff; break;
        case 2: cur[x] = (v + b) & 0xff; break;
        case 3: cur[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[x] = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error('PNG 未知 filter 类型: ' + ft);
      }
    }
  }

  // 位深 → 每通道取值
  const sample = (line, index) => {
    if (bitDepth === 8) return line[index];
    if (bitDepth === 16) return line[index * 2]; // 取高字节
    // 1/2/4 位：打包在字节内
    const perByte = 8 / bitDepth;
    const byte = line[Math.floor(index / perByte)];
    const shift = 8 - bitDepth * ((index % perByte) + 1);
    const mask = (1 << bitDepth) - 1;
    const raw2 = (byte >> shift) & mask;
    // 灰度/调色板索引按比例放大到 8 位
    return colorType === 3 ? raw2 : Math.round((raw2 * 255) / mask);
  };

  const outRGBA = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = out.slice(y * bytesPerLine, (y + 1) * bytesPerLine);
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const base = x * channels;
      if (colorType === 0) {
        const g = sample(line, base);
        outRGBA[di] = g; outRGBA[di + 1] = g; outRGBA[di + 2] = g; outRGBA[di + 3] = 255;
      } else if (colorType === 2) {
        outRGBA[di] = sample(line, base);
        outRGBA[di + 1] = sample(line, base + 1);
        outRGBA[di + 2] = sample(line, base + 2);
        outRGBA[di + 3] = 255;
      } else if (colorType === 3) {
        const idx = sample(line, base);
        if (!palette) throw new Error('PNG 为调色板模式但缺少 PLTE');
        outRGBA[di] = palette[idx * 3];
        outRGBA[di + 1] = palette[idx * 3 + 1];
        outRGBA[di + 2] = palette[idx * 3 + 2];
        outRGBA[di + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (colorType === 4) {
        const g = sample(line, base);
        outRGBA[di] = g; outRGBA[di + 1] = g; outRGBA[di + 2] = g;
        outRGBA[di + 3] = sample(line, base + 1);
      } else {
        outRGBA[di] = sample(line, base);
        outRGBA[di + 1] = sample(line, base + 1);
        outRGBA[di + 2] = sample(line, base + 2);
        outRGBA[di + 3] = sample(line, base + 3);
      }
    }
  }
  return { width, height, data: outRGBA, format: 'png' };
}

// ---------------------------------------------------------------- JPEG 解码

let _jpegLib = null;
let _jpegErr = null;

/** 候选路径解析 jpeg-js（路径全部推导，不写死 /Users/tq） */
function resolveJpegLib() {
  if (_jpegLib) return _jpegLib;
  if (_jpegErr) throw _jpegErr;
  const candidates = [
    path.join(__dirname, '..', 'idphoto-miniprogram', 'node_modules', 'jpeg-js'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules', 'jpeg-js'),
    path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions', '22.22.2-6', 'lib', 'node_modules', 'jpeg-js'),
  ];
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (mod && typeof mod.decode === 'function') {
        _jpegLib = mod;
        return _jpegLib;
      }
    } catch (e) { /* 试下一个 */ }
  }
  // npm root -g
  try {
    const { execSync } = require('child_process');
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (root) {
      const mod = require(path.join(root, 'jpeg-js'));
      if (mod && typeof mod.decode === 'function') {
        _jpegLib = mod;
        return _jpegLib;
      }
    }
  } catch (e) { /* ignore */ }

  _jpegErr = new Error(
    '找不到 jpeg-js（读 JPEG 像素需要它）。请在 idphoto-miniprogram 下执行：npm i jpeg-js --no-save，' +
    '或安装到全局 npm root。PNG 无需任何依赖。',
  );
  throw _jpegErr;
}

/** 解 JPEG → {width,height,data:RGBA} */
function decodeJpeg(buf) {
  const lib = resolveJpegLib();
  const raw = lib.decode(buf, { useTArray: true, formatAsRGBA: true });
  return {
    width: raw.width,
    height: raw.height,
    data: new Uint8Array(raw.data.buffer ? raw.data : raw.data),
    format: 'jpeg',
  };
}

// ---------------------------------------------------------------- 统一入口

/**
 * 解码图片 → { width, height, data: Uint8Array(RGBA, 长度 = w*h*4), format }
 * @param {string} p 图片路径
 */
function decodeImage(p) {
  const buf = readBuffer(p);
  if (isPng(buf)) return decodePng(buf);
  if (isJpeg(buf)) return decodeJpeg(buf);
  throw new Error('不支持的图片格式（仅支持 PNG/JPEG）: ' + p);
}

/** 只读尺寸不解码像素（快） */
function readSize(p) {
  const buf = readBuffer(p);
  if (isPng(buf)) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (isJpeg(buf)) {
    let off = 2;
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
      }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      off += 2 + len;
    }
  }
  throw new Error('无法读取图片尺寸: ' + p);
}

module.exports = { decodeImage, decodePng, decodeJpeg, readSize, isPng, isJpeg };

// ---------------------------------------------------------------- CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h') || !args.length) {
    console.log(`图像解码工具（纯 Node）

用法:
  node 工具链/img_decode.js <图片路径> [...]

输出: 每个文件的 宽×高 + 格式 + 左上角/中心/右下角像素（RGBA）
PNG 用内置实现（零依赖，保留 alpha）；JPEG 走 jpeg-js（自动解析路径）。`);
    process.exit(args.length ? 0 : 0);
  }
  for (const a of args) {
    try {
      const img = decodeImage(a);
      const at = (x, y) => {
        const i = (y * img.width + x) * 4;
        return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]].join(',');
      };
      console.log(`${a} -> ${img.width}×${img.height} ${img.format}`);
      console.log(`  左上(${at(0, 0)}) 中心(${at(img.width >> 1, img.height >> 1)}) 右下(${at(img.width - 1, img.height - 1)})`);
    } catch (e) {
      console.error(`${a} -> 失败: ${e.message}`);
      process.exitCode = 2;
    }
  }
}
