'use strict';
// quality.checkFaceOcclusion 单测（PRD 12 章 EC2：发量遮挡耳眉 / 眼镜反光）
//
// ⚠️ 该模块是**启发式像素统计**，不是 CV 识别。
//    故单测的断言口径是「可解释的行为」而不是「精确的识别率」：
//    纯色/退化输入必须返回 unknown（不硬判），明显构造的暗块/高亮斑必须能被抓到。
const { test } = require('node:test');
const assert = require('node:assert');
const { checkFaceOcclusion } = require('../quality');

const W = 120;
const H = 120;
const FACE = { x: 30, y: 20, w: 60, h: 70 };

/** 铺一张底色图 */
function make(r = 200, g = 200, b = 200) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** 填充矩形 */
function fill(rgba, x, y, w, h, r, g, b) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
    }
  }
  return rgba;
}

/** 造一张「正常脸」：椭圆形的亮肤色区 + 背景 */
function normalFace() {
  const rgba = make(240, 240, 240);
  const cx = FACE.x + FACE.w / 2;
  const cy = FACE.y + FACE.h / 2;
  for (let y = FACE.y; y < FACE.y + FACE.h; y++) {
    for (let x = FACE.x; x < FACE.x + FACE.w; x++) {
      const nx = (x - cx) / (FACE.w / 2);
      const ny = (y - cy) / (FACE.h / 2);
      if (nx * nx + ny * ny <= 1) {
        const i = (y * W + x) * 4;
        rgba[i] = 205;
        rgba[i + 1] = 170;
        rgba[i + 2] = 150;
      }
    }
  }
  return rgba;
}

test('纯色图 → unknown（判不准就不判），不给 warn', () => {
  const rgba = make(200, 200, 200);
  const r = checkFaceOcclusion(rgba, W, H, FACE);
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.reason, 'flat_face_region');
});

test('缺少脸框 → unknown + 原因码', () => {
  const rgba = normalFace();
  const r = checkFaceOcclusion(rgba, W, H, null);
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.reason, 'no_face_rect');
});

test('脸框越界 → unknown + 原因码', () => {
  const rgba = normalFace();
  const r = checkFaceOcclusion(rgba, W, H, { x: 100, y: 100, w: 60, h: 60 });
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.reason, 'face_rect_out_of_bounds');
});

test('正常脸 → ok（不误报）', () => {
  const rgba = normalFace();
  const r = checkFaceOcclusion(rgba, W, H, FACE);
  assert.strictEqual(r.status, 'ok', `不应误报，实际 items=${JSON.stringify(r.items)}`);
  assert.strictEqual(r.items.length, 0);
});

test('左侧有明显暗块（模拟发量遮挡耳眉）→ warn + hair_cover', () => {
  const rgba = normalFace();
  // 左侧从脸框上缘一直垂到眉眼带下沿的暗色长发
  fill(rgba, FACE.x, FACE.y, 10, 40, 40, 30, 25);
  const r = checkFaceOcclusion(rgba, W, H, FACE);
  assert.strictEqual(r.status, 'warn');
  assert.ok(r.items.some((i) => i.code === 'hair_cover'), '应报出 hair_cover');
  const item = r.items.find((i) => i.code === 'hair_cover');
  assert.ok(item.label.includes('发量'));
  assert.ok(item.advice && item.advice.length > 0, '应给出建议文案');
});

test('右侧有明显暗块 → 同样能检出 hair_cover', () => {
  const rgba = normalFace();
  fill(rgba, FACE.x + FACE.w - 10, FACE.y, 10, 40, 40, 30, 25);
  const r = checkFaceOcclusion(rgba, W, H, FACE);
  assert.strictEqual(r.status, 'warn');
  assert.ok(r.items.some((i) => i.code === 'hair_cover'));
});

test('眼部局部高亮斑块（模拟镜片反光）→ warn + glare', () => {
  const rgba = normalFace();
  // 眼部带内一小块高光斑（4×4）
  fill(rgba, FACE.x + 26, FACE.y + 24, 4, 4, 255, 255, 255);
  const r = checkFaceOcclusion(rgba, W, H, FACE);
  assert.strictEqual(r.status, 'warn');
  assert.ok(r.items.some((i) => i.code === 'glare'), '应报出 glare');
  const item = r.items.find((i) => i.code === 'glare');
  assert.ok(item.label.includes('眼镜'));
});

test('整片过曝（不是局部反光）→ 不报 glare', () => {
  const rgba = normalFace();
  fill(rgba, FACE.x + 10, FACE.y + 15, FACE.w - 20, 30, 255, 255, 255);
  const r = checkFaceOcclusion(rgba, W, H, FACE);
  assert.ok(!r.items.some((i) => i.code === 'glare'), '整片高亮不算镜片反光');
});

test('返回结构符合约定：status / items[{code,label,advice}] / reason', () => {
  const rgba = normalFace();
  const r = checkFaceOcclusion(rgba, W, H, FACE);
  assert.ok(['ok', 'warn', 'unknown'].includes(r.status));
  assert.ok(Array.isArray(r.items));
  assert.strictEqual(typeof r.reason, 'string');
  for (const it of r.items) {
    assert.strictEqual(typeof it.code, 'string');
    assert.strictEqual(typeof it.label, 'string');
    assert.strictEqual(typeof it.advice, 'string');
  }
});

test('脸框太小 → unknown（统计不可靠）', () => {
  const rgba = normalFace();
  const r = checkFaceOcclusion(rgba, W, H, { x: 10, y: 10, w: 8, h: 8 });
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.reason, 'face_too_small');
});

test('像素缓冲区装不下 w*h → unknown（不读到 undefined 像素）', () => {
  const rgba = normalFace();
  const r = checkFaceOcclusion(rgba.slice(0, 100), W, H, FACE);
  assert.strictEqual(r.status, 'unknown');
  assert.strictEqual(r.reason, 'pixel_buffer_too_small');
});
