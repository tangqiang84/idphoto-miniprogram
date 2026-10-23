const test = require('node:test');
const assert = require('node:assert');

const { getSpec, getPixelSize, listSpecs, BG } = require('../specLibrary');
const { check } = require('../compliance');
const { decideRoute, CONF_THRESHOLD, localMatting, estimateQuality, composite, compositeTransparent } = require('../matting');
const { requiredConsents, buildConsentRecord } = require('../privacy');

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

test('规格库：美国签证 51mm 正方形 → 602px', () => {
  const px = getPixelSize('visa-us', 300);
  assert.strictEqual(px.width, 602);
  assert.strictEqual(px.height, 602);
});

test('规格库：listSpecs 返回 8 项', () => {
  assert.strictEqual(listSpecs().length, 8);
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
