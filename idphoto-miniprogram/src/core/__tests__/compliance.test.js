'use strict';
// compliance 预审引擎单测：底色 HEX/key 双形态 + KB 区间（含下限）
//
// 覆盖的真实缺口：
//   1) 底色项按 key 比对，调用方传 HEX → 换底色后永远误判不通过（严重·合规 BUG）；
//   2) 文件大小只判上限，缺下限 → 3KB 空图能「通过」（PRD 8.1 区间 20KB–200KB）。
const { test } = require('node:test');
const assert = require('node:assert');
const { check } = require('../compliance');
const { getSpec, listSpecs, getPixelSize, BG, bgKeyOf, hexOfBgKey } = require('../specLibrary');

/** 一寸规格的合规基准测量值 */
function oneInchMeasured(over) {
  return Object.assign(
    { widthPx: 295, heightPx: 413, dpi: 300, fileKb: 80, bg: 'white' },
    over || {},
  );
}

function findCheck(res, key) {
  return res.checks.find((c) => c.key === key);
}

// ---------- 底色：key 形式（既有行为，零回归） ----------

test('底色 key 形式：一寸 + white → 底色项通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: 'white' }));
  const c = findCheck(r, 'bg');
  assert.strictEqual(c.pass, true);
  assert.strictEqual(r.pass, true);
});

test('底色 key 形式：一寸 + blue → 底色项通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: 'blue' }));
  assert.strictEqual(findCheck(r, 'bg').pass, true);
});

test('底色 key 形式：一寸 + gray（不在允许列表）→ 底色项不通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: 'gray' }));
  const c = findCheck(r, 'bg');
  assert.strictEqual(c.pass, false);
  assert.strictEqual(r.pass, false);
  assert.ok(r.suggestions.includes('底色'));
});

test('底色 key 形式：驾驶证 + blue（仅允许 white）→ 不通过', () => {
  const r = check('driver-license', {
    widthPx: 260, heightPx: 378, dpi: 300, fileKb: 80, bg: 'blue',
  });
  assert.strictEqual(findCheck(r, 'bg').pass, false);
});

// ---------- 底色：HEX 形式（本次修复的 BUG） ----------

test('底色 HEX 形式：measured.bg = "#438EDB" → 一寸（允许 blue）→ 通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: '#438EDB' }));
  const c = findCheck(r, 'bg');
  assert.strictEqual(c.pass, true, '深蓝 HEX 必须能匹配 blue');
  assert.strictEqual(r.pass, true);
});

test('底色 HEX 形式（大小写混写）："#438edb" → 通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: '#438edb' }));
  assert.strictEqual(findCheck(r, 'bg').pass, true);
  assert.strictEqual(r.pass, true);
});

test('底色 HEX 形式："#00BFF3"（浅蓝 blueLight）→ 一寸允许 → 通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: '#00BFF3' }));
  assert.strictEqual(findCheck(r, 'bg').pass, true);
});

test('底色 HEX 形式："#00bff3"（大小写混写）→ 通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: '#00bff3' }));
  assert.strictEqual(findCheck(r, 'bg').pass, true);
});

test('底色 HEX 形式："#FFFFFF" → 驾驶证（仅 white）→ 通过', () => {
  const r = check('driver-license', {
    widthPx: 260, heightPx: 378, dpi: 300, fileKb: 80, bg: '#FFFFFF',
  });
  assert.strictEqual(findCheck(r, 'bg').pass, true);
});

test('底色 HEX 形式：不匹配色 "#123456" → 不通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: '#123456' }));
  const c = findCheck(r, 'bg');
  assert.strictEqual(c.pass, false);
  assert.strictEqual(r.pass, false);
});

test('底色 HEX 形式：标准灰 "#C0C0C0" 传给一寸（不含 gray）→ 不通过', () => {
  const r = check('one-inch', oneInchMeasured({ bg: '#C0C0C0' }));
  assert.strictEqual(findCheck(r, 'bg').pass, false);
});

test('底色 HEX 形式：美签（仅 white）传深蓝 "#438EDB" → 不通过', () => {
  const r = check('visa-us', {
    widthPx: 600, heightPx: 600, dpi: 300, fileKb: 120, bg: '#438EDB',
  });
  assert.strictEqual(findCheck(r, 'bg').pass, false);
});

test('底色：非字符串（null / undefined）→ 不通过且不抛异常', () => {
  const r = check('one-inch', oneInchMeasured({ bg: null }));
  assert.strictEqual(findCheck(r, 'bg').pass, false);
  const r2 = check('one-inch', oneInchMeasured({ bg: undefined }));
  assert.strictEqual(findCheck(r2, 'bg').pass, false);
});

test('bgKeyOf / hexOfBgKey 互为反查（色值表单一来源）', () => {
  Object.keys(BG).forEach((k) => {
    assert.strictEqual(bgKeyOf(BG[k]), k, `${BG[k]} 应反查到 ${k}`);
    assert.strictEqual(bgKeyOf(BG[k].toLowerCase()), k, 'HEX 应大小写不敏感');
    assert.strictEqual(hexOfBgKey(k), BG[k]);
  });
  assert.strictEqual(bgKeyOf('#123456'), null);
  assert.strictEqual(hexOfBgKey('nope'), null);
});

// ---------- 文件大小：下限 ----------

test('KB 下限：3KB 空图 → 文件大小项不通过', () => {
  const r = check('one-inch', oneInchMeasured({ fileKb: 3 }));
  const c = findCheck(r, 'filesize');
  assert.strictEqual(c.pass, false);
  assert.strictEqual(r.pass, false);
  assert.ok(r.suggestions.includes('文件大小'));
  assert.ok(c.detail.includes('下限'), '应说明是下限问题');
});

test('KB 下限：20KB 恰好达标 → 通过', () => {
  const r = check('one-inch', oneInchMeasured({ fileKb: 20 }));
  assert.strictEqual(findCheck(r, 'filesize').pass, true);
  assert.strictEqual(r.pass, true);
});

test('KB 下限：19KB → 不通过（差 1KB 也不行）', () => {
  const r = check('one-inch', oneInchMeasured({ fileKb: 19 }));
  assert.strictEqual(findCheck(r, 'filesize').pass, false);
});

test('KB 上限：201KB → 不通过（上限逻辑未被下限改动破坏）', () => {
  const r = check('one-inch', oneInchMeasured({ fileKb: 201 }));
  assert.strictEqual(findCheck(r, 'filesize').pass, false);
});

test('KB 区间：200KB（上限）→ 通过', () => {
  const r = check('one-inch', oneInchMeasured({ fileKb: 200 }));
  assert.strictEqual(findCheck(r, 'filesize').pass, true);
});

test('KB 下限按规格区分：美国签证 54KB → 30KB 不通过、54KB 通过', () => {
  const r30 = check('visa-us', {
    widthPx: 600, heightPx: 600, dpi: 300, fileKb: 30, bg: 'white',
  });
  assert.strictEqual(findCheck(r30, 'filesize').pass, false);
  const r54 = check('visa-us', {
    widthPx: 600, heightPx: 600, dpi: 300, fileKb: 54, bg: 'white',
  });
  assert.strictEqual(findCheck(r54, 'filesize').pass, true);
});

test('KB 下限：600dpi 档仍是 advisory（只提示不阻断）', () => {
  // 600dpi 的目标像素是一寸的 2 倍（尺寸项要跟着变，否则尺寸项先挂掉）
  const px = getPixelSize('one-inch', 600);
  const r = check('one-inch', {
    widthPx: px.width, heightPx: px.height, dpi: 600, fileKb: 500, bg: 'white',
  });
  const c = findCheck(r, 'filesize');
  assert.strictEqual(c.level, 'advisory');
  assert.strictEqual(c.pass, false, '600dpi 下体积超限是事实');
  assert.strictEqual(r.pass, true, 'advisory 项不参与 pass 计算');
  assert.ok(!r.suggestions.includes('文件大小'), 'advisory 项不进 suggestions');
});

test('KB：未测量到 fileKb → 跳过该项，不误伤', () => {
  const r = check('one-inch', {
    widthPx: 295, heightPx: 413, dpi: 300, bg: 'white',
  });
  const c = findCheck(r, 'filesize');
  assert.strictEqual(c.pass, true);
  assert.ok(c.detail.includes('未测量'));
});

// ---------- 规格库：minKb 字段 ----------

test('规格库：每条规格都有 minKb（通用 20KB / 美签 54KB）', () => {
  for (const s of listSpecs()) {
    assert.strictEqual(typeof s.minKb, 'number', `${s.id} 缺 minKb`);
    assert.ok(s.minKb > 0 && s.minKb <= s.maxKb, `${s.id} 的 minKb/maxKb 区间不合法`);
  }
  assert.strictEqual(getSpec('one-inch').minKb, 20);
  assert.strictEqual(getSpec('visa-us').minKb, 54);
});
