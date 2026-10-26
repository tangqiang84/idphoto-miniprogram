'use strict';
// alphaPatch 单测（任务 #42 / PRD B1 / T1-17）
const { test } = require('node:test');
const assert = require('node:assert');
const { applyPatches, newStroke, addPoint, boundsOfStrokes, stamp } = require('../alphaPatch');

function fill(w, h, v) {
  return new Array(w * h).fill(v);
}

test('erase 把笔刷覆盖像素置 0，其余保持不变', () => {
  const w = 100, h = 100;
  const a = fill(w, h, 1);
  const out = applyPatches(a, w, h, [{ mode: 'erase', radius: 0.05, points: [{ x: 0.5, y: 0.5 }] }]);
  // 覆盖区（约半径 5px 圆）被置 0
  assert.strictEqual(out[50 * w + 50], 0);
  // 远点保持原值
  assert.strictEqual(out[5 * w + 5], 1);
  // 入参未被污染
  assert.strictEqual(a[50 * w + 50], 1);
});

test('restore 把笔刷覆盖像素置 1（含从 0 恢复）', () => {
  const w = 100, h = 100;
  const a = fill(w, h, 0);
  const out = applyPatches(a, w, h, [{ mode: 'restore', radius: 0.05, points: [{ x: 0.5, y: 0.5 }] }]);
  assert.strictEqual(out[50 * w + 50], 1);
  assert.strictEqual(out[5 * w + 5], 0);
});

test('相邻两点之间插值落点，避免断点空洞', () => {
  const w = 100, h = 100;
  const a = fill(w, h, 1);
  // 横跨一整行的两点（沿 y=0.5），半径 5px：起点/中点/终点都应被盖到
  // 注意像素索引 = y*w + x，故 (x=10,y=50) = 50*w+10
  const out = applyPatches(a, w, h, [{ mode: 'erase', radius: 0.05, points: [{ x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }] }]);
  assert.strictEqual(out[50 * w + 10], 0, '起点 (x=10,y=50) 应被覆盖');
  assert.strictEqual(out[50 * w + 50], 0, '中点 (x=50,y=50) 应被插值笔触覆盖');
  assert.strictEqual(out[50 * w + 90], 0, '终点 (x=90,y=50) 应被覆盖');
});

test('越界坐标被 clamp，不污染画布', () => {
  const w = 100, h = 100;
  const a = fill(w, h, 1);
  const out = applyPatches(a, w, h, [{ mode: 'erase', radius: 0.05, points: [{ x: 2, y: 2 }] }]);
  // x=2 → cx=200 远超宽，印章不落任何像素
  assert.deepStrictEqual(Array.from(out), a);
});

test('空笔画返回原值（不改）', () => {
  const w = 50, h = 50;
  const a = fill(w, h, 0.5);
  const out = applyPatches(a, w, h, []);
  assert.deepStrictEqual(Array.from(out), a);
});

test('半径越大覆盖像素越多', () => {
  const w = 100, h = 100;
  const a = fill(w, h, 1);
  const small = applyPatches(a, w, h, [{ mode: 'erase', radius: 0.02, points: [{ x: 0.5, y: 0.5 }] }]);
  const big = applyPatches(a, w, h, [{ mode: 'erase', radius: 0.1, points: [{ x: 0.5, y: 0.5 }] }]);
  const count = (o) => o.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
  assert.ok(count(big) > count(small), '大半径覆盖应更多');
});

test('缺省 mode 视为 erase', () => {
  const w = 100, h = 100;
  const a = fill(w, h, 1);
  const out = applyPatches(a, w, h, [{ radius: 0.05, points: [{ x: 0.5, y: 0.5 }] }]);
  assert.strictEqual(out[50 * w + 50], 0);
});

test('无 alpha/尺寸 返回入参', () => {
  assert.strictEqual(applyPatches(null, 10, 10, []), null);
  const a = [1, 1];
  assert.strictEqual(applyPatches(a, 0, 0, []), a);
});

test('stamp 圆形印章边界正确', () => {
  const w = 10, h = 10;
  const a = fill(w, h, 1);
  stamp(a, w, h, 0.5, 0.5, 2, 0); // 中心 (5,5) 半径 2
  assert.strictEqual(a[5 * w + 5], 0);    // 中心
  assert.strictEqual(a[5 * w + 7], 0);    // 边缘内 (dx=2,dy=0)
  assert.strictEqual(a[5 * w + 8], 1);    // 边缘外 (dx=3)
});

test('辅助函数 newStroke / addPoint / boundsOfStrokes', () => {
  let s = newStroke('erase', 0.05, { x: 0.1, y: 0.2 });
  assert.strictEqual(s.mode, 'erase');
  assert.strictEqual(s.points.length, 1);
  addPoint(s, { x: 0.3, y: 0.4 });
  assert.strictEqual(s.points.length, 2);
  const b = boundsOfStrokes([s]);
  assert.ok(b.minX <= 0.1 && b.maxX >= 0.3 && b.minY <= 0.2 && b.maxY >= 0.4);
});
