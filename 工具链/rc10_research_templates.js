'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { decodePNG, encodePNG } = require('../idphoto-miniprogram/cloudfunctions/matting/png');
const { SPECS, getPixelSize } = require('../idphoto-miniprogram/src/core/specLibrary');
const { fitSuitV2 } = require('../idphoto-miniprogram/src/core/suitFitV2');
const { suitCompose } = require('../idphoto-miniprogram/src/core/suit');

const root = path.resolve(__dirname, '..');
const inventory = require('../docs/验证记录/RC-10-template-audit-20261121-01/inventory.json');

// 自动几何仅供离线研究，不作为肩峰/领口人工标定或生产验收结果。
function draftGeometry(png) {
  let top = png.height, left = png.width, right = -1, bottom = -1;
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    if (png.data[(y * png.width + x) * 4 + 3] < 128) continue;
    top = Math.min(top, y); bottom = Math.max(bottom, y);
    left = Math.min(left, x); right = Math.max(right, x);
  }
  assert.ok(right > left && bottom > top, '模板必须含有效衣身像素');
  const unit = 400 / png.width;
  return { width: 400, height: png.height * unit, shoulderWidthPx: (right - left + 1) * unit,
    shoulderY: (top + (bottom - top) * 0.25) * unit, collarTopY: top * unit,
    collarVy: (top + (bottom - top) * 0.3) * unit };
}

function run(output) {
  fs.mkdirSync(output, { recursive: false });
  const cases = [], templates = [];
  for (const record of inventory) {
    const bytes = fs.readFileSync(path.join(root, '素材/正装模板', record.name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), record.sha256, '原图摘要发生变化');
    const png = decodePNG(bytes), geometry = draftGeometry(png);
    assert.equal(png.width, record.width); assert.equal(png.height, record.height);
    const id = record.name.match(/_(\d+)\.png$/)[1];
    templates.push({ id, file: record.name, sha256: record.sha256, native: {width: png.width, height: png.height},
      usage: 'research-only-user-directed', approval: 'research-candidate', geometrySource: 'alpha-bounds-draft', geometry });
    for (const spec of SPECS) for (const dpi of [300, 600]) {
      const { width: w, height: h } = getPixelSize(spec, dpi);
      const headH = h * (spec.headHeightRatioMin + spec.headHeightRatioMax) / 2;
      const crownY = h * 0.06, chinY = crownY + headH;
      const face = { source: 'landmarks', quality: 'good', faceCount: 1, headH, crownY, chinY,
        faceCenterX: w / 2, rect: { x: w * 0.33, y: crownY, w: w * 0.34, h: headH } };
      const pose = { personCount: 1, points: [
        {name: 'left_shoulder', x: w * 0.12, y: h * 0.88, score: 0.9},
        {name: 'right_shoulder', x: w * 0.88, y: h * 0.88, score: 0.9},
      ] };
      const fit = fitSuitV2({ spec, canvasW: w, canvasH: h, face, pose, template: geometry });
      assert.equal(fit.ok, true, `${id}/${spec.id}/${dpi}: ${fit.reason}`);
      const before = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) before.set([180, 205, 225, 255], i * 4);
      const alpha = new Float32Array(w * h).fill(1), protectUntilY = Math.ceil(chinY);
      const out = suitCompose(before, alpha, w, h, png.data, png.width, png.height,
        fit.place, fit.rotateDeg, { protectUntilY });
      assert.deepEqual(out.subarray(0, protectUntilY * w * 4), before.subarray(0, protectUntilY * w * 4));
      let changed = 0;
      for (let i = protectUntilY * w * 4; i < out.length; i += 4)
        if (out[i] !== before[i] || out[i + 1] !== before[i + 1] || out[i + 2] !== before[i + 2]) changed++;
      assert.ok(changed > 0, '模板必须实际参与合成');
      const filename = `${id}-${spec.id}-${dpi}-synthetic.png`;
      fs.writeFileSync(path.join(output, filename), encodePNG(out, w, h), { flag: 'wx' });
      cases.push({ template: id, spec: spec.id, dpi, signalSource: 'synthetic-fixture',
        result: 'PASS', protectedPixelChanges: 0, garmentChangedPixels: changed, file: filename });
    }
  }
  fs.writeFileSync(path.join(output, 'research-report.json'), JSON.stringify({
    time: new Date().toISOString(), usage: 'research-only-user-directed', provider: 'local-suitFitV2-suitCompose',
    actualPortraitReview: 'NOT_EXECUTED', productionApproval: false, templates, cases,
  }, null, 2) + '\n', { flag: 'wx' });
  return { templates: templates.length, cases: cases.length, result: 'PASS', output };
}

if (require.main === module) {
  const traceId = crypto.randomUUID();
  try {
    assert.ok(process.argv[2], '需要唯一的新输出目录');
    console.log(JSON.stringify(run(path.resolve(process.argv[2]))));
  } catch (error) {
    console.error(JSON.stringify({ traceId, stage: 'research-templates', internalCode: error.code || 'RESEARCH_CHECK_FAILED' }));
    console.log(JSON.stringify({ ok: false, code: 'RESEARCH_CHECK_FAILED', message: '研究素材检查失败，请检查输入、输出目录和断言记录', traceId }));
    process.exitCode = 1;
  }
}
module.exports = { draftGeometry, run };
