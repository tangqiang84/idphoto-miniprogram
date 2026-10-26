'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  applyBeauty, assertCompliance, COMPLIANCE_MSG, BEAUTY_CATALOG, gaussianKernel, COMPLIANCE_MODE,
} = require('../beauty');

function makeBuffer(w, h, fill) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = typeof fill === 'function' ? fill(i) : fill;
    buf[i * 4] = v;
    buf[i * 4 + 1] = v;
    buf[i * 4 + 2] = v;
    buf[i * 4 + 3] = 255;
  }
  return buf;
}

function variance(buf) {
  let sum = 0;
  const n = buf.length / 4;
  for (let i = 0; i < n; i++) sum += buf[i * 4];
  const mean = sum / n;
  let v = 0;
  for (let i = 0; i < n; i++) { const d = buf[i * 4] - mean; v += d * d; }
  return v / n;
}

test('gaussianKernel 归一化', () => {
  const { kernel } = gaussianKernel(2);
  let s = 0;
  for (const k of kernel) s += k;
  assert.ok(Math.abs(s - 1) < 1e-6, '核权重和应为 1');
});

test('纯平坦灰图 磨皮 不改变像素（无边缘）', () => {
  const w = 64, h = 64;
  const buf = makeBuffer(w, h, 128);
  const out = applyBeauty(buf, w, h, { smooth: 1 });
  assert.strictEqual(out, buf, '应原地修改并返回同一缓冲');
  for (let i = 0; i < w * h; i++) assert.strictEqual(buf[i * 4], 128, `像素 ${i} 应仍为 128`);
});

test('噪点图 磨皮 显著降低方差（平滑生效）', () => {
  const w = 64, h = 64;
  // 基值 128 + [-20,20] 噪声（< EDGE_TOL=24 → 全部判定为平坦区，应被平滑）
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const buf = makeBuffer(w, h, () => 128 + Math.round((rnd() - 0.5) * 40));
  const before = variance(buf);
  applyBeauty(buf, w, h, { smooth: 1 });
  const after = variance(buf);
  assert.ok(after < before, `磨皮后应降方差: before=${before} after=${after}`);
});

test('美白 提升平均亮度', () => {
  const w = 32, h = 32;
  const buf = makeBuffer(w, h, 100);
  applyBeauty(buf, w, h, { whiten: 1 });
  let sum = 0;
  for (let i = 0; i < w * h; i++) sum += buf[i * 4];
  const mean = sum / (w * h);
  assert.ok(mean > 140, `美白后应明显变亮，实际均值=${mean}`);
});

test('美颜 不改变 alpha 通道', () => {
  const w = 32, h = 32;
  const buf = makeBuffer(w, h, 100);
  for (let i = 0; i < w * h; i++) buf[i * 4 + 3] = 123;
  applyBeauty(buf, w, h, { smooth: 0.5, whiten: 0.5, brighten: 0.5 });
  for (let i = 0; i < w * h; i++) assert.strictEqual(buf[i * 4 + 3], 123, `alpha 应保持 123`);
});

test('E2 硬拦截：传入禁止项 slim 抛合规提示', () => {
  const w = 16, h = 16;
  const buf = makeBuffer(w, h, 128);
  assert.throws(
    () => applyBeauty(buf, w, h, { smooth: 0.3, slim: 0.8 }),
    (e) => e.message === COMPLIANCE_MSG,
  );
});

test('E2 硬拦截：bigeye / reshape 同样被拦截', () => {
  const w = 16, h = 16;
  const buf = makeBuffer(w, h, 128);
  assert.throws(() => assertCompliance({ bigeye: 0.5 }), (e) => e.message === COMPLIANCE_MSG);
  assert.throws(() => assertCompliance({ reshape: 1 }), (e) => e.message === COMPLIANCE_MSG);
});

test('合规模式 总开关 为 true', () => {
  assert.strictEqual(COMPLIANCE_MODE, true);
  assert.strictEqual(BEAUTY_CATALOG.smooth.allowed, true);
  assert.strictEqual(BEAUTY_CATALOG.slim.allowed, false);
  assert.strictEqual(BEAUTY_CATALOG.bigeye.allowed, false);
});

test('允许的 ops 不触发拦截', () => {
  assert.doesNotThrow(() => assertCompliance({ smooth: 0.5, whiten: 0.3, brighten: 0.2 }));
});
