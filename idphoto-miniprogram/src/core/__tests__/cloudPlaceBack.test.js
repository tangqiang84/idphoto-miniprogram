/**
 * placeBack v2 + cleanCloudAlpha 单测（2026-10-27，问题台账 #66）
 *
 * 背景：v1 硬贴回（区域内云端 alpha / 区域外端侧 alpha 原样保留）在真机成品上
 * 露出矩形接缝——端侧在「需要上云的图」上恰恰不可信（墙面泥浆值 0.15~0.5 被当
 * 前景糊进成品）。v2 = 边界接触行/列门控 + 端侧 ≥0.5 阈值 + 区域内侧羽化 + scoremap 去斑。
 *
 * 真机复跑补充：只开门控不够——门打开后 0.15~0.5 的墙面泥浆仍以 ~35% 不透明度
 * 糊在成品底角，故保留区必须再卡「端侧 ≥0.5」一道阈值。
 */
const test = require('node:test');
const assert = require('node:assert');
const { placeBack, cleanCloudAlpha } = require('../mattingCloud');

const W = 100, H = 100;
// 上传区域：中央 60×80（x 20..79，y 10..89）
const CROP = { x: 20, y: 10, w: 60, h: 80, full: false };

/** 端侧 alpha：整图 0.4（纯泥浆墙面，无人体延续） */
function makeLocalMud() {
  const a = new Float32Array(W * H);
  for (let i = 0; i < a.length; i++) a[i] = 0.4;
  return a;
}

/**
 * 端侧 alpha：墙面泥浆 0.4；左侧（x<27，含区域左缘内侧羽化带）行 30..95 = 0.8
 * （人跨出区域的躯干延续），但行 60..79 故意留成 0.4（模拟「门开了但端侧还是泥浆」）。
 */
function makeLocalWithTorso() {
  const a = makeLocalMud();
  for (let y = 30; y <= 95; y++) for (let x = 0; x < 27; x++) a[y * W + x] = 0.8;
  for (let y = 60; y <= 79; y++) for (let x = 0; x < 27; x++) a[y * W + x] = 0.4;
  return a;
}

/** 云端子图 alpha：人形竖条（列 20..39、行 20..69），默认不接触任何边界 */
function makeCloudAlpha() {
  const a = new Float32Array(CROP.w * CROP.h);
  for (let y = 20; y < 70; y++) for (let x = 20; x < 40; x++) a[y * CROP.w + x] = 1;
  return a;
}

/** 云端子图 alpha：人形贴到区域左边界（列 0..39、行 20..69）→ 全图行 30..79 接触左边 */
function makeCloudTouchLeft() {
  const a = new Float32Array(CROP.w * CROP.h);
  for (let y = 20; y < 70; y++) for (let x = 0; x < 40; x++) a[y * CROP.w + x] = 1;
  return a;
}

test('区域外无人接触边界的行/列 → 端侧泥浆清零（墙面不再残留）', () => {
  const out = placeBack(makeLocalMud(), makeCloudAlpha(), CROP, W, H);
  for (let y = 0; y < H; y++) {
    assert.strictEqual(out[y * W + 5], 0, `左条带第 ${y} 行应清零（人未接触左边界）`);
  }
  for (let x = 0; x < W; x++) {
    assert.strictEqual(out[3 * W + x], 0, `顶条带第 ${x} 列应清零（人未接触顶边）`);
  }
});

test('人接触到的边界行 → 端侧强前景（≥0.5）保留并固化，躯干延续', () => {
  const out = placeBack(makeLocalWithTorso(), makeCloudTouchLeft(), CROP, W, H);
  // 接触行 y=50（区域行 40 ∈ 20..69），端侧 0.8 → 保留并固化 firm(0.8)=0.896
  assert.ok(out[50 * W + 5] > 0.7, `接触行应保留端侧前景（实际 ${out[50 * W + 5]}）`);
});

test('门开了但端侧是泥浆（<0.5）→ 仍清零（墙面不得借门控混入）', () => {
  const out = placeBack(makeLocalWithTorso(), makeCloudTouchLeft(), CROP, W, H);
  // 接触行 y=70（区域行 60 ∈ 20..69），但该带端侧被故意留成 0.4 → 阈值拦截
  assert.strictEqual(out[70 * W + 5], 0, '泥浆值即便在接触行也应清零');
});

test('接触行里的孤立强值斑点（墙面深色渍）→ 密度闸清零（不成片不留）', () => {
  const local = makeLocalMud();
  // 接触行 y=50 的左条带上撒 3 个孤立强斑点（0.9），周围全是泥浆
  local[50 * W + 5] = 0.9; local[52 * W + 8] = 0.9; local[48 * W + 11] = 0.9;
  const out = placeBack(local, makeCloudTouchLeft(), CROP, W, H);
  assert.strictEqual(out[50 * W + 5], 0, '孤立斑点应被密度闸清零');
  assert.strictEqual(out[52 * W + 8], 0, '孤立斑点应被密度闸清零');
});

test('端侧很强但云端说人没接触该边 → 清零（信任云端边界判断）', () => {
  const out = placeBack(makeLocalWithTorso(), makeCloudTouchLeft(), CROP, W, H);
  // y=90（区域行 80，超出接触行 20..69），端侧 0.8 也要清零
  assert.strictEqual(out[90 * W + 5], 0, '非接触行的端侧强前景应清零');
});

test('区域内远离边界处 = 云端 alpha 原值', () => {
  const out = placeBack(makeLocalMud(), makeCloudAlpha(), CROP, W, H);
  assert.strictEqual(out[50 * W + 50], 1, '区域内人形本体');
  assert.strictEqual(out[50 * W + 70], 0, '区域内背景');
});

test('羽化带：端侧可信时是混合过渡（无硬台阶）；端侧泥浆时不渗入', () => {
  // 端侧可信（0.8）：边界第 1px = 云端 1 与 firm(0.8)=0.896 的混合
  const out1 = placeBack(makeLocalWithTorso(), makeCloudTouchLeft(), CROP, W, H);
  const v1 = out1[50 * W + 20];
  assert.ok(v1 > 0.5 && v1 <= 1, `端侧可信时羽化带应为高值混合（实际 ${v1}）`);
  assert.strictEqual(out1[50 * W + 26], 1, '羽化带尽头 = 纯云端值');
  // 端侧泥浆（0.4）：混合目标被阈值清零 → 边界第 1px ≈ 云端值×小权重，泥浆不渗入
  const out2 = placeBack(makeLocalMud(), makeCloudTouchLeft(), CROP, W, H);
  const v2 = out2[50 * W + 20];
  assert.ok(v2 < 0.15, `端侧泥浆时羽化带应接近 0（实际 ${v2}）`);
});

test('颜色闸：延续部分与边界云端前景同色才保留（端侧数值不参与），墙色被拦', () => {
  // 云端：人（深蓝色）贴左边界，行 20..69 接触
  const cloud = makeCloudTouchLeft();
  // 端侧：左条带全是 0.4 泥浆（对齐真机实测：西装延续带端侧 alpha 仅 0.48~0.51，
  // 端侧根本分不开西装与墙——颜色才是可靠信号，延续带不得再依赖端侧数值）
  const local = makeLocalMud();
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 150; rgba[i * 4 + 1] = 155; rgba[i * 4 + 2] = 145; rgba[i * 4 + 3] = 255; }
  // 区域内左缘：云端前景处设为深蓝色（参考色来源）
  for (let y = 30; y <= 79; y++) for (let x = 20; x < 23; x++) {
    const i = (y * W + x) * 4; rgba[i] = 40; rgba[i + 1] = 45; rgba[i + 2] = 70;
  }
  // 左条带：行 30..55 深蓝（西装延续），行 56..95 墙色
  for (let y = 30; y <= 95; y++) for (let x = 0; x < 20; x++) {
    const i = (y * W + x) * 4;
    if (y <= 55) { rgba[i] = 42; rgba[i + 1] = 47; rgba[i + 2] = 72; }
    else { rgba[i] = 150; rgba[i + 1] = 155; rgba[i + 2] = 145; }
  }
  const out = placeBack(local, cloud, CROP, W, H, rgba);
  assert.ok(out[50 * W + 5] > 0.85, `同色延续带即便端侧是泥浆也应近不透明（实际 ${out[50 * W + 5]}）`);
  assert.strictEqual(out[70 * W + 5], 0, '墙色渍应被颜色闸清零');
});

test('crop.full → 直接返回云端 alpha（无需拼接）', () => {
  const cloud = new Float32Array(W * H).fill(0.7);
  const out = placeBack(makeLocalMud(), cloud, { x: 0, y: 0, w: W, h: H, full: true }, W, H);
  assert.strictEqual(out, cloud);
});

test('cleanCloudAlpha：孤立噪声清零，邻近人体的发丝过渡保留', () => {
  const w = 40, h = 40;
  const a = new Float32Array(w * h);
  // 中央 10×10 强前景块（人体）
  for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) a[y * w + x] = 1;
  // 孤立噪声斑：角落 0.3（远离人体）
  a[2 * w + 2] = 0.3; a[2 * w + 3] = 0.25; a[3 * w + 2] = 0.2;
  // 发丝过渡：紧邻强前景块的 0.3
  a[15 * w + 13] = 0.3; a[16 * w + 13] = 0.28;
  const out = cleanCloudAlpha(a, w, h);
  assert.strictEqual(out[2 * w + 2], 0, '孤立噪声斑应清零');
  assert.strictEqual(out[3 * w + 2], 0, '孤立噪声斑应清零');
  assert.ok(out[15 * w + 13] > 0.2, '发丝过渡带（邻近人体）应保留');
  assert.strictEqual(out[20 * w + 20], 1, '强前景本体不受影响');
});
