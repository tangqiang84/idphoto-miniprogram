'use strict';
// #43 验证：T1 向导内换装集成的数据流（纯 Node，无 canvas）
// 证明三件事：
//   1) 不换装路径 = composite(rgba) 原样（零回归）
//   2) 换装路径 suitCompose 仅改「颈部线(place.y)及以下」前景区，颈部线以上（脸）逐字节不变（D2）
//   3) suitCompose 不修改输入 rgba（返回新数组）
// 说明：真实模板 PNG 由页面离屏 canvas 读取；此处用同构色的合成模板替代，验证几何/覆盖口径。

const path = require('path');
const core = path.join(__dirname, '..', 'idphoto-miniprogram', 'src', 'core');
const { composite } = require(path.join(core, 'matting'));
const { alphaBBox, suitPlacement, suitCompose } = require(path.join(core, 'suit'));

function buildPerson(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const inFace = ((x - 60) ** 2) / (30 ** 2) + ((y - 45) ** 2) / (40 ** 2) <= 1;
      const inBody = x >= 25 && x <= 95 && y >= 80 && y < h;
      if (inFace) {
        alpha[i] = 1;
        rgba[i * 4] = 200; rgba[i * 4 + 1] = 170; rgba[i * 4 + 2] = 150; rgba[i * 4 + 3] = 255;
      } else if (inBody) {
        alpha[i] = 1;
        rgba[i * 4] = 80; rgba[i * 4 + 1] = 120; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255;
      }
    }
  }
  return { rgba, alpha };
}

function solidTemplate(tw, th, r, g, b) {
  const tpl = new Uint8ClampedArray(tw * th * 4);
  for (let i = 0; i < tw * th; i++) {
    tpl[i * 4] = r; tpl[i * 4 + 1] = g; tpl[i * 4 + 2] = b; tpl[i * 4 + 3] = 255;
  }
  return tpl;
}

function run() {
  const w = 120, h = 160;
  const bg = '#ffffff';
  const { rgba, alpha } = buildPerson(w, h);
  const rgbaSnapshot = new Uint8ClampedArray(rgba);

  let pass = true;
  const ok = (cond, msg) => { console.log(`${cond ? 'OK ' : 'FAIL'} ${msg}`); if (!cond) pass = false; };

  // 1) 不换装路径 = composite(rgba)（零回归）
  const base = composite(rgba, alpha, w, h, bg);
  ok(base.length === w * h * 4, `不换装 composite 尺寸 ${base.length} == ${w * h * 4}`);
  const base2 = composite(rgba, alpha, w, h, bg);
  let same = true;
  for (let i = 0; i < base.length; i++) if (base[i] !== base2[i]) { same = false; break; }
  ok(same, '不换装路径可复现（两次 composite 逐字节一致）');

  // 2) 换装路径
  const bbox = alphaBBox(alpha, w, h);
  ok(!!bbox, `alphaBBox 有效 bbox=${JSON.stringify(bbox)}`);
  const headH = bbox.h * 0.30;              // 无 faceDetect 时的估算口径（与页面 fallback 一致）
  const place = suitPlacement(bbox, headH);
  const tpl = solidTemplate(40, 40, 40, 40, 60);
  const suited = suitCompose(rgba, alpha, w, h, tpl, 40, 40, place);
  ok(suited.length === w * h * 4, `suitCompose 输出尺寸 ${suited.length} == ${w * h * 4}`);

  // 3) suitCompose 不修改输入
  let inputIntact = true;
  for (let i = 0; i < rgba.length; i++) if (rgba[i] !== rgbaSnapshot[i]) { inputIntact = false; break; }
  ok(inputIntact, 'suitCompose 未修改输入 rgba（返回新数组）');

  // 4) D2：颈部线以上（脸）逐字节不变
  const neckY = Math.max(0, Math.round(place.y));
  let faceIntact = true;
  for (let y = 0; y < neckY; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        if (suited[o + k] !== rgba[o + k]) { faceIntact = false; break; }
      }
      if (!faceIntact) break;
    }
    if (!faceIntact) break;
  }
  ok(faceIntact, `颈部线(y=${neckY})以上像素逐字节不变（D2 不触碰脸部）`);

  // 5) 换装确实覆盖了颈部线以下的前景（躯体）
  let changedBelow = 0;
  for (let y = neckY; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (alpha[i] > 0.5) {
        const o = i * 4;
        if (suited[o] !== rgba[o] || suited[o + 1] !== rgba[o + 1] || suited[o + 2] !== rgba[o + 2]) changedBelow++;
      }
    }
  }
  ok(changedBelow > 0, `颈部线以下前景区被换装覆盖（改动像素=${changedBelow}）`);

  // 6) 换装后再 composite 正常出图
  const withSuit = composite(suited, alpha, w, h, bg);
  ok(withSuit.length === w * h * 4, `换装后 composite 尺寸 ${withSuit.length} == ${w * h * 4}`);

  console.log(pass ? '\n✅ #43 换装集成数据流验证通过' : '\n❌ #43 验证未通过');
  process.exit(pass ? 0 : 1);
}

run();
