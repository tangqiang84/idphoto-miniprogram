'use strict';
// 交互式裁剪窗单测（P1 #77 / P2.5）
// 契约：比例锁定（宽高比恒等于目标规格）、完全落在原图内、最小尺寸、居中默认建议。

const test = require('node:test');
const assert = require('node:assert');
const {
  clampCropWindow, centerCropWindow, sameCropWindow, MIN_CROP_EDGE,
} = require('../cropWindow');

const SRC_W = 1200;
const SRC_H = 1600;
const RATIO = 295 / 413; // 一寸 295×413

test('比例锁定：用户框比例不对 → 按宽推高，比例恒等于目标', () => {
  const r = clampCropWindow({ x: 10, y: 20, w: 400, h: 900 }, SRC_W, SRC_H, RATIO);
  assert.ok(r);
  assert.ok(Math.abs(r.w / r.h - RATIO) < 1e-9, `比例应锁定（实际 ${r.w}/${r.h}）`);
  assert.strictEqual(r.w, 400);
  assert.strictEqual(r.h, 400 / RATIO);
});

test('落在图内：越界的框被夹回原图', () => {
  const r = clampCropWindow({ x: 1000, y: 1500, w: 400, h: 600 }, SRC_W, SRC_H, RATIO);
  assert.ok(r.x + r.w <= SRC_W + 1e-6, '右边界不得越界');
  assert.ok(r.y + r.h <= SRC_H + 1e-6, '下边界不得越界');
  assert.ok(r.x >= -1e-6 && r.y >= -1e-6, '左上角不得为负');
});

test('负坐标被夹到 0', () => {
  const r = clampCropWindow({ x: -50, y: -80, w: 400, h: 600 }, SRC_W, SRC_H, RATIO);
  assert.strictEqual(r.x, 0);
  assert.strictEqual(r.y, 0);
});

test('最小尺寸：过小的框被放大到可输出尺寸', () => {
  const r = clampCropWindow({ x: 0, y: 0, w: 5, h: 5 }, SRC_W, SRC_H, RATIO);
  assert.ok(r.w >= MIN_CROP_EDGE - 1e-6, `宽应≥${MIN_CROP_EDGE}（实际 ${r.w}）`);
  assert.ok(Math.abs(r.w / r.h - RATIO) < 1e-9, '放大后比例仍锁定');
});

test('图比目标比例更“瘦”时按高约束宽（不越界）', () => {
  // 目标比例 1（正方形），源图 1200×800（扁）→ 宽受高约束
  const r = clampCropWindow({ x: 0, y: 0, w: 5000, h: 5000 }, 1200, 800, 1);
  assert.ok(r.w <= 1200 + 1e-6 && r.h <= 800 + 1e-6, '不得越界');
  assert.ok(Math.abs(r.w / r.h - 1) < 1e-9, '比例锁定');
});

test('非法输入返回 null（不猜默认值）', () => {
  assert.strictEqual(clampCropWindow(null, SRC_W, SRC_H, RATIO), null);
  assert.strictEqual(clampCropWindow({ x: 0, y: 0, w: 0, h: 0 }, SRC_W, SRC_H, RATIO), null);
  assert.strictEqual(clampCropWindow({ x: 0, y: 0, w: 10, h: 10 }, 0, 0, RATIO), null);
  assert.strictEqual(clampCropWindow({ x: 0, y: 0, w: 10, h: 10 }, SRC_W, SRC_H, 0), null);
});

test('居中默认建议：比例锁定且上下左右留白相等', () => {
  const c = centerCropWindow(SRC_W, SRC_H, RATIO);
  assert.ok(c);
  assert.ok(Math.abs(c.w / c.h - RATIO) < 1e-9);
  assert.ok(Math.abs(c.x - (SRC_W - c.w) / 2) < 1e-6);
  assert.ok(Math.abs(c.y - (SRC_H - c.h) / 2) < 1e-6);
});

test('sameCropWindow：改动 1px 内视为未改（避免无意义重跑）', () => {
  const a = { x: 10, y: 20, w: 400, h: 560 };
  const b = { x: 10.5, y: 20.4, w: 400, h: 560 };
  const c = { x: 60, y: 20, w: 400, h: 560 };
  assert.ok(sameCropWindow(a, b));
  assert.ok(!sameCropWindow(a, c));
  assert.ok(!sameCropWindow(a, null));
});
