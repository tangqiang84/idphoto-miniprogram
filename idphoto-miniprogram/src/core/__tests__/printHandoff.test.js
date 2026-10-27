/**
 * printHandoff 单测（T6 冲印排版 · 上游成品图承接）
 * 运行：node --test src/core/__tests__/printHandoff.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { decodeSrcParam, handoffMessage, resolveHandoff } = require('../printHandoff');

test('decodeSrcParam：正常解码百分号编码', () => {
  assert.strictEqual(decodeSrcParam('%2Ftmp%2Fa.jpg'), '/tmp/a.jpg');
  assert.strictEqual(decodeSrcParam('/tmp/a.jpg'), '/tmp/a.jpg');
});

test('decodeSrcParam：空值/非字符串 → 空串', () => {
  assert.strictEqual(decodeSrcParam(''), '');
  assert.strictEqual(decodeSrcParam(null), '');
  assert.strictEqual(decodeSrcParam(undefined), '');
  assert.strictEqual(decodeSrcParam('   '), '');
});

test('decodeSrcParam：非法百分号编码不抛错（保留原值）', () => {
  assert.strictEqual(decodeSrcParam('%E0%A4%A'), '%E0%A4%A');
  assert.strictEqual(decodeSrcParam('100%'), '100%');
});

test('handoffMessage：两档文案固定', () => {
  assert.strictEqual(handoffMessage(true), '已接收上一步导出的证件照，可直接选相纸导出');
  assert.strictEqual(handoffMessage(false), '未能读取上一步的照片，请从相册重新选择');
});

test('resolveHandoff：读图成功 → ok，带宽高', () => {
  const r = resolveHandoff('/tmp/x.jpg', { width: 295, height: 413 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.src, '/tmp/x.jpg');
  assert.strictEqual(r.width, 295);
  assert.strictEqual(r.height, 413);
  assert.strictEqual(r.message, handoffMessage(true));
});

test('resolveHandoff：无参数 → 失败（不阻断，提示手动选图）', () => {
  const r = resolveHandoff('', { width: 100, height: 100 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.src, '');
  assert.strictEqual(r.message, handoffMessage(false));
});

test('resolveHandoff：读不到图（info=null）→ 失败并保留 src', () => {
  const r = resolveHandoff('/tmp/gone.jpg', null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.src, '/tmp/gone.jpg');
  assert.strictEqual(r.message, handoffMessage(false));
});

test('resolveHandoff：尺寸非法（0 宽高）→ 失败', () => {
  const r = resolveHandoff('/tmp/x.jpg', { width: 0, height: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.message, handoffMessage(false));
});
