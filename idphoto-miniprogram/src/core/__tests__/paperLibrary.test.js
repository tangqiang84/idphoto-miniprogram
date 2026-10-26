const test = require('node:test');
const assert = require('node:assert');

const L = require('../paperLibrary');
const sp = require('../specLibrary');

// 关键回归（T6 冲印排版）：
// planLayout 的 bestTiling 会尝试 paperRotated（纸张旋转）以最大化平铺，
// 返回的 cols/rows 是「旋转坐标系」下算的。合成时必须同步旋转画布与 print 区，
// 否则坐标系错配 → 照片溢出 print 区、绘制数 ≠ count（曾发生的真实 bug）。
// 本测试用「与 pages/tool-print/index.tsx 完全一致的几何公式」复算，断言不越界且绘制数 == count。
test('planLayout + 合成几何：常规平铺不越界且绘制数==count（含 paperRotated 旋转，回归）', () => {
  const cases = [
    ['paper-5in', 'one-inch'], ['paper-6in', 'one-inch'], ['paper-6in', 'two-inch'],
    ['paper-7in', 'small-two-inch'], ['paper-8in', 'one-inch'], ['paper-10in', 'big-two-inch'],
    ['paper-12in', 'one-inch'], ['paper-12in', 'two-inch'],
    ['selphy-postcard', 'one-inch'], ['selphy-card', 'two-inch'],
    ['zink-2x3', 'one-inch'], ['zink-2.3x3.4', 'one-inch'],
  ];
  const DM = L.DEFAULT_MARGIN_MM, DG = L.DEFAULT_GAP_MM;
  for (const [p, s] of cases) {
    const paper = L.getPaper(p), spec = sp.getSpec(s);
    const lay = L.planLayout(p, s);
    assert.ok(lay && lay.count > 0, `${p}/${s} 应可容纳`);
    const sheet = lay.sheetPx;
    // 与合成完全一致的朝向处理
    const canvasW = lay.paperRotated ? sheet.height : sheet.width;
    const canvasH = lay.paperRotated ? sheet.width : sheet.height;
    const printWpx = L.mmToPx(lay.paperRotated ? paper.printHeightMm : paper.printWidthMm, paper.dpi);
    const printHpx = L.mmToPx(lay.paperRotated ? paper.printWidthMm : paper.printHeightMm, paper.dpi);
    const ox = (canvasW - printWpx) / 2, oy = (canvasH - printHpx) / 2;
    const fwpMm = lay.photoRotated ? spec.heightMm : spec.widthMm;
    const fhpMm = lay.photoRotated ? spec.widthMm : spec.heightMm;
    const fwp = L.mmToPx(fwpMm, paper.dpi), fhp = L.mmToPx(fhpMm, paper.dpi);
    const gap = L.mmToPx(DG, paper.dpi), margin = L.mmToPx(DM, paper.dpi);
    let drawn = 0, oob = 0;
    if (!paper.tileable) {
      drawn = 1;
    } else {
      assert.ok(lay.cols >= 1 && lay.rows >= 1, `${p}/${s} cols/rows 应 >=1`);
      for (let r = 0; r < lay.rows; r++) {
        for (let c = 0; c < lay.cols; c++) {
          const dx = ox + margin + c * (fwp + gap);
          const dy = oy + margin + r * (fhp + gap);
          if (dx < ox - 1 || dy < oy - 1 || dx + fwp > ox + printWpx + 1 || dy + fhp > oy + printHpx + 1) oob++;
          else drawn++;
        }
      }
    }
    assert.strictEqual(oob, 0, `${p}/${s} 不应有越界 tile（合成坐标系须与 paperRotated 一致）`);
    assert.strictEqual(drawn, lay.count, `${p}/${s} 绘制数应 == count`);
  }
});

test('planLayout：全景组合 count 合理', () => {
  assert.strictEqual(L.planLayout('paper-6in', 'one-inch').count, 10);
  assert.strictEqual(L.planLayout('paper-12in', 'one-inch').count, 72);
  assert.strictEqual(L.planLayout('paper-6in', 'two-inch').count, 4);
  assert.strictEqual(L.planLayout('selphy-postcard', 'one-inch').count, 10);
});

test('planLayout：不可拼版（instax / 方形贴纸）每版仅 1 张并带白边提示', () => {
  const a = L.planLayout('instax-mini', 'one-inch');
  assert.strictEqual(a.count, 1);
  assert.strictEqual(a.tileable, false);
  assert.ok(a.note && a.note.includes('每版仅 1 张'));

  const b = L.planLayout('selphy-sticker-square', 'one-inch');
  assert.strictEqual(b.count, 1);
  assert.strictEqual(b.tileable, false);
});

test('planLayout：容纳失败返回 count=0 与提示（签证 + instax-mini）', () => {
  const lay = L.planLayout('instax-mini', 'visa-us');
  assert.strictEqual(lay.count, 0);
  assert.ok(lay.note && lay.note.includes('无法容纳'));
});

test('listPapers：常规 7 种 + 迷你 9 种，共 16 种', () => {
  const all = L.listPapers();
  assert.strictEqual(all.length, 16);
  const regular = all.filter((p) => p.category === 'regular');
  const mini = all.filter((p) => p.category === 'mini');
  assert.strictEqual(regular.length, 7);
  assert.strictEqual(mini.length, 9);
});

test('getPaper：返回完整字段（printWidthMm / dpi / tileable / source）', () => {
  const p = L.getPaper('paper-6in');
  assert.strictEqual(p.paperWidthMm, 152);
  assert.strictEqual(p.printWidthMm, 148);
  assert.strictEqual(p.dpi, 300);
  assert.strictEqual(p.tileable, true);
  assert.ok(typeof p.source === 'string' && p.source.length > 0);
});
