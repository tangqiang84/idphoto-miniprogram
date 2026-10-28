'use strict';
// suitDiff 单测（PRD D 章验收 / AC6）——换装前后脸部像素差异检测
const { test } = require('node:test');
const assert = require('node:assert');
const {
  compareFaceRegion,
  DEFAULT_MAX_CHANGED_RATIO,
  DEFAULT_CHANNEL_THRESHOLD,
} = require('../suitDiff');

const W = 100;
const H = 100;

/** 构造一张纯色图 */
function solid(w, h, v) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** 在矩形区域内改色（模拟「模板贴到脸上」） */
function paintRect(rgba, w, x, y, rw, rh, r, g, b) {
  for (let yy = y; yy < y + rh; yy++) {
    for (let xx = x; xx < x + rw; xx++) {
      const i = (yy * w + xx) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
    }
  }
  return rgba;
}

const FACE = { x: 30, y: 30, w: 40, h: 40 };

test('完全相同 → pass，且不产生变化', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  const r = compareFaceRegion(a, b, FACE, { width: W, height: H });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(r.total, 40 * 40);
  assert.strictEqual(r.changedRatio, 0);
  assert.strictEqual(r.maxDiff, 0);
  assert.strictEqual(r.reason, 'ok');
  assert.strictEqual(r.checked, true);
});

test('只有肩部变化（脸框外）→ pass，变化像素数为 0', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  paintRect(b, W, 0, 80, 100, 20, 10, 20, 30); // 肩部/下方区域改色
  const r = compareFaceRegion(a, b, FACE, { width: W, height: H });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(r.reason, 'ok');
});

test('脸上大面积变化 → 不通过', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  paintRect(b, W, 40, 40, 20, 20, 0, 0, 0); // 盖住半张脸
  const r = compareFaceRegion(a, b, FACE, { width: W, height: H });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.reason, 'face_changed');
  assert.strictEqual(r.changed, 400);
  assert.strictEqual(r.total, 1600);
  assert.ok(r.changedRatio > DEFAULT_MAX_CHANGED_RATIO);
  assert.strictEqual(r.maxDiff, 200);
});

test('脸部轻微变化（<阈值）→ 仍 pass', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  // 单通道差 20 < 24 → 不算显著变化
  paintRect(b, W, 40, 40, 5, 5, 180, 200, 200);
  const r = compareFaceRegion(a, b, FACE, { width: W, height: H });
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(r.pass, true);
});

test('脸部微小面积变化但超过比例阈值 → 不通过', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  // 1600 像素中改 100 个 = 6.25% > 2%
  paintRect(b, W, 40, 40, 10, 10, 0, 0, 0);
  const r = compareFaceRegion(a, b, FACE, { width: W, height: H });
  assert.strictEqual(r.changed, 100);
  assert.strictEqual(r.pass, false);
});

test('阈值边界：恰好等于 maxChangedRatio → pass（<=）', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  // 1600 像素改 32 个 = 2.0% = maxChangedRatio（画在脸框内 x∈[30,62)）
  paintRect(b, W, 30, 40, 32, 1, 0, 0, 0);
  const r = compareFaceRegion(a, b, FACE, { width: W, height: H });
  assert.strictEqual(r.changed, 32);
  assert.strictEqual(r.changedRatio, 0.02);
  assert.strictEqual(r.pass, true, '恰好等于阈值应判通过（<= 语义）');
});

test('单通道差恰为 24 → 不算显著变化；25 → 算', () => {
  const a = solid(W, H, 200);
  const b1 = new Uint8ClampedArray(a);
  paintRect(b1, W, 40, 40, 1, 1, 200 - 24, 200, 200);
  const r1 = compareFaceRegion(a, b1, FACE, { width: W, height: H });
  assert.strictEqual(r1.changed, 0, '差值 24 不大于阈值 24 → 不算显著变化');

  const b2 = new Uint8ClampedArray(a);
  paintRect(b2, W, 40, 40, 1, 1, 200 - 25, 200, 200);
  const r2 = compareFaceRegion(a, b2, FACE, { width: W, height: H });
  assert.strictEqual(r2.changed, 1, '差值 25 > 阈值 24 → 算显著变化');
  assert.strictEqual(r2.maxDiff, 25);
});

test('脸框为空 → pass + 原因码 no_face_rect（不得静默当不通过）', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  const r = compareFaceRegion(a, b, null, { width: W, height: H });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.reason, 'no_face_rect');
  assert.strictEqual(r.checked, false);
  assert.strictEqual(r.changed, 0);
  assert.ok(r.detail.includes('脸'), '应如实说明未做比对的原因');
});

test('越界脸框 → pass + 原因码 no_face_rect', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  const r = compareFaceRegion(a, b, { x: 80, y: 80, w: 60, h: 60 }, { width: W, height: H });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.reason, 'no_face_rect');
  assert.strictEqual(r.checked, false);
  assert.ok(r.detail.includes('超出'), '应说明是越界');
});

test('面积为 0 的脸框 → pass + 原因码 no_face_rect', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  const r = compareFaceRegion(a, b, { x: 10, y: 10, w: 0, h: 20 }, { width: W, height: H });
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.reason, 'no_face_rect');
  assert.strictEqual(r.checked, false);
});

test('自定义阈值生效（maxChangedRatio / channelThreshold）', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  paintRect(b, W, 40, 40, 20, 20, 0, 0, 0);
  // 放宽比例阈值到 30% → pass
  const loose = compareFaceRegion(a, b, FACE, { width: W, height: H, maxChangedRatio: 0.3 });
  assert.strictEqual(loose.pass, true);
  // 收紧通道阈值到 10 → 差值 20 也算变化 → 比例 25% > 2% → 不通过
  const strict = compareFaceRegion(a, b, FACE, { width: W, height: H, channelThreshold: 10 });
  assert.strictEqual(strict.changed, 400);
  assert.strictEqual(strict.pass, false);
});

test('换装前后长度不一致 → 不比对（size_mismatch）', () => {
  const a = solid(W, H, 200);
  const b = solid(W, H, 200).slice(0, 1000);
  const r = compareFaceRegion(a, b, FACE, { width: W, height: H });
  assert.strictEqual(r.checked, false);
  assert.strictEqual(r.reason, 'size_mismatch');
  assert.strictEqual(r.pass, true);
});

test('可通过 faceRect.imageWidth/imageHeight 推断尺寸', () => {
  const a = solid(W, H, 200);
  const b = new Uint8ClampedArray(a);
  paintRect(b, W, 40, 40, 20, 20, 0, 0, 0);
  const r = compareFaceRegion(a, b, { x: 30, y: 30, w: 40, h: 40, imageWidth: W, imageHeight: H });
  assert.strictEqual(r.checked, true);
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.total, 1600);
});

// ---------- 与真实换装合成链路联动的集成测试 ----------
// 目的：证明本模块真能检出「西装模板覆盖到脸上」这个具体事故（PRD D 章验收 AC6），
//      而不是一个只在人造像素上成立的空壳。

/** 造一个「人像」：上半身是前景（alpha=1），头部区域给一张脸 */
function personCanvas(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const alpha = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inHead = y < h * 0.5;
      rgba[i] = inHead ? 200 : 150; // 头：亮肤色；身：暗一点
      rgba[i + 1] = inHead ? 165 : 120;
      rgba[i + 2] = inHead ? 145 : 100;
      rgba[i + 3] = 255;
      alpha[y * w + x] = 1; // 整个人都是前景
    }
  }
  return { rgba, alpha };
}

/** 造一块纯色不透明西装模板 */
function template(w, h) {
  const tpl = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    tpl[i * 4] = 40;
    tpl[i * 4 + 1] = 45;
    tpl[i * 4 + 2] = 70;
    tpl[i * 4 + 3] = 255;
  }
  return tpl;
}

test('集成：西装模板盖到脸上 → 检出 face_changed（不通过）', () => {
  const { suitCompose } = require('../suit');
  const IW = 100;
  const IH = 100;
  const { rgba, alpha } = personCanvas(IW, IH);
  const tplW = 40;
  const tplH = 40;
  const tpl = template(tplW, tplH);
  // 放置框顶太靠上 → 模板盖住脸（复现 suit.js 注释里的 #69 事故）
  const after = suitCompose(rgba, alpha, IW, IH, tpl, tplW, tplH, { x: 30, y: 20, w: 40, h: 40 }, 0);
  const faceRect = { x: 30, y: 25, w: 40, h: 25 };
  const r = compareFaceRegion(rgba, after, faceRect, { width: IW, height: IH });
  assert.strictEqual(r.checked, true);
  assert.strictEqual(r.pass, false, '模板盖脸必须被判不通过');
  assert.strictEqual(r.reason, 'face_changed');
  assert.ok(r.changed > 0);
});

test('集成：西装模板正常贴在肩上 → 脸部零变化（通过）', () => {
  const { suitCompose } = require('../suit');
  const IW = 100;
  const IH = 100;
  const { rgba, alpha } = personCanvas(IW, IH);
  const tplW = 40;
  const tplH = 40;
  const tpl = template(tplW, tplH);
  // 放置框顶在脖子以下 → 完全不碰脸
  const after = suitCompose(rgba, alpha, IW, IH, tpl, tplW, tplH, { x: 30, y: 62, w: 40, h: 40 }, 0);
  const faceRect = { x: 30, y: 25, w: 40, h: 25 };
  const r = compareFaceRegion(rgba, after, faceRect, { width: IW, height: IH });
  assert.strictEqual(r.checked, true);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.changed, 0, '不碰脸时脸部像素必须完全不变');
  assert.strictEqual(r.maxDiff, 0);
});

