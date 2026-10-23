'use strict';
// 端侧抠图 PoC 验证（沙箱可跑，零依赖）
// 1) 生成合成测试图 + 已知真值（GT 椭圆前景），模拟「居中主体 + 任意背景」
// 2) 运行真实经典本地抠图（runClassicalFallback），产出 alpha
// 3) 用已知 GT 计算真实指标：IoU、边界 F1(半径3px)、歧义占比、置信度、路由建议、耗时
// 4) 若设置环境变量 RMBG_ONNX=模型路径 且本机装了 onnxruntime-node，则额外跑真实 RMBG-1.4 推理对比
//
// 运行：node poc/runMattingPoC.js

const fs = require('fs');
const path = require('path');
const { runClassicalFallback, estimateQuality, localMatting } = require('../src/core/mattingLocal');
const { cloudMatting, makeLocalBiRefStub } = require('../src/core/mattingCloud');
const { segment } = require('../src/core/matting');

// ---------- 可复现随机 ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeImage(w, h, rng, bgColor, fgColor, fgCloseToBg) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const gt = new Uint8Array(w * h); // 1=前景
  const cx = w / 2, cy = h / 2, rx = w * 0.30, ry = h * 0.38;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    const bgN = (rng() - 0.5) * 18;
    let r, g, b;
    if (inside) {
      const n = (rng() - 0.5) * 22;
      r = fgColor[0] + n; g = fgColor[1] + n; b = fgColor[2] + n;
      gt[y * w + x] = 1;
    } else {
      r = bgColor[0] + bgN; g = bgColor[1] + bgN; b = bgColor[2] + bgN;
    }
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  return { rgba, gt };
}

// 软边(抗锯齿)椭圆：图边缘做前景/背景混合(软过渡)，但 GT 仍用硬椭圆，
// 模拟真实人像的发丝/半透明边缘——端侧单高斯易在过渡带产生歧义，上云精化可收边。
function makeSoftEdgeImage(w, h, rng, bgColor, fgColor) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const gt = new Uint8Array(w * h);
  const cx = w / 2, cy = h / 2, rx = w * 0.30, ry = h * 0.38;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2; // <1 内部
    let mix;
    if (d <= 0.85) mix = 1;
    else if (d >= 1.15) mix = 0;
    else mix = (1.15 - d) / 0.30;
    const bgN = (rng() - 0.5) * 18, fgN = (rng() - 0.5) * 22;
    rgba[i] = fgColor[0] * mix + bgColor[0] * (1 - mix) + (fgN * mix + bgN * (1 - mix));
    rgba[i + 1] = fgColor[1] * mix + bgColor[1] * (1 - mix) + (fgN * mix + bgN * (1 - mix));
    rgba[i + 2] = fgColor[2] * mix + bgColor[2] * (1 - mix) + (fgN * mix + bgN * (1 - mix));
    rgba[i + 3] = 255;
    gt[y * w + x] = d < 1 ? 1 : 0;
  }
  return { rgba, gt };
}

// ---------- 指标 ----------
function iou(pred, gt, n) {
  let inter = 0, uni = 0;
  for (let i = 0; i < n; i++) {
    const p = pred[i] >= 0.5 ? 1 : 0;
    const g = gt[i];
    if (p || g) uni++;
    if (p && g) inter++;
  }
  return uni ? inter / uni : 0;
}

function edgeMap(bin, w, h) {
  const e = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!bin[i]) continue;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let boundary = false;
    for (const [dx, dy] of nb) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || !bin[yy * w + xx]) { boundary = true; break; }
    }
    if (boundary) e[i] = 1;
  }
  return e;
}

function dilate(bin, w, h, R) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!bin[y * w + x]) continue;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return out;
}

function boundaryF1(alphaBin, gtBin, w, h, R = 3) {
  const pe = edgeMap(alphaBin, w, h);
  const ge = edgeMap(gtBin, w, h);
  const geD = dilate(ge, w, h, R);
  const peD = dilate(pe, w, h, R);
  let pDen = 0, pNum = 0, rDen = 0, rNum = 0;
  for (let i = 0; i < w * h; i++) {
    if (pe[i]) { pDen++; if (geD[i]) pNum++; }
    if (ge[i]) { rDen++; if (peD[i]) rNum++; }
  }
  const prec = pDen ? pNum / pDen : 0;
  const rec = rDen ? rNum / rDen : 0;
  return prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
}

// ---------- 场景 ----------
function runScenario(name, opts) {
  const W = 512, H = 512;
  const rng = mulberry32(opts.seed);
  const { rgba, gt } = makeImage(W, H, rng, opts.bg, opts.fg, opts.close);
  const t0 = Date.now();
  const alpha = runClassicalFallback(rgba, W, H);
  const dt = Date.now() - t0;
  const quality = estimateQuality(alpha);
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = alpha[i] >= 0.5 ? 1 : 0;
  const sc = iou(alpha, gt, W * H);
  const bf = boundaryF1(bin, gt, W, H, 3);
  const route = quality.confidence >= 0.85 ? 'edge（本地）' : 'cloud（上云增强）';
  console.log(`\n=== 场景：${name} ===`);
  console.log(`  尺寸           : ${W}×${H}`);
  console.log(`  耗时           : ${dt} ms`);
  console.log(`  前景占比       : ${(quality.foregroundRatio * 100).toFixed(1)}%`);
  console.log(`  歧义像素占比   : ${(quality.ambiguousRatio * 100).toFixed(1)}%`);
  console.log(`  置信度         : ${quality.confidence.toFixed(3)}`);
  console.log(`  路由建议       : ${route}`);
  console.log(`  —— 与已知真值对比 ——`);
  console.log(`  IoU (前景重叠) : ${sc.toFixed(3)}`);
  console.log(`  边界 F1(3px)   : ${bf.toFixed(3)}`);
  return { quality, sc, bf, dt };
}

// ---------- 上云增强场景（端到端：本地 → 路由 → 上云 stub → 精细化） ----------
function addTexture(rgba, w, h, gt) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (gt[i]) continue; // 仅背景叠加方格纹理，制造端侧歧义
    const cell = ((x >> 4) + (y >> 4)) % 2 === 0 ? 40 : -40;
    const idx = i * 4;
    rgba[idx] = Math.max(0, Math.min(255, rgba[idx] + cell));
    rgba[idx + 1] = Math.max(0, Math.min(255, rgba[idx + 1] + cell));
    rgba[idx + 2] = Math.max(0, Math.min(255, rgba[idx + 2] + cell));
  }
}

async function runCloudScenario(name, opts) {
  const W = 512, H = 512, N = W * H;
  const rng = mulberry32(opts.seed);
  const { rgba, gt } = opts.softEdge ? makeSoftEdgeImage(W, H, rng, opts.bg, opts.fg) : makeImage(W, H, rng, opts.bg, opts.fg, false);

  // 1) 端侧初值
  const alphaLocal = runClassicalFallback(rgba, W, H);
  const qLocal = estimateQuality(alphaLocal);

  // 2) 经完整 segment 路由（置信<0.85 自动上云），演示路由决策真实生效
  const stub = makeLocalBiRefStub();
  const seg = await segment({ rgba, width: W, height: H, cloud: { adapter: stub }, consents: ['faceCloudEnhance'], tool: 'T1' });

  // 3) 上云增强（与端侧直接对比）
  const t0 = Date.now();
  const res = await cloudMatting({ rgba, alpha: alphaLocal, width: W, height: H, adapter: stub, consents: ['faceCloudEnhance'], audit: () => {} });
  const dt = Date.now() - t0;

  // 4) 与已知真值对比
  const iouLocal = iou(alphaLocal, gt, N);
  const iouCloud = iou(res.alpha, gt, N);
  const binL = new Uint8Array(N), binC = new Uint8Array(N);
  for (let i = 0; i < N; i++) { binL[i] = alphaLocal[i] >= 0.5 ? 1 : 0; binC[i] = res.alpha[i] >= 0.5 ? 1 : 0; }
  const bfL = boundaryF1(binL, gt, W, H, 3);
  const bfC = boundaryF1(binC, gt, W, H, 3);
  const qCloud = estimateQuality(res.alpha);

  const route = qLocal.confidence >= 0.85 ? 'edge（本地）' : 'cloud（上云增强）';
  console.log(`\n=== 上云场景：${name} ===`);
  console.log(`  本地置信度     : ${qLocal.confidence.toFixed(3)}  → 路由: ${route}`);
  console.log(`  segment 后端   : ${seg.backend}  （route=${seg.route}${seg.degraded ? '，曾降级' : ''}）`);
  console.log(`  上云耗时       : ${dt} ms`);
  console.log(`  —— 本地 vs 上云（与已知真值对比）——`);
  console.log(`  本地  IoU=${iouLocal.toFixed(3)}  边界F1=${bfL.toFixed(3)}  歧义=${(qLocal.ambiguousRatio * 100).toFixed(1)}%`);
  console.log(`  上云  IoU=${iouCloud.toFixed(3)}  边界F1=${bfC.toFixed(3)}  歧义=${(qCloud.ambiguousRatio * 100).toFixed(1)}%`);
  console.log(`  ΔIoU=${((iouCloud - iouLocal) * 100).toFixed(1)}%  Δ边界F1=${((bfC - bfL) * 100).toFixed(1)}%`);
  return { iouLocal, iouCloud, bfL, bfC };
}

async function runRealModelIfAvailable(rgba, w, h) {
  if (!process.env.RMBG_ONNX) return;
  let ort;
  try { ort = require('onnxruntime-node'); } catch (e) { console.log('\n[真实模型] onnxruntime-node 未安装，跳过'); return; }
  if (!fs.existsSync(process.env.RMBG_ONNX)) { console.log('\n[真实模型] 权重不存在，跳过'); return; }
  console.log(`\n=== 真实模型：RMBG-1.4 @ ${process.env.RMBG_ONNX} ===`);
  const buf = fs.readFileSync(process.env.RMBG_ONNX);
  const session = await ort.InferenceSession.create(buf, { executionProviders: ['cpu'] });
  const t0 = Date.now();
  const { alpha } = await localMatting(rgba, w, h, { session });
  console.log(`  加载+推理耗时  : ${Date.now() - t0} ms`);
  console.log(`  后端           : ${alpha ? 'rmbg-1.4' : 'n/a'}`);
}

(async () => {
  console.log('端侧抠图 PoC（经典本地基线，真实可运行）');
  console.log('注：沙箱无外网，无法下载 RMBG-1.4 权重；下方为本地经典算法在合成图上的真实指标。');
  runScenario('A. 前景与背景差异明显（理想）', { seed: 7, bg: [90, 110, 140], fg: [220, 180, 150], close: false });
  runScenario('B. 前景与背景近乎同色（真困难，应触发上云）', { seed: 11, bg: [200, 190, 180], fg: [204, 194, 184], close: true });

  // ===== 上云增强链路（本地 BiRefNet 影子，沙箱可跑通） =====
  console.log('\n========== 上云增强链路（本地 BiRefNet 影子实现，沙箱可跑）==========');
  console.log('注：真实 BiRefNet 需部署到【境内】GPU 云函数；此处用「经典基线初值 + 引导滤波保边精化」模拟云端高精度模型，');
  console.log('    验证 本地→路由→裁剪上传→上云精化→贴回 全链路，并对比质量增益。真实模型增益需在联网设备实测（不在沙箱范围）。');
  await runCloudScenario('C. 近同色（端侧置信不足 → segment 自动路由上云安全网）', { seed: 11, bg: [200, 190, 180], fg: [204, 194, 184] });
  await runCloudScenario('D. 高对比理想（端侧已够好 → segment 走 edge，上云仅作可选精化验证不退化）', { seed: 7, bg: [90, 110, 140], fg: [220, 180, 150] });

  // 真实模型分支（需本机有网络+权重，沙箱默认不触发）
  if (process.env.RMBG_ONNX) {
    const W = 512, H = 512;
    const rng = mulberry32(7);
    const { rgba } = makeImage(W, H, rng, [90, 110, 140], [220, 180, 150], false);
    await runRealModelIfAvailable(rgba, W, H);
  }
  console.log('\n完成。要跑真实 RMBG-1.4：在有网机器执行');
  console.log('  RMBG_ONNX=/path/rmbg-1.4.onnx node poc/runMattingPoC.js');
})();
