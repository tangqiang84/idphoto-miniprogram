'use strict';
/**
 * 换装盖脸修复 —— 代码级端到端验证（不依赖微信模拟器热重载）
 * 直接跑 fitSuitV2 + suitCompose 合成，再用 assertSuitDoesNotCoverFace 判定脸区未被盖。
 * 目的：模拟器未热加载新 dist 时，仍能在代码层证明修复生效（与 suitFitV2.test.js 互为补充）。
 */
const path = require('path');
const CORE = path.join(__dirname, '..', 'idphoto-miniprogram', 'src', 'core');
const { fitSuitV2 } = require(path.join(CORE, 'suitFitV2.js'));
const { suitCompose } = require(path.join(CORE, 'suit.js'));
const A = require('./assert_business.js');

function makePhoto(w, h) {
  // 合成一张「证件照」：上部肤色脸 + 下部灰身，构造明显的脸区与身体区
  const rgba = new Uint8ClampedArray(w * h * 4);
  const skin = [240, 200, 170], body = [120, 120, 130], bg = [233, 238, 243];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = bg;
      if (y >= 40 && y <= 240 && x >= 80 && x <= 215) c = skin; // 脸（含五官区）
      else if (y > 240) c = body; // 身体
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return rgba;
}
function makeSuitTpl(tw, th) {
  // 实心深色西装模板（不透明），用于验证「西装顶 = place.y」
  const tpl = new Uint8ClampedArray(tw * th * 4);
  for (let i = 0; i < tw * th; i++) {
    tpl[i * 4] = 30; tpl[i * 4 + 1] = 30; tpl[i * 4 + 2] = 40; tpl[i * 4 + 3] = 255;
  }
  return tpl;
}
function toFile(rgba, w, h, p) {
  // 极简 PNG 写出（仅用于喂给 assert 的 loadPixels）——若 img_decode 支持原始 RGBA 则跳过
  // 这里直接把 rgba 以 JSON 暂存，assert 不支持；改为内存比对
  return { rgba, w, h };
}

const specLib = require(path.join(CORE, 'specLibrary.js'));
const spec = specLib.getSpec('one-inch');
const W = 295, H = 413;

let allPass = true;
const cases = [
  ['无人脸检测(physical兜底)', null],
  ['有人脸实测(landmarks)', { chinY: 320, crownY: 60, headH: 260, faceCenterX: 147, source: 'landmarks' }],
];
for (const [name, face] of cases) {
  const photo = makePhoto(W, H);
  const fit = fitSuitV2({ spec, canvasW: W, canvasH: H, face, pose: null, bbox: null });
  if (!fit.ok) { console.log(`✗ ${name}: fit 失败 ${fit.reason}`); allPass = false; continue; }
  const tpl = makeSuitTpl(400, 400);
  const alpha = new Uint8ClampedArray(W * H).fill(255);
  const suited = suitCompose(photo.slice(), alpha, W, H, tpl, 400, 400, fit.place, fit.rotateDeg);
  // 脸区（与 123.png 断言同款框）：行 88~237, 列 0~273 内不应出现西装深色像素
  const faceTop = 88, faceBot = 237, faceL = 0, faceR = 273;
  let suitInFace = 0, facePx = 0;
  for (let y = faceTop; y <= faceBot; y++) {
    for (let x = faceL; x <= faceR; x++) {
      const i = (y * W + x) * 4;
      const r = suited[i], g = suited[i + 1], b = suited[i + 2];
      // 西装深色判定：偏暗且低饱和
      const lum = (r + g + b) / 3;
      if (lum < 80 && Math.abs(r - g) < 25 && Math.abs(g - b) < 30) { suitInFace++; }
      facePx++;
    }
  }
  const ratio = suitInFace / facePx;
  const ok = ratio <= 0.12;
  console.log(`${ok ? '✓' : '✗'} ${name}: 脸区西装像素占比 ${(ratio * 100).toFixed(1)}% (阈值12%) place.y=${fit.place.y.toFixed(1)} garmentTop≈${(fit.place.y + 40 * fit.scale).toFixed(1)}`);
  if (!ok) allPass = false;
}
process.exit(allPass ? 0 : 1);
