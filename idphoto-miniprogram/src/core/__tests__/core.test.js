const test = require('node:test');
const assert = require('node:assert');

const { getSpec, getPixelSize, listSpecs, BG } = require('../specLibrary');
const { check } = require('../compliance');
const { decideRoute, CONF_THRESHOLD, localMatting, estimateQuality, composite, compositeTransparent } = require('../matting');
const { requiredConsents, buildConsentRecord } = require('../privacy');
const { alphaBBox, suitPlacement, suitCompose } = require('../suit');

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

test('换装：suitPlacement 肩宽/顶部定位规则', () => {
  const bbox = { x: 40, y: 20, w: 100, h: 200 };
  const headH = 60;
  const p = suitPlacement(bbox, headH);
  assert.ok(Math.abs(p.w - 150) < 1e-9); // 100*1.5
  assert.ok(Math.abs(p.h - 110) < 1e-9); // 200*0.55
  assert.ok(Math.abs(p.x - (40 + 50 - 75)) < 1e-9); // 水平居中
  assert.ok(Math.abs(p.y - (20 + 51)) < 1e-9); // 颈部 0.85*60
});

test('换装：suitPlacement 缺参抛错', () => {
  assert.throws(() => suitPlacement(null, 60), /bbox/);
  assert.throws(() => suitPlacement({ x: 0, y: 0, w: 1, h: 1 }, 0), /headH/);
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
