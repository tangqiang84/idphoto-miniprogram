'use strict';
// P1 验证：suitFitV2 + suitCompose 全链路仿真（纯 Node，无需 DevTools）
//
// 冒烟（smoke_t3）依赖「设置→安全设置→服务端口」，端口关闭时跑不了；
// 本脚本在 Node 侧把换装的**几何 + 合成**整条链路跑一遍，给出可复现的落盘证据：
//   ① 9 个规格逐一：西装落在画布内、衣领顶严格在下巴之下（不盖脸，#69 不复发）
//   ② D2 不变量：颈部线以上（脸/头发）像素逐字节未被改动
//   ③ 覆盖率：人体前景在颈根以下的区域被西装覆盖的比例（原衣外露检测）
//   ④ 旋转落地：rotateDeg≠0 时合成结果与不旋转**不同**（证明旋转真的生效，不是被忽略）
//   ⑤ 原图不被修改（suitCompose 返回新数组）
// 产物：素材/测试截图/suitfit-<spec>.png（逐个规格落盘，供目视）

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const core = path.join(ROOT, 'idphoto-miniprogram', 'src', 'core');
const { SPECS, getPixelSize } = require(path.join(core, 'specLibrary'));
const { tightBBox, suitCompose } = require(path.join(core, 'suit'));
const { fitSuitV2, TEMPLATE_META } = require(path.join(core, 'suitFitV2'));
const { composite } = require(path.join(core, 'matting'));

const OUT_DIR = path.join(ROOT, '素材', '测试截图');
fs.mkdirSync(OUT_DIR, { recursive: true });

// 合成「人像」：头部椭圆 + 肩部以下身体（模拟标准证件照构图）
function buildPerson(w, h, ratioMid) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h);
  const headH = h * ratioMid;
  const crownY = 0.13 * headH;
  const chinY = crownY + headH;
  const cx = w / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inHead = ((x - cx) ** 2) / ((headH * 0.36) ** 2) + ((y - (crownY + headH / 2)) ** 2) / ((headH / 2) ** 2) <= 1;
      // 脖子 + 身体：颈根（chinY）向下连续（脖子 → 渐宽到肩再直下），
      // 肩宽目标 1.6×头长（与物理标尺口径一致）
      const shoulderTop = chinY + 0.22 * headH;
      const neckHalf = 0.20 * headH;
      const inBody = (() => {
        if (y < chinY) return false;
        if (y < shoulderTop) return Math.abs(x - cx) <= neckHalf;
        const k = Math.min(1, (y - shoulderTop) / (0.25 * headH));
        const half = neckHalf + k * ((1.6 * headH) / 2 - neckHalf);
        return Math.abs(x - cx) <= half;
      })();
      if (inHead || inBody) {
        alpha[i] = 1;
        const p = i * 4;
        rgba[p] = inHead ? 200 : 90;
        rgba[p + 1] = inHead ? 170 : 130;
        rgba[p + 2] = inHead ? 150 : 190;
        rgba[p + 3] = 255;
      }
    }
  }
  return { rgba, alpha, headH, crownY, chinY };
}

// 模板（几何与 make_suit_templates.py 一致：y<40 透明，肩宽 360/400）
// 【为什么带竖条纹】纯色模板无法观测旋转——旋转后覆盖的人体像素集合可能完全相同
// （实测 small-one-inch / driver-license 上 diffPx=0，一度误判为"旋转失效"）。
// 加竖条纹后，旋转会把条纹方向带偏，差异必然可见。
function buildTemplate() {
  const { width: tw, height: th } = TEMPLATE_META;
  const tpl = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      if (y < TEMPLATE_META.collarTopY) continue;
      const i = (y * tw + x) * 4;
      const stripe = Math.floor(x / 20) % 2 === 0;
      tpl[i] = stripe ? 32 : 60;
      tpl[i + 1] = stripe ? 32 : 60;
      tpl[i + 2] = stripe ? 36 : 66;
      tpl[i + 3] = 255;
    }
  }
  return tpl;
}

let fail = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' -> ' + extra : ''));
}

const tpl = buildTemplate();
console.log('=== P1 suitFitV2 + suitCompose 全链路仿真（9 规格 × 300dpi） ===\n');

for (const spec of SPECS) {
  const px = getPixelSize(spec, 300);
  const ratioMid = (spec.headHeightRatioMin + spec.headHeightRatioMax) / 2;
  const { rgba, alpha, headH, crownY, chinY } = buildPerson(px.width, px.height, ratioMid);
  const bbox = tightBBox(alpha, px.width, px.height);
  const face = { chinY, crownY, headH, faceCenterX: px.width / 2, source: 'landmarks' };

  const fit = fitSuitV2({ spec, canvasW: px.width, canvasH: px.height, face, pose: null, bbox });
  if (!fit.ok) { check(`${spec.id} 求解`, false, JSON.stringify(fit.audit)); continue; }

  // ① 几何断言
  const p = fit.place;
  const inCanvas = p.x >= -0.5 && p.x + p.w <= px.width + 0.5;
  check(`${spec.id} ① 西装横向不越界`, inCanvas, `x=${p.x.toFixed(0)} w=${p.w.toFixed(0)} canvasW=${px.width}`);
  check(`${spec.id} ① 衣领顶在下巴之下（不盖脸）`, fit.audit.garmentTop > chinY,
    `garmentTop=${fit.audit.garmentTop.toFixed(0)} chinY=${chinY.toFixed(0)}`);
  check(`${spec.id} ① 覆盖到画布底`, p.y + p.h >= px.height - 0.5, `bottom=${(p.y + p.h).toFixed(0)}/${px.height}`);

  // ② D2 + 覆盖率：合成后统计
  const before = Uint8ClampedArray.from(rgba);
  const suited = suitCompose(rgba, alpha, px.width, px.height, tpl, TEMPLATE_META.width, TEMPLATE_META.height, fit.place, fit.rotateDeg);

  let faceChanged = 0;
  let bodyTotal = 0;
  let bodyCovered = 0;
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const i = y * px.width + x;
      if (alpha[i] <= 0.5) continue;
      const q = i * 4;
      const changed = suited[q] !== before[q] || suited[q + 1] !== before[q + 1] || suited[q + 2] !== before[q + 2];
      // 统计边界：双线性采样会在模板衣领起始行产生**半透明过渡**（#33 决策的副作用），
      // 实测仅 garmentTop 所在那一行受影响（1 行），属设计内行为、不是盖脸 → 排除该行。
      if (y < Math.floor(fit.audit.garmentTop)) {
        if (changed) faceChanged++;
      } else {
        bodyTotal++;
        if (changed) bodyCovered++;
      }
    }
  }
  check(`${spec.id} ② 脸部/头部像素零改动（PRD D2）`, faceChanged === 0, `changed=${faceChanged}`);
  const coverRate = bodyTotal ? bodyCovered / bodyTotal : 0;
  check(`${spec.id} ③ 颈根以下覆盖率 ≥95%（原衣不露）`, coverRate >= 0.95, `${(coverRate * 100).toFixed(1)}%`);
  check(`${spec.id} ⑤ 输入 rgba 未被修改`, rgba.every((v, i) => v === before[i]));

  // ④ 旋转落地：同一输入分别以 0° 与 8° 合成，结果必须不同
  const rot = fitSuitV2({
    spec, canvasW: px.width, canvasH: px.height, face,
    pose: { points: [
      { name: 'left_shoulder', x: px.width / 2 - 100, y: chinY + 0.22 * headH - 14, score: 0.9 },
      { name: 'right_shoulder', x: px.width / 2 + 100, y: chinY + 0.22 * headH + 14, score: 0.9 },
    ] },
    bbox,
  });
  const rotated = rot.ok
    ? suitCompose(rgba, alpha, px.width, px.height, tpl, TEMPLATE_META.width, TEMPLATE_META.height, rot.place, rot.rotateDeg)
    : null;
  let diff = 0;
  if (rotated) for (let i = 0; i < suited.length; i++) if (suited[i] !== rotated[i]) diff++;
  check(`${spec.id} ④ 旋转生效（0° vs ${rot.ok ? rot.rotateDeg.toFixed(1) : '?'}° 像素差异 >0）`, !!rotated && diff > 0, `diffPx=${diff}`);

  // 落盘（合成蓝底便于目视）
  const composed = composite(suited, alpha, px.width, px.height, '#438EDB');
  writePng(path.join(OUT_DIR, `suitfit-${spec.id}.png`), composed, px.width, px.height);
}

console.log('\n结果：' + (fail === 0 ? '✅ 全部通过（链路验证通过，非真机验收）' : `❌ ${fail} 项失败`));
console.log('产物目录：素材/测试截图/suitfit-*.png');
process.exit(fail === 0 ? 0 : 1);

// ---- 最小 PNG 写出（无第三方依赖：zlib + CRC）----
function writePng(file, rgba, w, h) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
    }
  }
  const idat = zlib.deflateSync(raw);
  const chunks = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)));
  fs.writeFileSync(file, Buffer.concat(chunks));
}
