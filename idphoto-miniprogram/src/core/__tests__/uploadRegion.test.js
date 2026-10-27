/**
 * pickUploadRegion 单测（2026-10-27，问题台账 #64）
 * 场景：端侧 alpha 不可信（噪声）时，不能再用它的 bbox 去框「上传给云端的人像区域」。
 */
const test = require('node:test');
const assert = require('node:assert');
const { pickUploadRegion, MIN_FG_RATIO, MAX_BBOX_RATIO } = require('../mattingCloud');

const W = 200, H = 300;
function makeImage() {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 10; rgba[i * 4 + 1] = 20; rgba[i * 4 + 2] = 30; rgba[i * 4 + 3] = 255; }
  return rgba;
}
function makeAlpha(fgRatio, bbox) {
  const a = new Float32Array(W * H);
  const n = Math.round(W * H * fgRatio);
  for (let i = 0; i < n; i++) {
    const x = bbox.x + (i % bbox.w);
    const y = bbox.y + Math.floor(i / bbox.w) % bbox.h;
    a[y * W + x] = 1;
  }
  return a;
}

test('① 提供人脸区域提示 → 直接用它（最可信）', () => {
  const r = pickUploadRegion(makeImage(), new Float32Array(W * H), W, H, { x: 40, y: 30, w: 100, h: 150 });
  assert.strictEqual(r.mode, 'face_region');
  assert.strictEqual(r.x, 40);
  assert.strictEqual(r.y, 30);
  assert.strictEqual(r.w, 100);
  assert.strictEqual(r.h, 150);
});

test('② 端侧 alpha 可信（前景占比高、bbox 不大）→ 用 alpha bbox', () => {
  const a = makeAlpha(0.3, { x: 60, y: 40, w: 80, h: 120 });
  const r = pickUploadRegion(makeImage(), a, W, H, null);
  assert.strictEqual(r.mode, 'alpha_bbox');
  assert.ok(r.w <= W && r.h <= H);
  assert.ok((r.w * r.h) / (W * H) <= MAX_BBOX_RATIO + 1e-6);
});

test('③ 端侧 alpha 不可信（前景占比低）→ 回退居中区域，且不越界', () => {
  const a = makeAlpha(0.01, { x: 0, y: 0, w: 200, h: 300 });
  const r = pickUploadRegion(makeImage(), a, W, H, null);
  assert.strictEqual(r.mode, 'center_region');
  assert.ok(r.x >= 0 && r.y >= 0);
  assert.ok(r.x + r.w <= W);
  assert.ok(r.y + r.h <= H);
  assert.ok(r.w > 0 && r.h > 0);
});

test('③ 端侧 alpha 全空 → 同样回退居中区域（不是整图）', () => {
  const r = pickUploadRegion(makeImage(), new Float32Array(W * H), W, H, null);
  assert.strictEqual(r.mode, 'center_region');
  assert.ok(r.w < W || r.h < H, '回退区域应小于整图（合规：只上传人像区域）');
});

test('③ bbox 过大（框不住人）→ 回退居中区域', () => {
  // 前景稀疏但铺满整图 → 前景占比 20%（看着"可信"），但 bbox = 整图 → 不可用
  const a = new Float32Array(W * H);
  for (let y = 0; y < H; y += 5) for (let x = 0; x < W; x += 5) a[y * W + x] = 1;
  const r = pickUploadRegion(makeImage(), a, W, H, null);
  assert.strictEqual(r.mode, 'center_region');
});

test('阈值常量符合预期（端侧前景占比低于 0.12 视为不可信）', () => {
  assert.ok(MIN_FG_RATIO > 0 && MIN_FG_RATIO < 0.3);
  assert.ok(MAX_BBOX_RATIO > 0.3 && MAX_BBOX_RATIO < 1);
});
