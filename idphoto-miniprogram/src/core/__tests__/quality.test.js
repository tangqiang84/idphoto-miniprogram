const test = require('node:test');
const assert = require('node:assert');
const {
  assessQuality,
  BG_THRESHOLD,
  DARK_LIMIT,
  OVER_LIMIT,
} = require('../quality');

// 构造纯色采样图（RGBA）
function solid(w, h, v, srcW, srcH) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return assessQuality(rgba, w, h, srcW, srcH);
}

// 构造随机噪声采样图（高背景复杂度）
function noise(w, h, srcW, srcH) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.floor(Math.random() * 256);
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return assessQuality(rgba, w, h, srcW, srcH);
}

test('纯色背景 + 达标分辨率 → 无提示', () => {
  const r = solid(64, 64, 200, 1200, 1600);
  assert.strictEqual(r.level, 'ok');
  assert.strictEqual(r.tips.length, 0);
});

test('低分辨率（<600×800）→ 触发 lowres 提示', () => {
  const r = solid(64, 64, 200, 400, 600);
  assert.ok(r.tips.some((t) => t.code === 'lowres'));
});

test('分辨率仅宽不足 → 触发 lowres 提示', () => {
  const r = solid(64, 64, 200, 500, 1600);
  assert.ok(r.tips.some((t) => t.code === 'lowres'));
});

test('复杂背景（噪声）→ 触发 complexbg 提示', () => {
  const r = noise(64, 64, 1200, 1600);
  assert.ok(r.tips.some((t) => t.code === 'complexbg'));
});

test('纯色背景 bgScore 远低于阈值', () => {
  const r = solid(64, 64, 200, 1200, 1600);
  assert.ok(r.metrics.bgScore < BG_THRESHOLD);
});

test('过暗（均值<DARK_LIMIT）→ 触发 dark 提示', () => {
  const r = solid(64, 64, 20, 1200, 1600);
  assert.ok(r.tips.some((t) => t.code === 'dark'));
});

test('过曝（均值>OVER_LIMIT）→ 触发 over 提示', () => {
  const r = solid(64, 64, 250, 1200, 1600);
  assert.ok(r.tips.some((t) => t.code === 'over'));
});

test('正常亮度（200）不触发明暗提示', () => {
  const r = solid(64, 64, 200, 1200, 1600);
  assert.ok(!r.tips.some((t) => t.code === 'dark' || t.code === 'over'));
});
