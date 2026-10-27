'use strict';
// tightBBox / suitPlacement 几何单测（问题台账 #69，2026-10-27）
//
// 背景：T3 AI 换装真机复现「西装盖脸 + 原衬衫外露 + 变形」三连缺陷，
// 根因是 estimate 路径下 place.y = bbox.y + 0.85*headH 恒小于 chinY（必盖脸），
// 且 alphaBBox 的 min/max 被云端 alpha 噪声前景撑爆（111.jpg bbox 满宽）。
// 本文件锁定修复口径：投影收紧 + chinY 锚定 + 宽 clamp + 延伸到人体框底。

const test = require('node:test');
const assert = require('node:assert');
const { alphaBBox, tightBBox, estimateHeadByShoulder, suitPlacement } = require('../suit');

// 构造「人体在中央 + 两侧零星噪声前景」的 alpha（模拟 111.jpg 云端 alpha 满宽爆框）
function makePersonWithSideNoise(W, H) {
  const a = new Float32Array(W * H);
  // 人体：x 30%~70%，y 15%~100%（头顶到图底）
  for (let y = Math.round(H * 0.15); y < H; y++) {
    for (let x = Math.round(W * 0.30); x < Math.round(W * 0.70); x++) {
      a[y * W + x] = 1;
    }
  }
  // 左侧噪声：x 0~8% 的中间一溜（每列前景高约 8% → 低于 COL_FILL 0.15）
  for (let y = Math.round(H * 0.4); y < Math.round(H * 0.48); y++) {
    for (let x = 0; x < Math.round(W * 0.08); x++) a[y * W + x] = 0.9;
  }
  // 右侧噪声：x 92%~100%
  for (let y = Math.round(H * 0.55); y < Math.round(H * 0.63); y++) {
    for (let x = Math.round(W * 0.92); x < W; x++) a[y * W + x] = 0.9;
  }
  // 顶部噪声：头顶上方一行零星点（每行前景占比 < ROW_FILL）
  for (let x = Math.round(W * 0.45); x < Math.round(W * 0.55); x++) a[2 * W + x] = 0.9;
  return a;
}

test('tightBBox：抗侧向/顶部噪声，框住人体连续段', () => {
  const W = 200, H = 300;
  const a = makePersonWithSideNoise(W, H);
  const raw = alphaBBox(a, W, H);
  const tight = tightBBox(a, W, H);
  assert.ok(raw && tight, '两者都应返回非 null');
  // raw 被噪声撑到满宽（左右各一溜）
  assert.strictEqual(raw.x, 0, 'raw 左缘被噪声拉到 0（撑爆）');
  assert.strictEqual(raw.w, W, 'raw 宽被撑到满宽（撑爆）');
  // tight 收紧到人体段：x≈30%W，宽≈40%W（容忍段端点 1px 与投影取整误差）
  assert.ok(tight.x >= 55 && tight.x <= 62, `tight 左缘应≈30%W（实际 ${tight.x}）`);
  assert.ok(tight.w >= 76 && tight.w <= 84, `tight 宽应≈40%W（实际 ${tight.w}）`);
  // 顶：raw 被拉到 y=2（顶部噪声行），tight 应≈15%H
  assert.ok(tight.y >= 43 && tight.y <= 47, `tight 顶应≈15%H（实际 ${tight.y}）`);
  assert.strictEqual(tight.y + tight.h, H, 'tight 底应到图底（人体连续到图底）');
});

test('tightBBox：干净人体（无噪声）与 alphaBBox 一致', () => {
  const W = 120, H = 160;
  const a = new Float32Array(W * H);
  for (let y = 24; y < H; y++) for (let x = 25; x < 95; x++) a[y * W + x] = 1;
  const raw = alphaBBox(a, W, H);
  const tight = tightBBox(a, W, H);
  assert.deepStrictEqual(tight, raw);
});

test('tightBBox：全背景返回 null（无有效段）', () => {
  const a = new Float32Array(50 * 60);
  assert.strictEqual(tightBBox(a, 50, 60), null);
  // 零星噪声不成段（每列占比都低于阈值）
  for (let x = 0; x < 50; x += 3) a[10 * 50 + x] = 0.9;
  assert.strictEqual(tightBBox(a, 50, 60), null);
});

test('tightBBox：段内小间隙不切段（衣领镂空/头发分叉）', () => {
  const W = 100, H = 100;
  const a = new Float32Array(W * H);
  // 人体列 40~59，但 y=50 处开 3px 间隙（占比 3% < 2% 上限内的容忍？gapMax=2，3>2 会切）
  // 用 2px 间隙验证「容忍 ≤2px」：不应切段
  for (let y = 20; y < H; y++) {
    for (let x = 40; x < 60; x++) {
      if (y >= 50 && y <= 51) continue; // 2px 间隙
      a[y * W + x] = 1;
    }
  }
  const tight = tightBBox(a, W, H);
  assert.ok(tight, '2px 间隙不应切段');
  assert.strictEqual(tight.y, 20);
  assert.strictEqual(tight.y + tight.h, H);
});

// ---- #69 真实场景回归（数据来自 2026-10-27 模拟器 suit_geometry 审计）----

test('#69 回归：111.jpg 场景（bbox 曾被撑到满宽 600×677）', () => {
  const bbox = { x: 0, y: 121, w: 600, h: 677 }; // 云端 alpha 撑爆后的 bbox（审计实测）
  const headH = bbox.h * 0.30;                    // estimate：203.1
  const chinY = bbox.y + headH;                   // estimate：324.1
  const place = suitPlacement(bbox, headH, chinY, 600);
  // 旧口径 place.y = 121+0.85*203 = 293.6 < chinY 324 → 盖脸 30px（真机复现）
  assert.ok(place.y > chinY + 10, `西装顶(${place.y})应在下巴(${chinY})下方 ≥10px`);
  // 西装宽 clamp 到画布 600（旧口径 1.5*600=900 爆画布）
  assert.strictEqual(place.w, 600);
  // 西装延伸至人体框底（旧口径 0.55*677=372 盖不住 → 衬衫外露）
  assert.ok(place.y + place.h >= 121 + 677, '西装底应 ≥ 人体框底');
});

test('#69 回归：123.png 场景（bbox 几乎整图 295×413）', () => {
  const bbox = { x: 0, y: 0, w: 295, h: 413 }; // 云端 fg=0.95，整图判前景（审计实测）
  const headH = bbox.h * 0.30;                // 123.9
  const chinY = bbox.y + headH;               // 123.9
  const place = suitPlacement(bbox, headH, chinY, 295);
  // 旧口径 place.y = 0+0.85*123.9 = 105.3 < chinY 123.9 → 只露额头（真机复现）
  assert.ok(place.y > chinY + 10, `西装顶(${place.y})应在下巴(${chinY})下方 ≥10px`);
  assert.strictEqual(place.w, 295);
  assert.ok(place.y + place.h >= 413, '西装底应到人体框底');
});

test('#69 回归：landmarks 路径（真实 chinY）与 estimate 路径行为一致', () => {
  // landmarks：headH=真实头长、chinY=实测下巴 → 顶=下巴+0.1 头长（脖子根）
  const p1 = suitPlacement({ x: 42, y: 33, w: 117, h: 267 }, 80, 113, 200);
  assert.ok(Math.abs(p1.y - 121) < 1e-9, '真实下巴 113 + 0.1*80 = 121');
  // estimate：headH=0.3*bbox.h、chinY=bbox.y+headH → 顶=bbox.y+1.1*headH
  const p2 = suitPlacement({ x: 42, y: 33, w: 117, h: 267 }, 80.1, 33 + 80.1, 200);
  assert.ok(Math.abs(p2.y - (33 + 80.1 + 8.01)) < 1e-9, 'estimate 顶=bbox.y+1.1*headH');
});

// ---- estimateHeadByShoulder 肩线法（换装专用头长估计）----

// 构造人体 alpha：头顶行宽 headW，从 y0+headH 起加宽到肩宽（1.8×headW）
function makeBody(W, H, y0, headW, headH, shoulderRatio) {
  const a = new Float32Array(W * H);
  const shoulderW = Math.min(W, Math.round(headW * shoulderRatio));
  const headX0 = Math.round((W - headW) / 2);
  const shoulderX0 = Math.round((W - shoulderW) / 2);
  for (let y = y0; y < H; y++) {
    const isHead = y < y0 + headH;
    const w = isHead ? headW : shoulderW;
    const x0 = isHead ? headX0 : shoulderX0;
    for (let x = x0; x < x0 + w; x++) a[y * W + x] = 1;
  }
  return a;
}

test('肩线法：标准半身构图（头顶 60px 宽、头长 180）', () => {
  const W = 200, H = 300;
  const a = makeBody(W, H, 30, 60, 180, 1.8);
  const bbox = { x: 40, y: 30, w: 108, h: 270 };
  const r = estimateHeadByShoulder(a, W, H, bbox);
  assert.ok(r, '应找到肩线');
  assert.ok(Math.abs(r.headH - 180) <= 3, `头长应≈180（实际 ${r.headH}）`);
  // estimate 口径对照：0.3*270=81 → 肩线法修正是它的 2.2 倍
  assert.ok(r.headH > 81 * 1.8, '肩线法头长应显著大于 estimate 口径');
});

test('肩线法：胸像特写（images(3) 场景——estimate 曾低估一半盖眼）', () => {
  // images(3)：500×333 横图，人占满，真实头长≈189，estimate 给 99.9
  const W = 385, H = 333;
  const a = makeBody(W, H, 0, 150, 189, 1.8);
  const bbox = { x: 0, y: 0, w: 385, h: 333 };
  const r = estimateHeadByShoulder(a, W, H, bbox);
  assert.ok(r, '应找到肩线');
  assert.ok(r.headH >= 180 && r.headH <= 200, `胸像头长应≈189（实际 ${r.headH}）`);
  const estHead = 333 * 0.3; // 99.9
  assert.ok(r.headH > estHead * 1.6, '胸像下肩线法必须显著大于 estimate（修复盖眼）');
  // 修正后 place.y = 肩线 + 0.1×headH ≈ 189+19 = 208 ≈ 真实颈根；眼睛≈150 → 不盖脸
  const place = suitPlacement(bbox, r.headH, r.shoulderY, W);
  assert.ok(place.y > 150, `西装顶(${place.y})应在眼睛(~150)下方`);
});

test('肩线法：远景全身（头占人体小、estimate 会高估）', () => {
  const W = 200, H = 400;
  const a = makeBody(W, H, 40, 40, 100, 1.8); // 头顶 40 宽、头长 100、人体到图底
  const bbox = { x: 50, y: 40, w: 80, h: 360 };
  const r = estimateHeadByShoulder(a, W, H, bbox);
  assert.ok(r, '应找到肩线');
  assert.ok(Math.abs(r.headH - 100) <= 3, `远景头长应≈100（实际 ${r.headH}）`);
});

test('肩线法：爆炸头（头顶宽≈肩宽）→ null 回退 estimate', () => {
  const W = 200, H = 300;
  const a = new Float32Array(W * H);
  // 头顶就 170 宽（爆炸头），肩线 175 —— 1.6× 突变不存在
  for (let y = 30; y < H; y++) {
    const w = y < 200 ? 170 : 175;
    const x0 = Math.round((W - w) / 2);
    for (let x = x0; x < x0 + w; x++) a[y * W + x] = 1;
  }
  const bbox = { x: 12, y: 30, w: 176, h: 270 };
  assert.strictEqual(estimateHeadByShoulder(a, W, H, bbox), null);
});

test('肩线法：侧向噪声不撑行宽（抗噪）', () => {
  const W = 200, H = 300;
  const a = makeBody(W, H, 30, 60, 180, 1.8);
  // 左右各加一溜噪声（每行 3px，低于 1.6×60=96 阈值）
  for (let y = 100; y < 260; y++) { a[y * W] = 0.9; a[y * W + 199] = 0.9; }
  const bbox = { x: 40, y: 30, w: 108, h: 270 };
  const r = estimateHeadByShoulder(a, W, H, bbox);
  assert.ok(r && Math.abs(r.headH - 180) <= 3, '噪声不应影响肩线判定');
});

test('肩线法：贴头皮短发（111.jpg 教训——头顶几行窄不能当中位数取样）', () => {
  // 111.jpg：短发贴头皮，头顶 10 行只有 30px 宽，之后脸/头展开到 100，肩 180
  // 旧口径「头顶 5 行中位数」=30 → 1.6×30=48 → 脸宽 100 秒触发 → headH≈57 → 盖眼
  const W = 300, H = 400;
  const a = new Float32Array(W * H);
  for (let y = 128; y < H; y++) {
    let w, x0;
    if (y < 138) { w = 30; x0 = 135; }           // 发茬 10 行
    else if (y < 308) { w = 100; x0 = 100; }    // 脸/头 180px
    else { w = 180; x0 = 60; }                  // 肩
    for (let x = x0; x < x0 + w; x++) a[y * W + x] = 1;
  }
  const bbox = { x: 38, y: 128, w: 262, h: 272 };
  const r = estimateHeadByShoulder(a, W, H, bbox);
  assert.ok(r, '应找到肩线');
  assert.ok(r.headH >= 170 && r.headH <= 195, `头长应≈180（实际 ${r.headH}）`);
  const place = suitPlacement(bbox, r.headH, r.shoulderY, W);
  assert.ok(place.y > 300, `西装顶(${place.y})应在真实下巴(~308)下方`);
});
