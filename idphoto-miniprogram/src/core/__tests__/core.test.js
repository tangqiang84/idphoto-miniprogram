const test = require('node:test');
const assert = require('node:assert');

const { getSpec, getPixelSize, listSpecs, BG } = require('../specLibrary');
const { check } = require('../compliance');
const { decideRoute, CONF_THRESHOLD, localMatting, estimateQuality, composite, compositeTransparent } = require('../matting');
const { requiredConsents, buildConsentRecord } = require('../privacy');
const { alphaBBox, suitPlacement, suitCompose } = require('../suit');
const {
  FACE_LENGTH_RATIO, HEAD_BBOX_RATIO, MIN_LANDMARK_COUNT,
  percentile, isValidPoints, pointsWithinImage,
  faceVerticalSpan, pickPrimaryFace,
  headMetricsFromLandmarks, headMetricsFromBBox,
  ratioWithinWindow, analyzeFace,
} = require('../face');
const { planOutput, planWindowOutput, planDetectImage, clampScale, MIN_WORK_EDGE, MAX_WORK_EDGE, DETECT_EDGE } = require('../compose');
const { planHeadCrop, targetHeadRatio, HEAD_TOP_GAP_RATIO, CHIN_BOTTOM_GAP_RATIO } = require('../headCrop');
const { collectEdgeSamples, runClassicalFallback, preprocess: preprocessLocal } = require('../mattingLocal');
const {
  listModelSpecs, getModelSpec, normalizeSpec, preprocess, postprocess,
  verifyWeight, resolveWeightFileName, shouldDownload,
  resolveModelPlan, shouldRetryDownload,
} = require('../mattingModel');

test('规格库：一寸 300dpi 像素正确 (25mm→295, 35mm→413)', () => {
  const px = getPixelSize('one-inch', 300);
  assert.strictEqual(px.width, 295);
  assert.strictEqual(px.height, 413);
});

test('规格库：二寸 像素正确 (35mm→413, 49mm→579)', () => {
  const px = getPixelSize('two-inch', 300);
  assert.strictEqual(px.width, 413);
  assert.strictEqual(px.height, 579);
});

test('规格库：美国签证 2×2 英寸精确 → 600×600px（官方 DS-160 硬指标）', () => {
  const px = getPixelSize('visa-us', 300);
  assert.strictEqual(px.width, 600);
  assert.strictEqual(px.height, 600);
  // 600dpi 时翻倍
  const pxHd = getPixelSize('visa-us', 600);
  assert.strictEqual(pxHd.width, 1200);
  assert.strictEqual(pxHd.height, 1200);
});

test('规格库：中国护照 33×48mm → 390×567px（国家移民管理局口径）', () => {
  const px = getPixelSize('passport-cn', 300);
  assert.strictEqual(px.width, 390);
  assert.strictEqual(px.height, 567);
});

test('规格库：驾驶证 22×32mm → 260×378px（公安部令172号）', () => {
  const px = getPixelSize('driver-license', 300);
  assert.strictEqual(px.width, 260);
  assert.strictEqual(px.height, 378);
  const spec = getSpec('driver-license');
  assert.deepStrictEqual(spec.bg, ['white']); // 驾照要求白底
});

test('规格库：listSpecs 返回 9 项（含新增驾驶证）', () => {
  assert.strictEqual(listSpecs().length, 9);
  assert.ok(listSpecs().some((s) => s.id === 'driver-license'));
});

test('规格库：每条规格都带官方来源标注 source', () => {
  const { SPECS } = require('../specLibrary');
  SPECS.forEach((s) => {
    assert.ok(typeof s.source === 'string' && s.source.length > 0, `${s.id} 缺 source`);
  });
});

test('规格库：蓝底双轨色值正确（深蓝 #438EDB / 浅蓝 #00BFF3）', () => {
  assert.strictEqual(BG.blue, '#438EDB');
  assert.strictEqual(BG.blueLight, '#00BFF3');
  assert.strictEqual(BG.white, '#FFFFFF');
  assert.strictEqual(BG.red, '#FF0000');
  assert.strictEqual(BG.gray, '#C0C0C0');
});

test('规格库：头占比为显式区间字段（不再用基准±0.05 推导）', () => {
  const p = getSpec('passport-cn');
  assert.strictEqual(p.headHeightRatioMin, 0.58);
  assert.strictEqual(p.headHeightRatioMax, 0.69);
  assert.strictEqual(p.headHeightRatio, undefined); // 旧字段已移除
});

test('规格库：一寸/小一寸 KB 上限为 200（对齐 PRD 20~200KB 区间）', () => {
  assert.strictEqual(getSpec('one-inch').maxKb, 200);
  assert.strictEqual(getSpec('small-one-inch').maxKb, 200);
});

test('合规引擎：合格输入 pass=true 且无建议', () => {
  const r = check('one-inch', {
    widthPx: 295, heightPx: 413, dpi: 300, fileKb: 45, bg: 'white', headHeightRatio: 0.66,
  });
  assert.strictEqual(r.pass, true);
  assert.deepStrictEqual(r.suggestions, []);
});

test('合规引擎：底色不符 pass=false', () => {
  const r = check('one-inch', { widthPx: 295, heightPx: 413, dpi: 300, fileKb: 45, bg: 'green' });
  assert.strictEqual(r.pass, false);
  assert.strictEqual(r.checks.find((c) => c.key === 'bg').pass, false);
});

test('合规引擎：尺寸偏差超容差 fail', () => {
  const r = check('one-inch', { widthPx: 320, heightPx: 413, dpi: 300, fileKb: 45, bg: 'white' });
  assert.strictEqual(r.checks.find((c) => c.key === 'dimension').pass, false);
});

test('合规引擎：dpi 不足 fail', () => {
  const r = check('one-inch', { widthPx: 295, heightPx: 413, dpi: 150, fileKb: 45, bg: 'white' });
  assert.strictEqual(r.checks.find((c) => c.key === 'dpi').pass, false);
});

test('合规引擎：文件超限 fail', () => {
  const r = check('one-inch', { widthPx: 295, heightPx: 413, dpi: 300, fileKb: 500, bg: 'white' });
  assert.strictEqual(r.checks.find((c) => c.key === 'filesize').pass, false);
});

test('合规引擎：头占比按显式区间判定（护照 58%~69%）', () => {
  // 63% → 护照区间内 → 通过
  const ok = check('passport-cn', {
    widthPx: 390, heightPx: 567, dpi: 300, fileKb: 80, bg: 'white', headHeightRatio: 0.63,
  });
  assert.strictEqual(ok.checks.find((c) => c.key === 'head').pass, true);
  // 72% → 超出官方上限 → 不通过（旧推导式会误判为通过）
  const bad = check('passport-cn', {
    widthPx: 390, heightPx: 567, dpi: 300, fileKb: 80, bg: 'white', headHeightRatio: 0.72,
  });
  assert.strictEqual(bad.checks.find((c) => c.key === 'head').pass, false);
});

test('合规引擎：未提供头占比则跳过该项（不判不通过）', () => {
  const r = check('passport-cn', { widthPx: 390, heightPx: 567, dpi: 300, fileKb: 80, bg: 'white' });
  assert.strictEqual(r.checks.find((c) => c.key === 'head'), undefined);
  assert.strictEqual(r.pass, true);
});

test('合规引擎：蓝底双轨——深蓝与浅蓝分别判定', () => {
  const deep = check('one-inch', { widthPx: 295, heightPx: 413, dpi: 300, fileKb: 45, bg: 'blue' });
  assert.strictEqual(deep.checks.find((c) => c.key === 'bg').pass, true);
  const light = check('one-inch', { widthPx: 295, heightPx: 413, dpi: 300, fileKb: 45, bg: 'blueLight' });
  assert.strictEqual(light.checks.find((c) => c.key === 'bg').pass, true);
});

test('合规引擎：驾照要求白底，蓝底不合规', () => {
  const r = check('driver-license', { widthPx: 260, heightPx: 378, dpi: 300, fileKb: 45, bg: 'blue' });
  assert.strictEqual(r.checks.find((c) => c.key === 'bg').pass, false);
});

test('合规引擎：美国签证 600×600 判定通过', () => {
  const r = check('visa-us', { widthPx: 600, heightPx: 600, dpi: 300, fileKb: 120, bg: 'white', headHeightRatio: 0.55 });
  assert.strictEqual(r.pass, true);
});

test('路由：置信≥0.85 走端侧，低于走云端', () => {
  assert.strictEqual(decideRoute(0.9), 'edge');
  assert.strictEqual(decideRoute(CONF_THRESHOLD), 'edge');
  assert.strictEqual(decideRoute(0.84), 'cloud');
  // 任务 #51：forceCloud —— 调用方可强制上云（置信高 ≠ 质量好：复杂背景上端侧可能"自信地抠错"）
  assert.strictEqual(decideRoute(0.99, true), 'cloud');
  assert.strictEqual(decideRoute(0.5, true), 'cloud');
  assert.strictEqual(decideRoute(0.99, false), 'edge');
});

test('质量评估：干净 alpha（无歧义）→ 置信=1，走端侧', () => {
  // 30% 前景(1) + 70% 背景(0)，无中间值
  const n = 1000, alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) alpha[i] = i < 300 ? 1 : 0;
  const q = estimateQuality(alpha);
  assert.strictEqual(q.ambiguousRatio, 0);
  assert.ok(q.confidence >= 0.999);
  assert.strictEqual(decideRoute(q.confidence), 'edge');
});

test('质量评估：高歧义 alpha（全 0.5）→ 置信=0，走云端', () => {
  const n = 1000, alpha = new Float32Array(n).fill(0.5);
  const q = estimateQuality(alpha);
  assert.strictEqual(q.ambiguousRatio, 1);
  assert.strictEqual(q.confidence, 0);
  assert.strictEqual(decideRoute(q.confidence), 'cloud');
});

test('本地抠图：无 session 走经典基线，输出长度=w*h', async () => {
  const w = 32, h = 32;
  // 居中主体（不贴边），四周为背景，符合"边缘=背景"假设（真实证件照人物居中）
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const fg = x >= 8 && x < 24 && y >= 8 && y < 24;
    rgba[i] = fg ? 220 : 90; rgba[i + 1] = fg ? 180 : 110; rgba[i + 2] = fg ? 150 : 140; rgba[i + 3] = 255;
  }
  const res = await localMatting(rgba, w, h);
  assert.strictEqual(res.backend, 'classical');
  assert.strictEqual(res.alpha.length, w * h);
  // 居中主体区域应判为前景(alpha≥0.5)
  let fgCount = 0, total = 0;
  for (let x = 8; x < 24; x++) for (let y = 8; y < 24; y++) { total++; if (res.alpha[y * w + x] >= 0.5) fgCount++; }
  assert.ok(fgCount > total * 0.8, '居中主体大部分应被判为前景');
});

test('合成换底：composite 将前景按 alpha 混到目标底色', () => {
  const w = 2, h = 1;
  const rgba = new Uint8ClampedArray([200, 50, 50, 255, 200, 50, 50, 255]);
  const alpha = new Float32Array([1, 0]); // 第1像素全前景，第2像素全背景
  const out = composite(rgba, alpha, w, h, '#0000ff');
  // 第1像素：原色(200,50,50) 全保留
  assert.deepStrictEqual([out[0], out[1], out[2]], [200, 50, 50]);
  // 第2像素：alpha=0 → 完全底色蓝(0,0,255)
  assert.deepStrictEqual([out[4], out[5], out[6]], [0, 0, 255]);
});

test('规格库：BG 含标准灰底 #C0C0C0（PRD 8.1 R192 G192 B192）', () => {
  assert.strictEqual(BG.gray, '#C0C0C0');
});

test('透明底合成：compositeTransparent 保留前景色与 alpha 通道（PRD C3）', () => {
  const w = 2, h = 1;
  const rgba = new Uint8ClampedArray([200, 50, 50, 255, 200, 50, 50, 255]);
  // 半透明 alpha=0.5 → A=127~128；全背景 alpha=0 → A=0
  const out = compositeTransparent(rgba, new Float32Array([1, 0.5]), w, h);
  // 前景像素：RGB 原样保留，A=255
  assert.deepStrictEqual([out[0], out[1], out[2], out[3]], [200, 50, 50, 255]);
  // 半透明像素：RGB 保留，A≈127（0.5*255 取整）
  assert.deepStrictEqual([out[4], out[5], out[6]], [200, 50, 50]);
  assert.ok(out[7] === 127 || out[7] === 128, `A 应为 127/128，实际 ${out[7]}`);
});

test('透明底合成：alpha 越界值被截断到 [0,1]', () => {
  const w = 2, h = 1;
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 255]);
  const out = compositeTransparent(rgba, new Float32Array([-0.5, 1.5]), w, h);
  assert.strictEqual(out[3], 0); // -0.5 → 0
  assert.strictEqual(out[7], 255); // 1.5 → 255
});

test('隐私：T3 换装需三项同意，缺一项 ready=false', () => {
  const need = requiredConsents('T3').map((c) => c.id);
  assert.deepStrictEqual(need, ['faceLocal', 'faceCloudEnhance', 'suitSwap']);
  const rec = buildConsentRecord('T3', ['faceLocal', 'faceCloudEnhance']);
  assert.strictEqual(rec.ready, false);
  assert.deepStrictEqual(rec.missing, ['suitSwap']);
});

test('隐私：T4 合规检测只需本地处理', () => {
  const need = requiredConsents('T4').map((c) => c.id);
  assert.deepStrictEqual(need, ['faceLocal']);
});

test('隐私：T5 规格转换无需任何人脸授权', () => {
  assert.deepStrictEqual(requiredConsents('T5'), []);
});

// ===================== 上云增强链路 =====================
const { cloudMatting, makeLocalBiRefStub, assertDomestic, cropForeground } = require('../mattingCloud');

function makeImg(w, h, fgBlock) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const fg = fgBlock(x, y);
    rgba[i] = fg ? 220 : 90; rgba[i + 1] = fg ? 180 : 110; rgba[i + 2] = fg ? 150 : 140; rgba[i + 3] = 255;
  }
  return rgba;
}
function blockAlpha(w, h, x0, x1, y0, y1) {
  const a = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 1;
  return a;
}

test('上云增强：缺少 faceCloudEnhance 授权抛 AC5 阻断(不静默降级)', async () => {
  const w = 64, h = 64;
  const rgba = makeImg(w, h, (x, y) => x >= 20 && x < 44 && y >= 20 && y < 44);
  await assert.rejects(
    cloudMatting({ rgba, alpha: new Float32Array(w * h), width: w, height: h, adapter: makeLocalBiRefStub(), consents: [], tool: 'T1' }),
    /AC5/,
  );
});

test('上云增强：跨境 endpoint 被 fail-closed 阻断（数据不出境）', () => {
  assert.throws(() => assertDomestic('https://us-east-1.example.com/matting', []), /非境内/);
  assert.throws(() => assertDomestic('https://x.com/matting', []), /非境内/);
  assert.doesNotThrow(() => assertDomestic('https://cn-gpu-fn.example.cn/matting', ['cn-gpu-fn.example.cn']));
});

test('上云增强：授权齐全 + 本地 stub 跑通链路，返回 cloud alpha', async () => {
  const w = 64, h = 64;
  const rgba = makeImg(w, h, (x, y) => x >= 20 && x < 44 && y >= 20 && y < 44);
  const alpha = (await localMatting(rgba, w, h)).alpha; // 端侧真实初值（含软边过渡），更贴近实际链路
  const rec = [];
  const res = await cloudMatting({ rgba, alpha, width: w, height: h, adapter: makeLocalBiRefStub(), consents: ['faceCloudEnhance'], audit: (m) => rec.push(m) });
  assert.strictEqual(res.backend, 'cloud');
  assert.strictEqual(res.alpha.length, w * h);
  assert.strictEqual(res.degraded, false);
  assert.ok(rec.some((m) => m.stage === 'cloud_ok'));
});

test('上云增强：审计日志不含任何像素数据(AC8)', async () => {
  const w = 64, h = 64;
  const rgba = makeImg(w, h, (x, y) => x >= 20 && x < 44 && y >= 20 && y < 44);
  const alpha = blockAlpha(w, h, 20, 44, 20, 44);
  const rec = [];
  await cloudMatting({ rgba, alpha, width: w, height: h, adapter: makeLocalBiRefStub(), consents: ['faceCloudEnhance'], audit: (m) => rec.push(m) });
  assert.ok(rec.length > 0);
  for (const m of rec) {
    assert.strictEqual(m.hasPixel, false);
    assert.ok(!('image' in m) && !('rgba' in m) && !('pixel' in m));
  }
});

test('上云增强：裁剪只上传人像区域(非全图)', () => {
  const w = 64, h = 64;
  const rgba = makeImg(w, h, (x, y) => x >= 20 && x < 44 && y >= 20 && y < 44);
  const alpha = blockAlpha(w, h, 20, 44, 20, 44);
  const crop = cropForeground(rgba, alpha, w, h, 8);
  assert.strictEqual(crop.full, false);
  assert.ok(crop.w < w && crop.h < h, '子图应小于全图');
});

test('上云增强：adapter 调用失败 → 降级端侧(degraded=true)', async () => {
  const w = 64, h = 64;
  const rgba = makeImg(w, h, (x, y) => x >= 20 && x < 44 && y >= 20 && y < 44);
  const alpha = blockAlpha(w, h, 20, 44, 20, 44);
  const failing = { endpoint: 'https://cn-gpu-fn.example.cn/matting', trustedHosts: ['cn-gpu-fn.example.cn'], async call() { throw new Error('network'); } };
  const rec = [];
  const res = await cloudMatting({ rgba, alpha, width: w, height: h, adapter: failing, consents: ['faceCloudEnhance'], audit: (m) => rec.push(m) });
  assert.strictEqual(res.degraded, true);
  assert.strictEqual(res.backend, 'cloud->edge');
  assert.ok(rec.some((m) => m.stage === 'cloud_fail'));
});

test('换装：alphaBBox 框出前景包围盒', () => {
  const w = 6, h = 4;
  const alpha = new Float32Array(w * h);
  // 前景：x∈[1,4], y∈[1,2]
  for (let y = 1; y <= 2; y++) for (let x = 1; x <= 4; x++) alpha[y * w + x] = 1;
  const bbox = alphaBBox(alpha, w, h);
  assert.deepStrictEqual(bbox, { x: 1, y: 1, w: 4, h: 2 });
});

test('换装：全背景 alphaBBox 返回 null', () => {
  assert.strictEqual(alphaBBox(new Float32Array(8), 4, 2), null);
});

test('换装：suitPlacement chinY 锚定 + 延伸到人体框底（#69 修复口径）', () => {
  const bbox = { x: 40, y: 20, w: 100, h: 200 };
  const headH = 60;
  const chinY = 110; // 真实下巴（landmarks 或 estimate 推算）
  const p = suitPlacement(bbox, headH, chinY);
  assert.ok(Math.abs(p.w - 150) < 1e-9); // 100*1.5 肩宽
  assert.ok(Math.abs(p.y - (110 + 6)) < 1e-9); // 西装顶 = 下巴 + 0.1*headH（脖子根）
  assert.ok(Math.abs(p.h - (20 + 200 - 116)) < 1e-9); // 延伸到人体框底（不再 0.55 系数）
  assert.ok(Math.abs(p.x - (40 + 50 - 75)) < 1e-9); // 水平居中
});

test('换装：suitPlacement 无 chinY 时按 estimate 定义（chinY=bbox.y+headH）', () => {
  const bbox = { x: 0, y: 100, w: 200, h: 400 };
  const headH = 120; // 0.3*400
  const p = suitPlacement(bbox, headH);
  assert.ok(Math.abs(p.y - (100 + 120 + 12)) < 1e-9); // bbox.y+headH+0.1*headH
  assert.ok(Math.abs(p.h - (100 + 400 - 232)) < 1e-9); // 到框底
});

test('换装：suitPlacement 宽度 clamp 到 maxW（防 bbox 噪声撑宽爆画布）', () => {
  const bbox = { x: 0, y: 121, w: 600, h: 677 };
  const headH = 203;
  const p = suitPlacement(bbox, headH, 324, 600);
  assert.strictEqual(p.w, 600); // 1.5*600=900 → clamp 到画布宽 600
});

test('换装：suitPlacement 缺参抛错', () => {
  assert.throws(() => suitPlacement(null, 60), /bbox/);
  assert.throws(() => suitPlacement({ x: 0, y: 0, w: 1, h: 1 }, 0), /headH/);
});

test('换装：#69 回归——estimate 路径下西装顶必须在下巴下方（旧口径必然盖脸）', () => {
  // 旧口径：place.y = bbox.y + 0.85*headH，estimate 的 headH=0.3*bbox.h
  // → place.y - chinY = -0.045*bbox.h < 0 恒盖脸；新口径必须 > chinY
  const bbox = { x: 0, y: 121, w: 600, h: 677 }; // 111.jpg 实测
  const headH = bbox.h * 0.30;
  const chinY = bbox.y + headH; // estimate 定义
  const p = suitPlacement(bbox, headH, chinY, 600);
  assert.ok(p.y > chinY, `西装顶(${p.y})应在下巴(${chinY})下方`);
  // 脸部（chinY 到 chinY-0.74*headH）完全不被 place.y 触及
  const faceTop = chinY - 0.74 * headH;
  assert.ok(p.y > faceTop + (chinY - faceTop), '西装顶应在整张脸以下');
});

test('换装：suitCompose 只覆盖前景区且不改输入', () => {
  const w = 4, h = 2;
  const rgba = new Uint8ClampedArray([10, 10, 10, 255, 20, 20, 20, 255, 30, 30, 30, 255, 40, 40, 40, 255]);
  const alpha = new Float32Array([1, 1, 0, 0]); // 仅前 2 像素是人体
  const tplW = 2, tplH = 1;
  // 模板全部不透明，RGB=99
  const tpl = new Uint8ClampedArray([99, 99, 99, 255, 99, 99, 99, 255]);
  const place = { x: 0, y: 0, w: 4, h: 1 };
  const out = suitCompose(rgba, alpha, w, h, tpl, tplW, tplH, place);
  assert.strictEqual(out[0], 99); // 前景区被模板覆盖
  assert.strictEqual(out[4], 99);
  assert.strictEqual(out[8], 30); // 背景区原样
  assert.strictEqual(out[12], 40);
  assert.strictEqual(rgba[0], 10); // 输入未被修改
});

test('换装：suitCompose 模板透明处不覆盖', () => {
  const w = 2, h = 1;
  const rgba = new Uint8ClampedArray([10, 10, 10, 255, 20, 20, 20, 255]);
  const alpha = new Float32Array([1, 1]);
  const tpl = new Uint8ClampedArray([99, 99, 99, 255, 50, 50, 50, 0]); // 第 2 像素模板透明
  const out = suitCompose(rgba, alpha, w, h, tpl, 2, 1, { x: 0, y: 0, w: 2, h: 1 });
  assert.strictEqual(out[0], 99);
  assert.strictEqual(out[4], 20); // 模板透明 → 保留原色
});

// ==================== 人脸定位（任务 #4） ====================

// 构造一张合成的 106 点人脸点集：脸部轮廓从 topY 到 bottomY，左右各铺点
function makeFacePoints(topY, bottomY, cx = 100, halfW = 30, n = 106) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    // 交替铺在左右两侧，y 从 topY 线性到 bottomY
    const t = n > 1 ? i / (n - 1) : 0;
    const y = topY + (bottomY - topY) * t;
    const x = i % 2 === 0 ? cx - halfW : cx + halfW;
    pts.push({ x, y });
  }
  return pts;
}

test('人脸定位：percentile 取分位数', () => {
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.strictEqual(percentile(a, 0), 1);
  assert.strictEqual(percentile(a, 1), 10);
  assert.strictEqual(percentile(a, 0.5), 6);
  assert.strictEqual(percentile([], 0.5), null);
});

test('人脸定位：isValidPoints 校验点数与坐标', () => {
  assert.strictEqual(isValidPoints(makeFacePoints(10, 100)), true);
  assert.strictEqual(isValidPoints([]), false);
  assert.strictEqual(isValidPoints(null), false);
  // 点数不足
  assert.strictEqual(isValidPoints(new Array(MIN_LANDMARK_COUNT - 1).fill({ x: 1, y: 1 })), false);
  // 坐标非有限数
  const bad = makeFacePoints(10, 100);
  bad[0].x = NaN;
  assert.strictEqual(isValidPoints(bad), false);
});

test('人脸定位：pointsWithinImage 检出坐标系异常', () => {
  const pts = makeFacePoints(10, 100);
  assert.strictEqual(pointsWithinImage(pts, 200, 200), true);
  // 远超图像边界 → 坐标系异常
  const bad = makeFacePoints(10, 100).map((p) => ({ x: p.x * 100, y: p.y * 100 }));
  assert.strictEqual(pointsWithinImage(bad, 200, 200), false);
});

test('人脸定位：faceVerticalSpan 取上下沿，正常点集零偏差', () => {
  const pts = makeFacePoints(20, 120);
  const span = faceVerticalSpan(pts);
  assert.ok(span);
  // 最高/最低关键点本身就是发际线上沿与下巴 → 不应被裁剪（避免系统性低估脸长）
  assert.strictEqual(span.topY, 20);
  assert.strictEqual(span.bottomY, 120);
  assert.strictEqual(span.span, 100);
});

test('人脸定位：faceVerticalSpan 剔除孤立飞点但不误伤正常点', () => {
  // 底部加一个孤立飞点（比真实下巴低 200px）→ 应被剔除
  const pts = makeFacePoints(20, 120).concat([{ x: 100, y: 320 }]);
  const span = faceVerticalSpan(pts);
  assert.ok(span);
  assert.strictEqual(span.bottomY, 120);
  assert.strictEqual(span.topY, 20);
  assert.strictEqual(span.span, 100);
});

test('人脸定位：faceVerticalSpan 顶部孤立飞点同样被剔除', () => {
  const pts = makeFacePoints(20, 120).concat([{ x: 100, y: -180 }]);
  const span = faceVerticalSpan(pts);
  assert.ok(span);
  assert.strictEqual(span.topY, 20);
  assert.strictEqual(span.bottomY, 120);
});

test('人脸定位：faceVerticalSpan 对无效输入返回 null', () => {
  assert.strictEqual(faceVerticalSpan(null), null);
  assert.strictEqual(faceVerticalSpan([]), null);
  // 全部点同高 → 跨度为 0
  const flat = new Array(20).fill({ x: 5, y: 50 });
  assert.strictEqual(faceVerticalSpan(flat), null);
});

test('人脸定位：pickPrimaryFace 取人脸框面积最大者', () => {
  const faces = [
    { points: makeFacePoints(10, 60), rect: { x: 0, y: 0, width: 50, height: 50 } },
    { points: makeFacePoints(10, 120), rect: { x: 0, y: 0, width: 100, height: 100 } },
    { points: makeFacePoints(10, 40), rect: { x: 0, y: 0, width: 20, height: 20 } },
  ];
  const p = pickPrimaryFace(faces);
  assert.strictEqual(p.rect.width, 100);
  assert.strictEqual(pickPrimaryFace([]), null);
  assert.strictEqual(pickPrimaryFace(null), null);
});

test('人脸定位：pickPrimaryFace 无 rect 时按关键点包围盒比较', () => {
  const faces = [
    { points: makeFacePoints(10, 60, 50, 10) },
    { points: makeFacePoints(10, 120, 50, 40) },
  ];
  const p = pickPrimaryFace(faces);
  assert.ok(p);
  // 第二个脸更大（半宽 40 > 10）
  assert.ok(p.points[0].x !== faces[0].points[0].x);
});

test('人脸定位：headMetricsFromLandmarks 头长 = 脸长 ÷ FACE_LENGTH_RATIO', () => {
  const pts = makeFacePoints(20, 120); // 脸长 100
  const m = headMetricsFromLandmarks({ points: pts, imageWidth: 200, imageHeight: 200 });
  assert.ok(m);
  assert.strictEqual(m.source, 'landmarks');
  assert.strictEqual(m.faceSpanPx, 100);
  // 头长比脸长长（头顶在发际线之上）
  assert.ok(Math.abs(m.headLengthPx - m.faceSpanPx / FACE_LENGTH_RATIO) < 1e-9);
  // 下巴 = 关键点最低点
  assert.strictEqual(m.chinY, 120);
  // 头顶在发际线之上
  assert.ok(m.crownY < 20);
});

test('人脸定位：头长占比与官方区间可比（整图口径）', () => {
  // 目标：一寸 61%~71%；构造一个头长占比约 65% 的场景
  const imgH = 400;
  const headLen = imgH * 0.65;
  const faceLen = headLen * FACE_LENGTH_RATIO;
  const bottomY = 300;
  const topY = bottomY - faceLen;
  const pts = makeFacePoints(topY, bottomY, 100, 30);
  const m = headMetricsFromLandmarks({ points: pts, imageWidth: 200, imageHeight: imgH });
  const r = ratioWithinWindow(m, { x: 0, y: 0, width: 200, height: imgH });
  assert.ok(r);
  assert.ok(Math.abs(r.ratio - 0.65) < 0.01, `占比应为 65% 附近，实际 ${(r.ratio * 100).toFixed(1)}%`);
  assert.ok(r.ratio >= 0.61 && r.ratio <= 0.71);
});

test('人脸定位：脸在画面中过小 → 质量降级为 low', () => {
  const pts = makeFacePoints(180, 200); // 脸长仅 20，图高 400 → 5%
  const m = headMetricsFromLandmarks({ points: pts, imageWidth: 200, imageHeight: 400 });
  assert.ok(m);
  assert.strictEqual(m.quality, 'low');
  assert.ok(m.notes.some((n) => n.includes('过小')));
});

test('人脸定位：人脸框与关键点不自洽 → 质量降级', () => {
  const pts = makeFacePoints(20, 120);
  // rect 高度远大于脸长（相差 5 倍）→ 不自洽
  const m = headMetricsFromLandmarks({
    points: pts, rect: { x: 0, y: 0, width: 60, height: 500 }, imageWidth: 200, imageHeight: 200,
  });
  assert.ok(m);
  assert.strictEqual(m.quality, 'low');
  assert.ok(m.notes.some((n) => n.includes('不自洽')));
});

test('人脸定位：头顶超出画面上边界 → 给出提示', () => {
  const pts = makeFacePoints(2, 120);
  const m = headMetricsFromLandmarks({ points: pts, imageWidth: 200, imageHeight: 200 });
  assert.ok(m);
  assert.ok(m.crownY < 0);
  assert.ok(m.notes.some((n) => n.includes('头顶超出')));
});

test('人脸定位：坐标系异常（点远超边界）返回 null', () => {
  const pts = makeFacePoints(20, 120).map((p) => ({ x: p.x * 50, y: p.y * 50 }));
  assert.strictEqual(headMetricsFromLandmarks({ points: pts, imageWidth: 200, imageHeight: 200 }), null);
});

test('人脸定位：缺少图像尺寸返回 null', () => {
  assert.strictEqual(headMetricsFromLandmarks({ points: makeFacePoints(20, 120) }), null);
});

test('人脸定位：headMetricsFromBBox 降级估算（几何口径）', () => {
  const bbox = { x: 10, y: 20, w: 100, h: 200 };
  const m = headMetricsFromBBox({ bbox, imageWidth: 200, imageHeight: 400 });
  assert.ok(m);
  assert.strictEqual(m.source, 'estimate');
  assert.strictEqual(m.quality, 'estimated');
  assert.ok(Math.abs(m.headLengthPx - bbox.h * HEAD_BBOX_RATIO) < 1e-9);
  assert.ok(m.notes.some((n) => n.includes('不支持人脸检测')));
});

test('人脸定位：headMetricsFromBBox 缺参返回 null', () => {
  assert.strictEqual(headMetricsFromBBox({}), null);
  assert.strictEqual(headMetricsFromBBox({ bbox: { x: 0, y: 0, w: 10, h: 0 }, imageWidth: 10, imageHeight: 10 }), null);
});

test('人脸定位：ratioWithinWindow 按裁剪窗口换算占比', () => {
  const imgH = 400;
  const headLen = imgH * 0.5;
  const faceLen = headLen * FACE_LENGTH_RATIO;
  const pts = makeFacePoints(300 - faceLen, 300, 100, 30);
  const m = headMetricsFromLandmarks({ points: pts, imageWidth: 200, imageHeight: imgH });
  // 取下半部分窗口（高 200）→ 头顶在窗口外，只按可见部分算
  const win = { x: 0, y: 200, width: 200, height: 200 };
  const r = ratioWithinWindow(m, win);
  assert.ok(r);
  assert.strictEqual(r.clamped, true);
  // 可见头长 = 下巴(300) − 窗口顶(200) = 100 → 100/200 = 50%
  assert.ok(Math.abs(r.ratio - 0.5) < 0.01);
});

test('人脸定位：ratioWithinWindow 缺参返回 null', () => {
  assert.strictEqual(ratioWithinWindow(null, { x: 0, y: 0, width: 10, height: 10 }), null);
  assert.strictEqual(ratioWithinWindow({ crownY: 0, chinY: 5 }, null), null);
  assert.strictEqual(ratioWithinWindow({ crownY: 0, chinY: 5 }, { x: 0, y: 0, width: 10, height: 0 }), null);
});

test('人脸定位：analyzeFace 优先关键点，失败降级包围盒估算', () => {
  // 有关键点 → 走实测
  const pts = makeFacePoints(20, 120);
  const a1 = analyzeFace({ points: pts, imageWidth: 200, imageHeight: 200 });
  assert.strictEqual(a1.ok, true);
  assert.strictEqual(a1.metrics.source, 'landmarks');
  assert.ok(a1.ratio > 0);

  // 无关键点但有 bbox → 走估算
  const a2 = analyzeFace({ bbox: { x: 10, y: 20, w: 100, h: 200 }, imageWidth: 200, imageHeight: 400 });
  assert.strictEqual(a2.ok, true);
  assert.strictEqual(a2.metrics.source, 'estimate');

  // 两者都无 → 失败
  const a3 = analyzeFace({ imageWidth: 200, imageHeight: 200 });
  assert.strictEqual(a3.ok, false);
  assert.strictEqual(a3.ratio, null);
});

test('人脸定位：analyzeFace 关键点不可信时不回退到估算（避免掩盖失败）', () => {
  // 关键点坐标系异常 + 同时给 bbox → 仍应判定不可用（不静默用估算冒充实测）
  const pts = makeFacePoints(20, 120).map((p) => ({ x: p.x * 50, y: p.y * 50 }));
  const a = analyzeFace({
    points: pts, bbox: { x: 0, y: 0, w: 100, h: 200 }, imageWidth: 200, imageHeight: 200,
  });
  assert.strictEqual(a.ok, false);
});

// ==================== 输出构图规划（600dpi 开放，2026-10-23） ====================

test('构图规划：300dpi 目标的工作图长边取质量下限 800（不放大源图）', () => {
  // 源图 3000×4000（手机原图）→ 一寸 300dpi = 295×413
  const p = planOutput(3000, 4000, 295, 413);
  assert.ok(p);
  // 工作图长边 = 800（质量下限），不超上限
  assert.strictEqual(Math.max(p.workW, p.workH), MIN_WORK_EDGE);
  // 源图远大于目标 → 不需要放大
  assert.strictEqual(p.upscale, false);
  assert.strictEqual(p.srcTooSmall, false);
});

test('构图规划：600dpi 目标必须提升工作图（不能沿用 800px 上限）', () => {
  // 大二寸 600dpi = 827×1252（600dpi 下目标长边最大的一档）
  const p = planOutput(3000, 4000, 827, 1252);
  assert.ok(p);
  // 工作图长边必须 ≥ 目标长边，否则输出是「从 800px 放大来的假印刷级」
  assert.ok(Math.max(p.workW, p.workH) >= 1252, `工作图长边应 ≥1252，实际 ${Math.max(p.workW, p.workH)}`);
  assert.ok(Math.max(p.workW, p.workH) <= MAX_WORK_EDGE);
  // 裁剪窗口像素 ≥ 目标像素（不放大）
  assert.ok(p.sw >= 827 - 0.5 && p.sh >= 1252 - 0.5);
  assert.strictEqual(p.upscale, false);
});

test('构图规划：600dpi 时若源图分辨率不足，标记 srcTooSmall 并给出提示', () => {
  // 源图仅 600×800，远不够 600dpi 目标
  const p = planOutput(600, 800, 827, 1252);
  assert.ok(p);
  assert.strictEqual(p.srcTooSmall, true);
  assert.ok(p.reason.includes('原图分辨率不足'));
});

test('构图规划：裁剪窗口保持目标宽高比且居中', () => {
  const p = planOutput(3000, 4000, 295, 413);
  assert.ok(p);
  const winRatio = p.sw / p.sh;
  const tgtRatio = 295 / 413;
  assert.ok(Math.abs(winRatio - tgtRatio) < 0.001);
  // 居中：左右余量相等、上下余量相等
  assert.ok(Math.abs((p.workW - p.sw) / 2 - p.sx) < 1e-6);
  assert.ok(Math.abs((p.workH - p.sh) / 2 - p.sy) < 1e-6);
});

test('构图规划：工作图长边不超过性能上限（内存保护）', () => {
  // 超大源图 8000×10000 → 600dpi 目标
  const p = planOutput(8000, 10000, 827, 1252);
  assert.ok(p);
  assert.ok(Math.max(p.workW, p.workH) <= MAX_WORK_EDGE);
  assert.ok(p.workW * p.workH <= 2200000);
});

test('构图规划：缺参返回 null', () => {
  assert.strictEqual(planOutput(0, 100, 295, 413), null);
  assert.strictEqual(planOutput(100, 100, 0, 413), null);
});

// ==================== 600dpi 合规判定分档 ====================

test('合规引擎：600dpi 的文件大小降级为提示项，不判不通过', () => {
  // 一寸 600dpi = 590×827；给一个超 200KB 的文件（600dpi 印刷级必然超 300dpi 口径上限）
  const r = check('one-inch', {
    widthPx: 590, heightPx: 827, dpi: 600, fileKb: 260, bg: 'white',
  });
  const fs = r.checks.find((c) => c.key === 'filesize');
  assert.ok(fs);
  assert.strictEqual(fs.level, 'advisory');
  assert.strictEqual(fs.pass, false, '事实：260KB 确实超 200KB 上限');
  // 但不参与通过判定 → 整份报告仍 pass
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.suggestions.length, 0);
});

test('合规引擎：300dpi 的文件大小仍严格判定并阻断', () => {
  const r = check('one-inch', {
    widthPx: 295, heightPx: 413, dpi: 300, fileKb: 260, bg: 'white',
  });
  const fs = r.checks.find((c) => c.key === 'filesize');
  assert.strictEqual(fs.level, 'required');
  assert.strictEqual(fs.pass, false);
  assert.strictEqual(r.pass, false);
  assert.ok(r.suggestions.includes('文件大小'));
});

test('合规引擎：600dpi 时尺寸/底色等 required 项仍严格判定', () => {
  // 底色错 → 必须判不通过（不能因 600dpi 而全线放松）
  // 注意：不能用 one-inch 构造「底色错」——它的 bg 允许 blue/blueLight/red，
  //       蓝底本身合规。必须用**底色受限**的规格（驾驶证仅白底）才构得成 required 项失败。
  const spec = getSpec('driver-license');
  const t600 = getPixelSize(spec, 600);
  const r = check('driver-license', {
    widthPx: t600.width, heightPx: t600.height, dpi: 600, fileKb: 260, bg: 'blue',
  });
  assert.strictEqual(r.pass, false, '600dpi 不得放松底色判定');
  assert.ok(r.suggestions.includes('底色'));
  // 反向：白底 → 尺寸/底色/dpi 全过，KB 为 advisory 不阻断
  const r2 = check('driver-license', {
    widthPx: t600.width, heightPx: t600.height, dpi: 600, fileKb: 260, bg: 'white',
  });
  assert.strictEqual(r2.pass, true);
  const fs = r2.checks.find((c) => c.key === 'filesize');
  assert.strictEqual(fs.level, 'advisory');
});

test('合规引擎：600dpi 目标像素约为 300dpi 的两倍（mm→px 舍入，容差 ≤1px）', () => {
  const s300 = getPixelSize('one-inch', 300);
  const s600 = getPixelSize('one-inch', 600);
  // 说明：25mm@300dpi = 295.28 → 295；25mm@600dpi = 590.55 → 591。
  // mm→px 换算在两次 round 后**不严格成 2 倍**（差 1px），属正常舍入效应而非缺陷。
  assert.ok(Math.abs(s600.width - s300.width * 2) <= 1, `宽度 ${s600.width} vs ${s300.width * 2}`);
  assert.ok(Math.abs(s600.height - s300.height * 2) <= 1, `高度 ${s600.height} vs ${s300.height * 2}`);
  // 但倍数关系必须落在合理区间（1.9~2.1）
  assert.ok(s600.width / s300.width > 1.9 && s600.width / s300.width < 2.1);
});

// ==================== 换装双线性采样（600dpi 放大） ====================

test('换装：suitCompose 双线性混合后不产生黑边（半透明边界不渗染）', () => {
  // 模板：2×1，左半红不透明，右半透明
  const tpl = new Uint8ClampedArray([
    255, 0, 0, 255,
    0, 0, 0, 0,
  ]);
  // 前景：白色人体
  const w = 4, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
  const alpha = new Float32Array(w * h).fill(1);
  // 放置框放大到 4×2（模板被放大 2 倍，边界落在插值区）
  const place = { x: 0, y: 0, w: 4, h: 2 };
  const out = suitCompose(rgba, alpha, w, h, tpl, 2, 1, place);
  // 左半应为红色调；右半应保留白色（模板透明处不覆盖）
  const left = out[0], right = out[(w - 1) * 4];
  assert.ok(left > 200, `左半应接近红，实测 ${left}`);
  assert.ok(right > 200, `右半应保留前景白（无黑边渗染），实测 ${right}`);
  // 输入不被修改
  assert.strictEqual(rgba[0], 255);
});

// ==================== 智能裁切（任务 #24 / PRD B2） ====================

test('headCrop：目标头占比取规格区间中值，非法参数返回 null', () => {
  // 一寸 61%~71% → 中值 66%（浮点用近似比较）
  assert.ok(Math.abs(targetHeadRatio(0.61, 0.71) - 0.66) < 1e-9);
  // 美国签证 49%~69% → 中值 59%
  assert.ok(Math.abs(targetHeadRatio(0.49, 0.69) - 0.59) < 1e-9);
  // 非法输入
  assert.strictEqual(targetHeadRatio(0, 0.71), null);
  assert.strictEqual(targetHeadRatio(0.61, 0.5), null, '上限小于下限应返回 null');
  assert.strictEqual(targetHeadRatio(null, 0.71), null);
});

test('headCrop：9 个规格全部能算出目标占比，且落在各自区间内', () => {
  // 注意：listSpecs() 返回的是【摘要】，不含头占比区间；区间只在 getSpec() 的完整对象里。
  // （这正是 T1 页面必须调 getSpec 而非 listSpecs 的原因。）
  assert.strictEqual(listSpecs().length, 9);
  for (const s of listSpecs()) {
    const full = getSpec(s.id);
    const r = targetHeadRatio(full.headHeightRatioMin, full.headHeightRatioMax);
    assert.ok(r != null, `${s.id} 应能算出目标占比`);
    assert.ok(r >= full.headHeightRatioMin && r <= full.headHeightRatioMax, `${s.id} 中值应落在区间内`);
  }
});

test('headCrop：反解出的占比精确命中目标（构造「构图宽松」场景）', () => {
  // 构造：原图 1000×1400，头顶 y=300，下巴 y=420（头长 120），目标一寸 295×413
  // 理想窗高 sh = headPx / R = 120 / 0.66 ≈ 181.8 → 远小于原图高度，构图宽松
  const crop = planHeadCrop({
    workW: 1000, workH: 1400,
    targetW: 295, targetH: 413,
    crownY: 300, chinY: 420,
    faceCenterX: 500,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  assert.ok(crop, '应返回裁剪方案');
  // 头完整在窗内 + 占比命中目标
  assert.strictEqual(crop.headFullyVisible, true);
  assert.strictEqual(crop.degraded, false);
  assert.ok(Math.abs(crop.ratioAchieved - crop.ratioTarget) < 1e-6,
    `实测占比 ${crop.ratioAchieved} 应等于目标 ${crop.ratioTarget}`);
  // 宽由目标宽高比决定
  const aspect = 295 / 413;
  assert.ok(Math.abs(crop.sw / crop.sh - aspect) < 1e-6, '窗宽高比应等于目标宽高比');
  // 裁剪窗完全落在原图内
  assert.ok(crop.sx >= 0 && crop.sy >= 0);
  assert.ok(crop.sx + crop.sw <= 1000 + 1e-6);
  assert.ok(crop.sy + crop.sh <= 1400 + 1e-6);
});

test('headCrop：头顶上方留白符合官方口径系数（0.13 倍头长）', () => {
  const crop = planHeadCrop({
    workW: 1000, workH: 1400, targetW: 295, targetH: 413,
    crownY: 300, chinY: 420, faceCenterX: 500,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  const headPx = 420 - 300;
  // 头顶上方留白 = HEAD_TOP_GAP_RATIO × 头长（sy 由 crownY - topGap 直接定位）
  assert.ok(Math.abs((300 - crop.sy) - HEAD_TOP_GAP_RATIO * headPx) < 1e-6,
    `头顶留白 ${300 - crop.sy} 应约等于 ${HEAD_TOP_GAP_RATIO * headPx}`);
  // 下巴留白是【派生值】：窗高由「头占比」唯一决定（sh = headPx / R），
  // 垂直定位由「头顶留白」唯一决定，两者都不变 → 下巴留白 = sh - topGap - headPx。
  // CHIN_BOTTOM_GAP_RATIO 只用于「窗高是否容得下头+必要留白」的可行性校验，不是硬性目标值。
  const bottomGap = (crop.sy + crop.sh) - 420;
  assert.ok(bottomGap > 0, '下巴下方必须留白');
  assert.ok(Math.abs(bottomGap - (crop.sh - HEAD_TOP_GAP_RATIO * headPx - headPx)) < 1e-6);
  // 且该留白必须 ≥ 官方口径的 0.16 倍图高（本例 46.2 > 29.1，构图宽松，成立）
  assert.ok(bottomGap >= CHIN_BOTTOM_GAP_RATIO * crop.sh,
    `下巴留白 ${bottomGap} 不应小于官方口径下限 ${CHIN_BOTTOM_GAP_RATIO * crop.sh}`);
});

test('headCrop：面部水平居中（脸中心对齐窗中心，且脸完整在窗内）', () => {
  // 人脸明显偏右：脸中心 x=700
  const crop = planHeadCrop({
    workW: 1000, workH: 1400, targetW: 295, targetH: 413,
    crownY: 300, chinY: 420, faceCenterX: 700,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  const winCenter = crop.sx + crop.sw / 2;
  assert.ok(Math.abs(winCenter - 700) < 1e-6, `窗中心 ${winCenter} 应等于脸中心 700`);
});

test('headCrop：构图过紧（宽度受限）时如实降级并标记 above-max', () => {
  // 极端：原片很窄（workW=200），头长占满几乎整个宽度
  const crop = planHeadCrop({
    workW: 200, workH: 400, targetW: 295, targetH: 413,
    crownY: 100, chinY: 380, faceCenterX: 100,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  assert.ok(crop, '应返回裁剪方案');
  // 宽度受限时占比必然高于目标（窗变小、可见头长不变）
  assert.strictEqual(crop.degraded, true);
  assert.ok(['above-max', 'head-clipped'].includes(crop.degradeReason));
  assert.ok(crop.notes.length > 0, '降级必须给出用户可读提示');
  assert.ok(crop.sw <= 200 + 1e-6 && crop.sh <= 400 + 1e-6, '裁剪窗不得超出原图');
});

test('headCrop：头顶超出画面时不裁头，如实标记 head-clipped', () => {
  // 头顶在 y=-50（画面外），下巴 y=250 → 头长 300，可见部分只有 250
  const crop = planHeadCrop({
    workW: 1000, workH: 800, targetW: 295, targetH: 413,
    crownY: -50, chinY: 250, faceCenterX: 500,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  assert.ok(crop);
  // 关键回归（问题台账 #37）：crownY<0 时 sy 曾会算成 -89（越出画面上界），
  // 导致裁剪窗超出原图、drawImage 取到空白。必须夹到 0。
  assert.strictEqual(crop.sy, 0, '头顶出界时窗顶必须对齐画面顶，不得为负');
  assert.ok(crop.sy + crop.sh <= 800 + 1e-6, '窗底不得超出画面');
  assert.strictEqual(crop.headFullyVisible, false);
  assert.strictEqual(crop.degraded, true);
  // 可见头长 250 / 窗高 → 必然低于区间下限
  assert.strictEqual(crop.degradeReason, 'below-min');
});

test('headCrop：非法输入返回 null（不抛异常）', () => {
  assert.strictEqual(planHeadCrop(null), null);
  assert.strictEqual(planHeadCrop({ workW: 0, workH: 100, targetW: 295, targetH: 413, crownY: 1, chinY: 2 }), null);
  assert.strictEqual(planHeadCrop({ workW: 100, workH: 100, targetW: 295, targetH: 413, crownY: 50, chinY: 50, ratioMin: 0.6, ratioMax: 0.7 }), null, '头长为 0 应返回 null');
  assert.strictEqual(planHeadCrop({ workW: 100, workH: 100, targetW: 295, targetH: 413, crownY: 10, chinY: 50, ratioMin: 0, ratioMax: 0.7 }), null);
});

test('headCrop：无 faceCenterX 时退化为水平居中（不崩）', () => {
  const crop = planHeadCrop({
    workW: 1000, workH: 1400, targetW: 295, targetH: 413,
    crownY: 300, chinY: 420,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  assert.ok(crop);
  assert.ok(Math.abs((crop.sx + crop.sw / 2) - 500) < 1e-6, '缺脸中心时应按原图水平居中');
});

// ==================== 区域化工作画布（planWindowOutput） ====================

test('compose：planWindowOutput 的工作画布覆盖裁剪窗且不放大', () => {
  // 契约：调用方给的裁剪窗必须已是目标宽高比（planHeadCrop 保证），本函数只做缩放与区域规划。
  // 原图 3000×4000，裁剪窗按一寸比例 750×1049.5 → 目标 295×413
  const win = { sx: 1000, sy: 800, sw: 750, sh: 750 / (295 / 413) };
  const plan = planWindowOutput(3000, 4000, 295, 413, win);
  assert.ok(plan, '应返回规划结果');
  // 裁剪窗在工作图内的像素 ≥ 目标像素（不放大）
  assert.ok(plan.sw >= 295 - 0.5, `窗宽 ${plan.sw} 应 ≥ 295`);
  assert.ok(plan.sh >= 413 - 0.5, `窗高 ${plan.sh} 应 ≥ 413`);
  assert.strictEqual(plan.upscale, false);
  assert.strictEqual(plan.srcTooSmall, false);
  // 裁剪窗在工作画布内
  assert.ok(plan.sx >= -0.01 && plan.sy >= -0.01);
  assert.ok(plan.sx + plan.sw <= plan.workW + 0.01);
  assert.ok(plan.sy + plan.sh <= plan.workH + 0.01);
  // 窗宽高比仍等于目标宽高比（等比缩放不改变比例）
  assert.ok(Math.abs(plan.sw / plan.sh - 295 / 413) < 1e-6);
  // 工作区域应大于裁剪窗（含余量）
  assert.ok(plan.regionW > win.sw, '工作区域应比裁剪窗大（含余量，避免边缘硬切）');
  // 缩放是等比的：区域与裁剪窗的像素比一致
  assert.ok(Math.abs(plan.sw / win.sw - plan.sh / win.sh) < 1e-9);
});

test('compose：planWindowOutput 贴边时区域尺寸不缩水、裁剪窗仍在界内', () => {
  // 裁剪窗紧贴左上角
  const plan = planWindowOutput(1000, 1000, 295, 413, { sx: 0, sy: 0, sw: 300, sh: 413 });
  assert.ok(plan);
  assert.strictEqual(plan.regionX, 0);
  assert.strictEqual(plan.regionY, 0);
  assert.ok(plan.sx >= -0.01 && plan.sy >= -0.01);
  assert.ok(plan.sx + plan.sw <= plan.workW + 0.01);
  assert.ok(plan.sy + plan.sh <= plan.workH + 0.01);
});

test('compose：planWindowOutput 在源图不足时如实标记 srcTooSmall', () => {
  // 裁剪窗 100×140（源像素极少），目标 591×826（600dpi 一寸）→ 必须放大
  const plan = planWindowOutput(1000, 1000, 591, 826, { sx: 400, sy: 400, sw: 100, sh: 140 });
  assert.ok(plan);
  assert.strictEqual(plan.srcTooSmall, true);
  assert.ok(plan.reason.includes('分辨率不足'));
});

test('compose：planWindowOutput 参数非法返回 null', () => {
  assert.strictEqual(planWindowOutput(1000, 1000, 295, 413, null), null);
  assert.strictEqual(planWindowOutput(1000, 1000, 295, 413, { sx: 0, sy: 0, sw: 0, sh: 100 }), null);
  assert.strictEqual(planWindowOutput(0, 1000, 295, 413, { sx: 0, sy: 0, sw: 100, sh: 100 }), null);
});

test('compose：planDetectImage 长边封顶 1200，小图不放大', () => {
  const big = planDetectImage(3000, 4000);
  assert.strictEqual(big.width, 900);   // 1200 * 3000/4000
  assert.strictEqual(big.height, 1200);
  assert.ok(big.scale < 1);
  const small = planDetectImage(600, 800);
  assert.strictEqual(small.width, 600, '小于上限时不放大');
  assert.strictEqual(small.height, 800);
  assert.strictEqual(small.scale, 1);
  assert.strictEqual(planDetectImage(0, 100), null);
});

test('compose：clampScale 与 planOutput 原行为等价（限幅下界=质量下限）', () => {
  // scale 过小 → 抬到 minEdge/长边
  const a = clampScale(0.01, 3000, 4000);
  assert.ok(Math.abs(a.scale * 4000 - MIN_WORK_EDGE) < 1e-6);
  assert.strictEqual(a.cappedBy, null);
  // scale 过大 → 压到 maxEdge/长边
  const b = clampScale(10, 3000, 4000);
  assert.ok(Math.abs(b.scale * 4000 - MAX_WORK_EDGE) < 1e-6);
  assert.strictEqual(b.cappedBy, 'maxEdge');
});

test('compose：planOutput 行为未被 planWindowOutput 改动影响（回归护栏）', () => {
  // 固定输入的期望值（与 #24 之前的实现一致）—— 防止抽 clampScale 时漂移。
  // 3000×4000 源图 + 一寸 295×413：needScale≈0.103 → 触发质量下限 800px
  // → scale=0.2 → 工作图 600×800；宽高比 0.75 ≥ 0.714 → 窗高取满、左右居中。
  const plan = planOutput(3000, 4000, 295, 413);
  assert.strictEqual(plan.workW, 600);
  assert.strictEqual(plan.workH, 800);
  assert.strictEqual(plan.sh, 800);
  assert.strictEqual(plan.sy, 0);
  assert.ok(Math.abs(plan.sw - 800 * (295 / 413)) < 1e-9);
  assert.ok(Math.abs(plan.sx - (600 - plan.sw) / 2) < 1e-9);
});

test('headCrop + planWindowOutput 串联：原片远景也能得到够像素的成品', () => {
  // 场景：3000×4000 远景全身照，头长仅 400px（占原图高 10%）
  const srcW = 3000, srcH = 4000;
  const headPx = 400;
  const chinY = 1200;
  const crownY = chinY - headPx;   // 800
  const crop = planHeadCrop({
    workW: srcW, workH: srcH, targetW: 295, targetH: 413,
    crownY, chinY, faceCenterX: 1500,
    ratioMin: 0.61, ratioMax: 0.71,
  });
  assert.ok(crop);
  const plan = planWindowOutput(srcW, srcH, 295, 413, {
    sx: crop.sx, sy: crop.sy, sw: crop.sw, sh: crop.sh,
  });
  assert.ok(plan);
  // 关键：区域化之后，成品不再是「从 1600px 长边整图放大」——窗像素够 300dpi
  assert.ok(plan.sw >= 295 && plan.sh >= 413, '窗像素应≥目标像素');
  assert.ok(plan.workW < 3000, '工作画布应只含该区域');
  // 且占比确实落在规格区间内
  assert.ok(crop.ratioAchieved >= 0.61 && crop.ratioAchieved <= 0.71,
    `占比 ${crop.ratioAchieved} 应落在一寸区间 61%~71%`);
});

// ==================== 抠图背景色采样注入（任务 #24） ====================

test('mattingLocal：collectEdgeSamples 采到画布四边环带', () => {
  // 4×4 图：内部填红，四边 2px 环带填纯白
  const w = 4, h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const onEdge = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
    const c = onEdge ? 255 : 255; // 先全白
    const i = (y * w + x) * 4;
    rgba[i] = c; rgba[i + 1] = c; rgba[i + 2] = c; rgba[i + 3] = 255;
  }
  // 中心 2×2 改成红色（w=h=4 时中心就是全图，改为 6×6 更明确）
  const w2 = 6, h2 = 6;
  const rgba2 = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const onEdge = x < 2 || x >= w2 - 2 || y < 2 || y >= h2 - 2;
    const i = (y * w2 + x) * 4;
    const v = onEdge ? 255 : 0;
    rgba2[i] = v; rgba2[i + 1] = v; rgba2[i + 2] = v; rgba2[i + 3] = 255;
  }
  const s = collectEdgeSamples(rgba2, w2, h2, 2);
  assert.ok(s.length > 0, '应采到样本');
  for (const [r, g, b] of s) {
    assert.strictEqual(r, 255, '边缘样本应为白色（内部红色不应混入）');
    assert.strictEqual(g, 255);
    assert.strictEqual(b, 255);
  }
  assert.strictEqual(collectEdgeSamples(rgba2, 0, 0).length, 0, '非法尺寸返回空数组');
});

test('mattingLocal：注入 bgSamples 后抠图使用外部背景色（区域化裁剪场景）', () => {
  // 构造「区域画布」：画布四边是黑色（模拟压在头发上的边缘），但真实背景是白色
  const w = 20, h = 20;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const onEdge = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
    // 边缘黑、内部白
    const v = onEdge ? 0 : 255;
    rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
  }
  const external = [[255, 255, 255], [250, 250, 250], [255, 255, 255]];
  const withInjected = runClassicalFallback(rgba, w, h, { bgSamples: external });
  const withoutInject = runClassicalFallback(rgba, w, h);
  const center = (10 * w + 10);
  // 注入白色背景后：内部白色像素被判为背景（alpha 低）；不注入时白色像素远离黑色背景 → alpha 高
  assert.ok(withInjected[center] < 0.5, `注入后中心白色应判为背景，实测 ${withInjected[center]}`);
  assert.ok(withoutInject[center] > withInjected[center],
    '不注入时中心白色的 alpha 应更高（黑色边缘把白色当成了前景）');
});

// ==================== 端侧真模型规格（任务 #3） ====================

test('mattingModel：4 个内置规格全部可商用，且许可信息齐全', () => {
  const specs = listModelSpecs();
  assert.ok(specs.length >= 4, '应至少 4 个内置规格');
  for (const s of specs) {
    // 🔴 这是任务 #3 的硬红线：RMBG-1.4/2.0 权重为非商业许可，绝不能进这张表
    assert.strictEqual(s.commercialOk, true, `${s.id} 必须是可商用模型（RMBG 系列权重仅限非商用）`);
    assert.ok(s.license && s.license.length > 0, `${s.id} 必须声明许可`);
    assert.ok(s.source && s.source.startsWith('http'), `${s.id} 必须给出来源链接`);
  }
  // 明确断言：表里不含 RMBG（防止后人照旧文档接进来）
  const ids = specs.map((s) => s.id).join(',');
  assert.ok(!/rmbg/i.test(ids), `规格表不应包含 RMBG（当前：${ids}）`);
});

test('mattingModel：MODNet 归一化为 [-1,1]、输入 512（与 ImageNet 规格不同）', () => {
  const m = getModelSpec('modnet-q8');
  assert.ok(m, '应能取到 modnet-q8 规格');
  assert.strictEqual(m.inputSize, 512);
  assert.strictEqual(m.normalize.kind, 'minus1to1');
  assert.ok(Math.abs(m.normalize.mean[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(m.normalize.std[0] - 0.5) < 1e-9);
  assert.strictEqual(m.output.kind, 'matte', 'MODNet 输出已是 0~1 soft alpha');
  // 与上云模型对比，确认两套参数确实不同（否则说明参数化没生效）
  const b = getModelSpec('birefnet-1024');
  assert.strictEqual(b.inputSize, 1024);
  assert.strictEqual(b.normalize.kind, 'imagenet');
  assert.strictEqual(b.output.kind, 'sigmoid', 'BiRefNet 输出 logits 需 sigmoid');
});

test('mattingModel：preprocess 按规格归一化 —— 同像素在两种规格下值不同（核心回归）', () => {
  // 构造 2×2 纯灰图（R=G=B=128）
  const w = 2, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 128; rgba[i * 4 + 1] = 128; rgba[i * 4 + 2] = 128; rgba[i * 4 + 3] = 255;
  }
  // MODNet: (128/255 - 0.5)/0.5 ≈ 0.0039
  const a = preprocess(rgba, w, h, getModelSpec('modnet-q8'));
  // ImageNet: (128/255 - 0.485)/0.229 ≈ 0.0707
  const b = preprocess(rgba, w, h, getModelSpec('birefnet-1024'));
  assert.ok(Math.abs(a[0] - 0.0039) < 0.002, `MODNet 归一化应约 0.0039，实测 ${a[0]}`);
  assert.ok(Math.abs(b[0] - 0.0707) < 0.01, `ImageNet 归一化应约 0.0707，实测 ${b[0]}`);
  // 关键断言：两者必须显著不同 —— 这正是「硬编码 ImageNet 会让 MODNet 失真」的护栏
  assert.ok(Math.abs(a[0] - b[0]) > 0.02, '两种归一化的结果必须显著不同，否则参数化未生效');
  // 输出长度 = 3 * size * size
  assert.strictEqual(a.length, 3 * 512 * 512);
  assert.strictEqual(b.length, 3 * 1024 * 1024);
});

test('mattingModel：preprocess 兼容旧的数字入参（行为与原 ImageNet 实现一致）', () => {
  const w = 2, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 128; rgba[i * 4 + 1] = 128; rgba[i * 4 + 2] = 128; rgba[i * 4 + 3] = 255;
  }
  const out = preprocess(rgba, w, h, 1024);
  assert.strictEqual(out.length, 3 * 1024 * 1024);
  assert.ok(Math.abs(out[0] - 0.0707) < 0.01, '数字入参应按 ImageNet 归一化');
  assert.strictEqual(normalizeSpec(null), null);
  assert.strictEqual(normalizeSpec('bad'), null);
});

test('mattingModel：postprocess 三种后处理语义正确', () => {
  const size = 4;
  // sigmoid：logit 0 → 0.5；大正数 → 趋近 1
  const logits = new Float32Array(size * size);
  logits[0] = 0; logits[1] = 10; logits[2] = -10;
  const sg = postprocess(logits, { inputSize: size, output: { kind: 'sigmoid' } }, size, size);
  assert.ok(Math.abs(sg[0] - 0.5) < 1e-6, 'logit 0 应映射为 0.5');
  assert.ok(sg[1] > 0.99, 'logit +10 应趋近 1');
  assert.ok(sg[2] < 0.01, 'logit -10 应趋近 0');

  // minmax：按本帧拉伸；常量图不得产生 NaN
  const raw = new Float32Array(size * size);
  for (let i = 0; i < raw.length; i++) raw[i] = i; // 0..15
  const mm = postprocess(raw, { inputSize: size, output: { kind: 'minmax' } }, size, size);
  assert.ok(mm[0] < 0.01, '最小值应映射为 0');
  assert.ok(mm[raw.length - 1] > 0.99, '最大值应映射为 1');
  const flat = new Float32Array(size * size).fill(5);
  const mmFlat = postprocess(flat, { inputSize: size, output: { kind: 'minmax' } }, size, size);
  for (let i = 0; i < mmFlat.length; i++) {
    assert.ok(Number.isFinite(mmFlat[i]), '常量图不得出现 NaN/Infinity');
  }

  // matte：夹取到 0~1（量化模型可能轻微越界）
  const over = new Float32Array(size * size).fill(1.5);
  const mt = postprocess(over, { inputSize: size, output: { kind: 'matte' } }, size, size);
  assert.ok(mt[0] <= 1 + 1e-6, '超出 1 的 matte 必须被夹到 1');
});

test('mattingModel：postprocess 输出被 resize 回目标尺寸', () => {
  const size = 8;
  const raw = new Float32Array(size * size).fill(1);
  const out = postprocess(raw, { inputSize: size, output: { kind: 'matte' } }, 40, 30);
  assert.strictEqual(out.length, 40 * 30, '应 resize 回 40×30');
});

test('mattingModel：postprocess 对非法输入抛错而非静默返回', () => {
  assert.throws(() => postprocess(null, { inputSize: 4, output: { kind: 'matte' } }, 4, 4));
  // 输出长度不足（模型换了但规格没更新 → 必须报错，不能拿脏数据继续算）
  assert.throws(
    () => postprocess(new Float32Array(4), { inputSize: 64, output: { kind: 'matte' } }, 4, 4),
    /长度不足/,
    '模型输出长度与规格不符时必须报错',
  );
});

test('mattingModel：权重体积校验带 ±20% 容差', () => {
  const spec = getModelSpec('modnet-q8');
  const expect = spec.approxBytes;
  assert.strictEqual(verifyWeight({ size: expect }, spec).ok, true);
  assert.strictEqual(verifyWeight({ size: Math.round(expect * 1.1) }, spec).ok, true, '10% 偏差应放行');
  assert.strictEqual(verifyWeight({ size: Math.round(expect * 0.5) }, spec).ok, false, '体积减半应判异常');
  assert.strictEqual(verifyWeight({ size: expect * 3 }, spec).ok, false, '体积三倍应判异常');
  // 未声明体积的规格（云端模型）→ 跳过体积校验，不误报
  const cloud = getModelSpec('birefnet-1024');
  assert.strictEqual(verifyWeight({ size: 123 }, cloud).ok, true);
});

test('mattingModel：sha256 不匹配时阻断（防权重被替换/损坏）', () => {
  const spec = { ...getModelSpec('modnet-q8'), sha256: 'abcdef123456' };
  assert.strictEqual(verifyWeight({ size: spec.approxBytes, sha256: 'abcdef123456' }, spec).ok, true);
  const bad = verifyWeight({ size: spec.approxBytes, sha256: '000000000000' }, spec);
  assert.strictEqual(bad.ok, false);
  assert.ok(/sha256/.test(bad.reason), '失败原因应点明是 sha256 不匹配');
  // 规格未固定 sha256 时，只有体积兜底，sha 校验标记为「跳过」
  const noSha = verifyWeight({ size: spec.approxBytes }, getModelSpec('modnet-q8'));
  assert.strictEqual(noSha.ok, true);
  assert.strictEqual(noSha.checks.sha, null, '未固定 sha256 时应标记为跳过(null)，而非误判通过');
});

test('mattingModel：缓存文件名与下载决策', () => {
  assert.strictEqual(resolveWeightFileName(getModelSpec('modnet-q8')), 'matting-modnet-q8.onnx');
  assert.strictEqual(resolveWeightFileName(null), null);
  const spec = getModelSpec('modnet-q8');
  assert.strictEqual(shouldDownload({ exists: false }, spec).need, true, '无缓存应下载');
  assert.strictEqual(shouldDownload({ exists: true, size: spec.approxBytes }, spec).need, false, '体积正常无需重下');
  assert.strictEqual(shouldDownload({ exists: true, size: 1024 }, spec).need, true, '体积异常应重下');
  assert.ok(/体积异常/.test(shouldDownload({ exists: true, size: 1024 }, spec).reason));
});

test('mattingModel：resolveModelPlan 未启用/未注入/未配置 → 全部走经典基线', () => {
  const spec = getModelSpec('modnet-q8');
  const okCfg = { enabled: true, weightUrl: 'https://e.cn/m.onnx', modelId: 'modnet-q8' };

  // 未启用 → classical（这是默认状态，保证零回归）
  assert.strictEqual(resolveModelPlan({ config: { enabled: false } }).action, 'classical');
  assert.ok(/未启用/.test(resolveModelPlan({ config: { enabled: false } }).reason));

  // 启用但没注入 ort → classical
  const noOrt = resolveModelPlan({ config: okCfg, runtime: { hasOrt: false } });
  assert.strictEqual(noOrt.action, 'classical');
  assert.ok(/运行时/.test(noOrt.reason));

  // 注入了但没配 weightUrl → classical
  const noUrl = resolveModelPlan({ config: { ...okCfg, weightUrl: '' }, runtime: { hasOrt: true } });
  assert.strictEqual(noUrl.action, 'classical');
  assert.ok(/weightUrl/.test(noUrl.reason));

  // 未知模型 id → classical
  const badId = resolveModelPlan({ config: { ...okCfg, modelId: 'nope' }, runtime: { hasOrt: true } });
  assert.strictEqual(badId.action, 'classical');
  assert.ok(/未知模型规格/.test(badId.reason));

  // 云端专用规格放端侧 → classical（BiRefNet 1024 手机跑不动）
  const cloud = resolveModelPlan({
    config: { ...okCfg, modelId: 'birefnet-1024' }, runtime: { hasOrt: true },
  });
  assert.strictEqual(cloud.action, 'classical');
  assert.ok(/云端专用/.test(cloud.reason));
});

test('mattingModel：resolveModelPlan 缓存命中/缺失/损坏的三种分支', () => {
  const spec = getModelSpec('modnet-q8');
  const cfg = { enabled: true, weightUrl: 'https://e.cn/m.onnx', modelId: 'modnet-q8' };

  // 无缓存 → download
  const miss = resolveModelPlan({ config: cfg, runtime: { hasOrt: true }, cached: { exists: false } });
  assert.strictEqual(miss.action, 'download');
  assert.strictEqual(miss.spec.id, 'modnet-q8', '返回值必须带上规格，供后续按规格推理');

  // 缓存体积正常 → use-cached
  const hit = resolveModelPlan({
    config: cfg, runtime: { hasOrt: true },
    cached: { exists: true, size: spec.approxBytes, sha256: '' },
  });
  assert.strictEqual(hit.action, 'use-cached');

  // 缓存体积异常 → 重新下载（而不是继续用坏缓存）
  const bad = resolveModelPlan({
    config: cfg, runtime: { hasOrt: true },
    cached: { exists: true, size: 1024, sha256: '' },
  });
  assert.strictEqual(bad.action, 'download');
  assert.ok(/重新下载/.test(bad.reason));
});

test('mattingModel：下载失败退避 —— 冷却期内不重试，超次数彻底停止', () => {
  const now = 1_000_000;
  // 从未失败 → 可以重试
  assert.strictEqual(shouldRetryDownload({ failCount: 0, now }).retry, true);

  // 刚失败 1 次，冷却 30 分钟内 → 不重试
  const cooling = shouldRetryDownload({ failCount: 1, lastFailAt: now - 60 * 1000, now, cooldownMs: 30 * 60 * 1000 });
  assert.strictEqual(cooling.retry, false);
  assert.ok(/冷却中/.test(cooling.reason));

  // 冷却已过 → 可重试
  assert.strictEqual(
    shouldRetryDownload({ failCount: 1, lastFailAt: now - 31 * 60 * 1000, now, cooldownMs: 30 * 60 * 1000 }).retry,
    true,
  );

  // 失败次数达上限 → 彻底停止（即使冷却已过）
  const stop = shouldRetryDownload({
    failCount: 3, lastFailAt: now - 999 * 60 * 1000, now, cooldownMs: 30 * 60 * 1000, maxFail: 3,
  });
  assert.strictEqual(stop.retry, false);
  assert.ok(/停止重试/.test(stop.reason), '达上限后应明确停止，避免反复耗流量');
});
