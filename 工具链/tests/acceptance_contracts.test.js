'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeCropConfirmation, measuredShoulder, classifySample } = require('../acceptance_oracles');
const core = '../../idphoto-miniprogram/src/core/';
const { validateUpload } = require(core + 'validateFile');
const { parseColorInput, sampleGradient, resolveBackground } = require(core + 'color');
const { getPixelSize } = require(core + 'specLibrary');
const { assertCompliance } = require(core + 'beauty');
const { planLayout, sheetPixelSize } = require(core + 'paperLibrary');
const { check } = require(core + 'compliance');

test('upload-boundaries', () => {
  assert.equal(validateUpload('x.png', 'png', 10 * 1024 * 1024).ok, true);
  assert.equal(validateUpload('x.webp', 'webp', 1000).ok, true);
  assert.equal(validateUpload('x.jpg', 'jpg', 1000).ok, true);
  assert.equal(validateUpload('x.gif', 'gif', 1000).ok, false);
  assert.equal(validateUpload('x.png', 'png', 10 * 1024 * 1024 + 1).ok, false);
});

test('color-equivalence-and-rejection', () => {
  assert.equal(parseColorInput('rgb(67,142,219)').hex, '#438EDB');
  assert.equal(parseColorInput('#438edb').hex, '#438EDB');
  assert.equal(parseColorInput('rgb(256,0,0)'), null);
  const gradient = resolveBackground({ type: 'gradient', from: '#000000', to: '#FFFFFF', angle: 0 });
  // 采样坐标为像素中心：11像素画布两端的权重分别为0.5/11及10.5/11。
  assert.deepEqual(sampleGradient(gradient, 0, 0, 11, 11), [12, 12, 12]);
  assert.deepEqual(sampleGradient(gradient, 10, 0, 11, 11), [243, 243, 243]);
});

test('fixed-spec-reference', () => {
  // 固定期望取自已确认规格参考表，未用被测换算函数生成期望。
  const sizes = {
    'one-inch': [[295, 413], [591, 827]],
    'small-one-inch': [[260, 378], [520, 756]],
    'driver-license': [[260, 378], [520, 756]],
    'two-inch': [[413, 579], [827, 1157]],
    'small-two-inch': [[413, 531], [827, 1063]],
    'big-one-inch': [[390, 567], [780, 1134]],
    'big-two-inch': [[413, 626], [827, 1252]],
    'passport-cn': [[390, 567], [780, 1134]],
    'visa-us': [[600, 600], [1200, 1200]],
  };
  for (const [id, pair] of Object.entries(sizes)) {
    for (const [index, dpi] of [300, 600].entries()) {
      const actual = getPixelSize(id, dpi);
      assert.deepEqual([actual.width, actual.height], pair[index], id + '/' + dpi);
    }
  }
  assert.notDeepEqual([295, 413], [591, 827]);
});

test('beauty-forbidden-options', () => {
  assert.doesNotThrow(() => assertCompliance({ smooth: 0.2 }));
  for (const key of ['slim', 'bigeye', 'reshape']) assert.throws(() => assertCompliance({ [key]: true }));
});

test('paper-independent-reference', () => {
  assert.equal(planLayout('paper-6in', 'one-inch').count, 10);
  assert.equal(planLayout('paper-6in', 'two-inch').count, 4);
  assert.equal(planLayout('instax-mini', 'one-inch').count, 1);
  assert.equal(planLayout('instax-mini', 'visa-us').count, 0);
  const size = sheetPixelSize('paper-6in');
  assert.ok(size.width > 0 && size.height > 0);
});

test('compliance-restricted-background', () => {
  const base = { widthPx: 260, heightPx: 378, dpi: 300, fileKb: 80, headHeightRatio: 0.64 };
  assert.equal(check('driver-license', { ...base, bg: 'white' }).pass, true);
  assert.equal(check('driver-license', { ...base, bg: 'blue' }).pass, false);
});

test('crop-before-downstream-oracle', () => {
  const base = { imageDelivered: true, events: [] };
  assert.equal(beforeCropConfirmation(base).status, 'PASS');
  for (const kind of ['segment', 'beauty', 'suit', 'product-export']) {
    assert.equal(beforeCropConfirmation({ ...base, events: [{ kind, cropConfirmed: false }] }).status, 'FAIL');
    assert.equal(beforeCropConfirmation({ ...base, events: [{ kind, cropConfirmed: true }] }).status, 'PASS');
  }
  assert.equal(beforeCropConfirmation({ imageDelivered: false, events: [] }).status, 'BLOCKED');
});

test('estimate-is-not-measured-shoulder', () => {
  assert.equal(measuredShoulder({ source: 'estimate', measured: false, errorDeg: 0 }).status, 'BLOCKED');
  assert.equal(measuredShoulder({ source: 'pose', measured: true, errorDeg: 3 }).status, 'PASS');
  assert.equal(measuredShoulder({ source: 'pose', measured: true, errorDeg: 12 }).status, 'FAIL');
});

test('expected-rejection-is-not-product-success', () => {
  const negative = classifySample({ expected: 'reject', rejected: true, reasonCode: 'NO_FACE' });
  assert.equal(negative.status, 'PASS');
  assert.equal(negative.category, 'expected-rejection');
  assert.equal(classifySample({ expected: 'reject', rejected: true }).status, 'FAIL');
  assert.equal(classifySample({ expected: 'product', rejected: true }).status, 'FAIL');
});
