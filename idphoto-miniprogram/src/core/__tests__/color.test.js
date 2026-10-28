'use strict';
// color 单测：颜色输入解析 + 背景形态归一化
const { test } = require('node:test');
const assert = require('node:assert');
const { parseColorInput, resolveBackground, sampleGradient } = require('../color');

// ---------- parseColorInput ----------

test('parseColorInput：#RRGGBB', () => {
  const r = parseColorInput('#438EDB');
  assert.strictEqual(r.hex, '#438EDB');
  assert.deepStrictEqual(r.rgb, [67, 142, 219]);
});

test('parseColorInput：#RGB 短格式展开成 #RRGGBB', () => {
  const r = parseColorInput('#48D');
  assert.strictEqual(r.hex, '#4488DD');
  assert.deepStrictEqual(r.rgb, [68, 136, 221]);
});

test('parseColorInput：rgb(r,g,b) 函数形式', () => {
  const r = parseColorInput('rgb(67,142,219)');
  assert.strictEqual(r.hex, '#438EDB');
  assert.deepStrictEqual(r.rgb, [67, 142, 219]);
});

test('parseColorInput：rgb() 允许空格与大小写', () => {
  const r = parseColorInput('RGB( 67 , 142 , 219 )');
  assert.strictEqual(r.hex, '#438EDB');
  assert.deepStrictEqual(r.rgb, [67, 142, 219]);
});

test('parseColorInput：裸 "r,g,b" 形式', () => {
  const r = parseColorInput('67,142,219');
  assert.strictEqual(r.hex, '#438EDB');
  assert.deepStrictEqual(r.rgb, [67, 142, 219]);
});

test('parseColorInput：HEX 大小写不敏感（统一输出大写）', () => {
  const r = parseColorInput('#438edb');
  assert.strictEqual(r.hex, '#438EDB');
  assert.deepStrictEqual(r.rgb, [67, 142, 219]);
});

test('parseColorInput：非法输入一律返回 null（不猜默认值）', () => {
  assert.strictEqual(parseColorInput('#GGGGGG'), null);
  assert.strictEqual(parseColorInput('#12345'), null, '5 位 HEX 非法');
  assert.strictEqual(parseColorInput('rgb(300,0,0)'), null, '通道越界非法');
  assert.strictEqual(parseColorInput('rgb(1,2)'), null);
  assert.strictEqual(parseColorInput('hello'), null);
  assert.strictEqual(parseColorInput(''), null);
  assert.strictEqual(parseColorInput(null), null);
  assert.strictEqual(parseColorInput(undefined), null);
  assert.strictEqual(parseColorInput(123), null);
});

test('parseColorInput：边界值 0 与 255 合法', () => {
  const r = parseColorInput('rgb(0,0,0)');
  assert.deepStrictEqual(r.rgb, [0, 0, 0]);
  const r2 = parseColorInput('rgb(255,255,255)');
  assert.deepStrictEqual(r2.rgb, [255, 255, 255]);
});

// ---------- resolveBackground ----------

test('resolveBackground：null → transparent', () => {
  const r = resolveBackground(null);
  assert.strictEqual(r.type, 'transparent');
  assert.strictEqual(r.hex, null);
});

test('resolveBackground：HEX 字符串 → solid', () => {
  const r = resolveBackground('#438EDB');
  assert.strictEqual(r.type, 'solid');
  assert.strictEqual(r.hex, '#438EDB');
  assert.deepStrictEqual(r.rgb, [67, 142, 219]);
});

test('resolveBackground：gradient 对象 → 归一化渐变描述', () => {
  const r = resolveBackground({
    type: 'gradient',
    from: '#FFFFFF',
    to: '#000000',
    angle: 90,
  });
  assert.strictEqual(r.type, 'gradient');
  assert.strictEqual(r.from.hex, '#FFFFFF');
  assert.strictEqual(r.to.hex, '#000000');
  assert.deepStrictEqual(r.from.rgb, [255, 255, 255]);
  assert.strictEqual(r.angle, 90);
});

test('resolveBackground：gradient 缺 angle → 默认 0', () => {
  const r = resolveBackground({ type: 'gradient', from: '#fff', to: '#000' });
  assert.strictEqual(r.type, 'gradient');
  assert.strictEqual(r.angle, 0);
});

test('resolveBackground：非法输入 → invalid + 原因码', () => {
  assert.strictEqual(resolveBackground('#ZZZ').type, 'invalid');
  assert.strictEqual(resolveBackground('#ZZZ').reason, 'unparsable_color');
  assert.strictEqual(resolveBackground({ type: 'gradient', from: 'nope', to: '#000' }).reason, 'bad_gradient_from');
  assert.strictEqual(resolveBackground({ type: 'gradient', from: '#000', to: 'nope' }).reason, 'bad_gradient_to');
  assert.strictEqual(resolveBackground({ type: 'gradient', from: '#000', to: '#fff', angle: 'x' }).reason, 'bad_gradient_angle');
  assert.strictEqual(resolveBackground(123).type, 'invalid');
  assert.strictEqual(resolveBackground({ type: 'weird' }).type, 'invalid');
});

// ---------- sampleGradient ----------

test('sampleGradient：angle=0（左→右）时左端≈from、右端≈to', () => {
  const d = resolveBackground({ type: 'gradient', from: '#000000', to: '#FFFFFF', angle: 0 });
  const left = sampleGradient(d, 0, 0, 100, 10);
  const right = sampleGradient(d, 99, 0, 100, 10);
  assert.ok(left[0] < 20, `左端应接近 from，实际 ${left}`);
  assert.ok(right[0] > 235, `右端应接近 to，实际 ${right}`);
});

test('sampleGradient：angle=90（上→下）时上端≈from、下端≈to', () => {
  const d = resolveBackground({ type: 'gradient', from: '#000000', to: '#FFFFFF', angle: 90 });
  const top = sampleGradient(d, 5, 0, 10, 100);
  const bottom = sampleGradient(d, 5, 99, 10, 100);
  assert.ok(top[0] < 20, `上端应接近 from，实际 ${top}`);
  assert.ok(bottom[0] > 235, `下端应接近 to，实际 ${bottom}`);
});

test('sampleGradient：中间点取到中间色', () => {
  const d = resolveBackground({ type: 'gradient', from: '#000000', to: '#FFFFFF', angle: 0 });
  const mid = sampleGradient(d, 50, 0, 101, 10);
  assert.ok(mid[0] > 100 && mid[0] < 160, `中间点应接近中值，实际 ${mid[0]}`);
});

// ---------- 合成层适配（matting.composite 支持渐变底） ----------

test('matting.composite：纯色字符串路径零回归（仍是纯色底）', () => {
  const { composite } = require('../matting');
  const w = 4, h = 1;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h).fill(0); // 全背景
  const out = composite(rgba, alpha, w, h, '#0000ff');
  assert.deepStrictEqual([out[0], out[1], out[2]], [0, 0, 255]);
});

test('matting.composite：渐变底 → 背景色随位置变化', () => {
  const { composite } = require('../matting');
  const w = 100, h = 10;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h).fill(0); // 全背景
  const out = composite(rgba, alpha, w, h, {
    type: 'gradient', from: '#000000', to: '#FFFFFF', angle: 0,
  });
  const left = [out[0], out[1], out[2]];
  const right = [(w - 1) * 4, (w - 1) * 4 + 1, (w - 1) * 4 + 2].map((i) => out[i]);
  assert.ok(left[0] < 20, `左端应接近 from，实际 ${left}`);
  assert.ok(right[0] > 235, `右端应接近 to，实际 ${right}`);
});

test('matting.composite：非法底色回落白色（不抛异常、不产出黑图）', () => {
  const { composite } = require('../matting');
  const w = 2, h = 1;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h).fill(0);
  const out = composite(rgba, alpha, w, h, '#NOTACOLOR');
  assert.deepStrictEqual([out[0], out[1], out[2]], [255, 255, 255]);
});

