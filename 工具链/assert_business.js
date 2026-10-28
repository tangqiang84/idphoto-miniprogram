'use strict';
/**
 * 业务断言库（纯 Node，不依赖 IDE）—— 证件照小程序「业务产出」的可判定验收
 * ============================================================================
 * 【为什么要有这个文件】
 * 现有冒烟（smoke_*.js / batch_acceptance.js）只验到**连通性**：
 * 页面没崩、状态行出现「完成」就算过。这是**假绿**：
 *   · 成品像素尺寸对不对？  → 没验
 *   · 底色色值对不对？      → 没验
 *   · 头部占比落在规格区间？→ 没验（而这正是 AC4 的硬指标）
 *   · 文件大小符合 KB 上限？→ 没验
 *   · 有没有水印？          → 没验（AC7 硬要求「全部档位无水印」）
 *   · 换装有没有盖住脸？    → 没验（AC6/D2 硬要求「不改五官」）
 * 本库把这 6 类「业务产出」变成**可判定**的断言：每条返回 {ok, actual, expected, detail}。
 *
 * 【与 core 的关系】
 * 断言的**口径**一律取自 idphoto-miniprogram/src/core/*（只读引用，不修改）：
 *   · 规格像素    → core/specLibrary.js 的 getPixelSize(specId, dpi)
 *   · 头占比区间  → core/specLibrary.js 的 headHeightRatioMin/Max
 *   · 头部度量    → core/face.js（关键点路径；无关键点时降级为 alpha/前景包围盒估算）
 *   · 像素容差    → core/compliance.js 的 DIM_TOL
 * 这样「断言口径」与「产品口径」不会漂移。
 *
 * 【每个断言的返回结构】
 *   { ok: boolean, actual: any, expected: any, detail: string, ...附加字段 }
 *   附加字段随断言不同（如 assertHeadRatio 带 method/estimated/estimatedNote，
 *   assertFileSize 带 advisory/severity）—— 用于让调用方知道**结论的可信度**。
 *
 * 用法（编程）：
 *   const A = require('./assert_business');
 *   const r = A.assertPixelSize('素材/测试截图/real_batch/111/t1_result.jpg', 'one-inch', 300);
 *   if (!r.ok) console.error(r.detail);
 *
 * 用法（CLI，每个断言可独立跑）：
 *   NODE_OPTIONS= node 工具链/assert_business.js --help
 *   NODE_OPTIONS= node 工具链/assert_business.js --assert pixel-size --file <成品> --spec one-inch --dpi 300
 *   NODE_OPTIONS= node 工具链/assert_business.js --assert bg-color  --file <成品> --expect '#FFFFFF' --tol 12
 *   NODE_OPTIONS= node 工具链/assert_business.js --assert head-ratio --file <成品> --spec one-inch
 *   NODE_OPTIONS= node 工具链/assert_business.js --assert file-size  --file <成品> --max-kb 200
 *   NODE_OPTIONS= node 工具链/assert_business.js --assert no-watermark --file <成品>
 *   NODE_OPTIONS= node 工具链/assert_business.js --assert suit-not-cover-face --before <换装前> --after <换装后> --rect x,y,w,h
 *   NODE_OPTIONS= node 工具链/assert_business.js --assert face-region-clean --file <成品> [--rect x,y,w,h]
 *   NODE_OPTIONS= node 工具链/assert_business.js --selftest     # 用真实素材+手工构造成品自测
 *
 * 退出码：0 = 全部断言通过；1 = 有断言失败；2 = 用法/环境错误。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'idphoto-miniprogram', 'src', 'core');

// 只读引用产品的口径实现（不修改 core/）
const specLib = require(path.join(CORE, 'specLibrary.js'));
const faceLib = require(path.join(CORE, 'face.js'));
const compliance = require(path.join(CORE, 'compliance.js'));

const { decodeImage, readSize, isPng: isPngBuffer, isJpeg: isJpegBuffer } = require('./img_decode');

// core/suitDiff.js —— 换装前后脸部像素差异判定（owner 2026-10-28 并行新增）。
// 【为什么优先复用它】断言库与产品应共用**同一套判定口径**，否则「产品说没变、
// 测试说变了」会各说各话。core/suitDiff.js 是纯函数、Node 可直接 require。
// 若该文件不存在（例如在旧提交上跑），回退到本文件内的独立实现（不因此中断）。
let coreSuitDiff = null;
try {
  coreSuitDiff = require(path.join(CORE, 'suitDiff.js'));
} catch (e) {
  coreSuitDiff = null;
}

// =====================================================================
// 通用工具
// =====================================================================

/** 统一结果结构 */
function mkResult(ok, actual, expected, detail, extra) {
  return Object.assign({ ok: !!ok, actual, expected, detail }, extra || {});
}

/** 十六进制颜色 → [r,g,b]；支持 '#RRGGBB' / 'RRGGBB' / 'rgb(r,g,b)' */
function parseHex(hex) {
  if (Array.isArray(hex)) return hex.slice(0, 3);
  if (typeof hex !== 'string') return null;
  const s = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

function toHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** 颜色距离：Chebyshev（逐通道最大差），对 JPEG 压缩噪声比欧氏距离更稳 */
function colorDistance(a, b) {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

/** 亮度 */
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 读图片像素（统一入口） */
function loadPixels(p) {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + abs);
  return decodeImage(abs);
}

/** 取某个像素的 [r,g,b,a] */
function pxAt(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/**
 * 采样一组点（像素坐标数组），返回每点的颜色。
 * @param {object} img
 * @param {Array<[number,number]>} pts
 */
function samplePixels(img, pts) {
  return pts.map(([x, y]) => {
    const cx = Math.max(0, Math.min(img.width - 1, Math.round(x)));
    const cy = Math.max(0, Math.min(img.height - 1, Math.round(y)));
    return pxAt(img, cx, cy);
  });
}

/**
 * 生成「角落 + 四边中点 + 中心」的采样点集合。
 * 注意：人物区域会落在中心附近 → 中心点只作参考，**不参与底色判定**。
 */
function standardSamplePoints(img, opts = {}) {
  const w = img.width;
  const h = img.height;
  const inset = opts.inset != null ? opts.inset : Math.max(1, Math.round(Math.min(w, h) * 0.02));
  const stepX = Math.round(w * 0.03);
  const stepY = Math.round(h * 0.03);
  // 每个角落 3 点（角 + 沿两边内移）→ 容忍单点被前景/压缩噪点污染
  const cornerGroups = [
    [[inset, inset], [Math.min(w - 1, inset + stepX), inset], [inset, Math.min(h - 1, inset + stepY)]],
    [[w - 1 - inset, inset], [w - 1 - inset - stepX, inset], [w - 1 - inset, Math.min(h - 1, inset + stepY)]],
    [[inset, h - 1 - inset], [Math.min(w - 1, inset + stepX), h - 1 - inset], [inset, h - 1 - inset - stepY]],
    [[w - 1 - inset, h - 1 - inset], [w - 1 - inset - stepX, h - 1 - inset], [w - 1 - inset, h - 1 - inset - stepY]],
  ];
  // 四条边的中点（边中点也可能落在肩膀上 → 只作参考，不参与判定）
  const edgeMid = [
    [w >> 1, inset],
    [w >> 1, h - 1 - inset],
    [inset, h >> 1],
    [w - 1 - inset, h >> 1],
  ];
  const all = [];
  for (const g of cornerGroups) for (const p of g) all.push(p);
  return { cornerGroups, edgeMid, all };
}

/**
 * 底色判定：从「四角附近」的像素里取**众数色**（众数比均值稳，避免单点被前景带偏）。
 * @returns {{hex:string, rgb:number[], votes:number, total:number, alphaRatio:number, support:number}}
 */
function dominantCornerColor(img, opts = {}) {
  const sp = standardSamplePoints(img, opts);
  const counts = new Map();
  const cornerSamples = [];
  let transparentCount = 0;
  // 只用四个角落的 3 个点（共 12 点）做众数：
  // 边缘中点与中心必然落在人脸上，不能参与底色判定。
  for (const group of sp.cornerGroups) {
    for (const [x, y] of group) {
      const p = pxAt(img, x, y);
      cornerSamples.push(p);
      if (p[3] < 250) { transparentCount++; continue; }
      // 量化到 8 级/通道做众数桶，避免 JPEG 噪声把票打散
      const key = ((p[0] >> 5) << 6) | ((p[1] >> 5) << 3) | (p[2] >> 5);
      const e = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += p[0]; e.g += p[1]; e.b += p[2];
      counts.set(key, e);
    }
  }
  let best = null;
  for (const e of counts.values()) if (!best || e.n > best.n) best = e;
  if (!best) {
    return {
      hex: 'TRANSPARENT', rgb: null, votes: 0, total: cornerSamples.length,
      alphaRatio: 1, support: 0, cornerSamples,
    };
  }
  const rgb = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
  return {
    hex: toHex(rgb),
    rgb,
    votes: best.n,
    total: cornerSamples.length,
    alphaRatio: transparentCount / cornerSamples.length,
    support: best.n / cornerSamples.length,
    cornerSamples,
  };
}

// =====================================================================
// ① 像素尺寸
// =====================================================================

/**
 * 断言成品像素尺寸 == 规格像素。
 * @param {string} file 成品路径
 * @param {string} specId 规格 id（如 'one-inch'）；传 null 表示用 opts.expectedWidth/Height
 * @param {number} [dpi=300]
 * @param {object} [opts] { tol, expectedWidth, expectedHeight, expectedLabel }
 *        —— expectedWidth/Height 用于「不选规格、保持原图尺寸」这类非规格路径的尺寸断言
 * @returns {{ok:boolean, actual:any, expected:any, detail:string}}
 */
function assertPixelSize(file, specId, dpi = 300, opts = {}) {
  const tol = opts.tol != null ? opts.tol : compliance.DIM_TOL;

  // 非规格路径：直接用期望像素（如 T2「保持原图尺寸」→ 由原图推算的工作画布尺寸）
  let target;
  let specName;
  if (opts.expectedWidth && opts.expectedHeight) {
    target = { width: opts.expectedWidth, height: opts.expectedHeight, dpi: null };
    specName = opts.expectedLabel || '期望尺寸';
  } else {
    const spec = specLib.getSpec(specId);
    if (!spec) {
      return mkResult(false, null, null, `未知规格 id: ${specId}（可用: ${specLib.SPECS.map((s) => s.id).join(', ')}）`);
    }
    target = specLib.getPixelSize(spec, dpi);
    specName = spec.name;
  }

  let size;
  try {
    size = readSize(path.resolve(file));
  } catch (e) {
    return mkResult(false, null, target, `读取成品尺寸失败: ${e.message}`);
  }
  const actual = { width: size.width, height: size.height };
  const okW = Math.abs(size.width - target.width) <= tol;
  const okH = Math.abs(size.height - target.height) <= tol;
  const ok = okW && okH;
  const detail = ok
    ? `成品 ${size.width}×${size.height}px == ${specName} 要求 ${target.width}×${target.height}px（容差±${tol}）`
    : `成品 ${size.width}×${size.height}px ≠ ${specName} 要求 ${target.width}×${target.height}px（容差±${tol}）`
      + (okW ? '' : ` [宽偏差 ${size.width - target.width}px]`)
      + (okH ? '' : ` [高偏差 ${size.height - target.height}px]`);
  return mkResult(ok, actual, { width: target.width, height: target.height, dpi, specId, specName }, detail, {
    specId, dpi, tol,
  });
}

// =====================================================================
// ② 底色
// =====================================================================

/**
 * 断言成品底色。
 * 判定依据：取四角内移点的**众数色**（12 点的众数桶，8 级/通道量化）作为底色代表，
 *           再与期望色比逐通道最大差（Chebyshev 距离）。
 * 为什么不用「取一点」：中心/边中点必然落在人脸上；单点采样会被压缩噪点、
 *           头发丝、肩线带偏。众数 + 四角多点是抗单点污染的最简做法。
 * 透明底 PNG：四角 alpha < 250 → 判定为「透明底」，此时用「透明像素占比」判定。
 * @param {string} file
 * @param {string} expectedHex 期望色（如 '#FFFFFF'）；传 'transparent' 表示期望透明底
 * @param {number} [tolerance=12] 逐通道最大允许偏差
 */
function assertBackgroundColor(file, expectedHex, tolerance = 12, opts = {}) {
  let img;
  try {
    img = loadPixels(file);
  } catch (e) {
    return mkResult(false, null, expectedHex, `读取成品像素失败: ${e.message}`);
  }
  const dom = dominantCornerColor(img, opts);

  // 透明底期望
  const expectTransparent = typeof expectedHex === 'string' && expectedHex.toLowerCase() === 'transparent';
  if (expectTransparent) {
    const alphaRatio = dom.alphaRatio;
    const ok = alphaRatio >= 0.75;
    return mkResult(ok, { alphaRatio, cornerSamples: dom.cornerSamples.length }, 'transparent(≥75% 角点透明)',
      ok
        ? `透明底成立：四角采样点中 ${(alphaRatio * 100).toFixed(0)}% 为透明像素`
        : `期望透明底，但四角采样点仅 ${(alphaRatio * 100).toFixed(0)}% 透明（<75%）`,
      { mode: 'transparent' });
  }

  // 期望纯色，但图片本身是透明底（角落大量透明）→ 明确判失败并说明
  if (dom.alphaRatio >= 0.75) {
    return mkResult(false, { alphaRatio: dom.alphaRatio }, expectedHex,
      `期望底色 ${expectedHex}，但成品四角 ${(dom.alphaRatio * 100).toFixed(0)}% 为透明像素 —— 这是透明底 PNG，不是纯色底`,
      { mode: 'transparent-mismatch' });
  }

  const exp = parseHex(expectedHex);
  if (!exp) return mkResult(false, dom.hex, expectedHex, `无法解析期望色值: ${expectedHex}`);

  const dist = dom.rgb ? colorDistance(dom.rgb, exp) : null;
  const ok = dist != null && dist <= tolerance;
  const detail = ok
    ? `底色实测众数色 ${dom.hex}（四角 12 点中 ${dom.votes} 票，支撑率 ${(dom.support * 100).toFixed(0)}%），期望 ${toHex(exp)}，偏差 ${dist} ≤ 容差 ${tolerance}`
    : `底色实测众数色 ${dom.hex}（四角 12 点中 ${dom.votes} 票，支撑率 ${(dom.support * 100).toFixed(0)}%），期望 ${toHex(exp)}，偏差 ${dist} > 容差 ${tolerance}`;
  return mkResult(ok, { hex: dom.hex, rgb: dom.rgb, support: dom.support, votes: dom.votes, alphaRatio: dom.alphaRatio },
    { hex: toHex(exp), tolerance }, detail, { mode: 'solid' });
}

// =====================================================================
// ③ 头部占比
// =====================================================================

/**
 * 断言成品头部占比落在规格区间。
 *
 * 【判定依据 —— 三级，明确标注可信度】
 *   1. faceDetect/关键点可用（传入 landmarks）→ 用 core/face.js 的
 *      headMetricsFromLandmarks + ratioWithinWindow（实测，quality='good'）。
 *   2. 成品自带前景信息（PNG 有 alpha 通道 / JPG 可由底色反推前景）→
 *      用**颈部轮廓法**从成品像素估算：前景掩膜 → 行宽曲线 → 头顶行（发际线以上
 *      的起始行）与颈缩最窄行（下巴）→ 头长 = 下巴 − 头顶 → 占比 = 头长 ÷ 图高。
 *      标 estimated=true。
 *   3. 无法得到可靠前景（既无 alpha，也无法用底色反推）→ 返回 ok=false，
 *      明确说明「无法测量」——**不猜、不用固定值冒充**。
 *
 * 【为什么不用 core/face.js 的 headMetricsFromBBox（0.30 × 人像框高）】
 *   该估算口径假定**人像全身在画面内**（头长 ≈ 人像框高的 30%），
 *   用于「源图」测量。而**成品**是按头占比裁切后的图：人物从头顶一直延伸到画面下沿，
 *   人像框高 ≈ 图高 → 0.30 × 图高 ≈ 0.30，与规格要求的 61%~71% 相差约 36 个百分点，
 *   会把合格成品判成严重不符。故成品口径改用颈部轮廓法（方法见上）。
 *   若确实需要 core 的 bbox 口径（测源图），传 opts.method='bbox' 强制使用。
 *
 * 【局限（必须如实告知）】
 *   · 颈部轮廓法是**估算**：下巴位置取「颈部最窄行」，长发/围巾/低头会偏移；
 *     典型误差 ±5~8 个百分点，贴近规格区间边界时会误判。
 *   · 关键点路径的「头顶」本身也是由脸长 ÷ 0.74 外推（core/face.js 注释已说明），
 *     故即便实测也不是精确量。
 *   · 开发者工具模拟器**不支持人脸检测**（services/faceService.ts 明确跳过 devtools）
 *     → 在 IDE 里跑时只能落到第 2 条；真机才有第 1 条。
 *
 * @param {string} file
 * @param {string} specId
 * @param {number} [tolerance=0] 区间外的额外容忍（比例绝对值，如 0.02 = ±2 个百分点）
 * @param {object} [opts] { landmarks, alpha, width, height, method:'neck'|'bbox' }
 */
function assertHeadRatio(file, specId, tolerance = 0, opts = {}) {
  const spec = specLib.getSpec(specId);
  if (!spec) return mkResult(false, null, null, `未知规格 id: ${specId}`);
  const min = spec.headHeightRatioMin;
  const max = spec.headHeightRatioMax;
  if (min == null || max == null) {
    return mkResult(false, null, null, `规格 ${spec.name} 未定义头部占比区间`);
  }

  let img;
  try {
    img = loadPixels(file);
  } catch (e) {
    return mkResult(false, null, null, `读取成品像素失败: ${e.message}`);
  }

  // ---- 路径 1：关键点实测 ----
  if (Array.isArray(opts.landmarks) && opts.landmarks.length >= faceLib.MIN_LANDMARK_COUNT) {
    const m = faceLib.headMetricsFromLandmarks({
      points: opts.landmarks,
      rect: opts.rect || null,
      imageWidth: img.width,
      imageHeight: img.height,
    });
    if (m) {
      const r = faceLib.ratioWithinWindow(m, { x: 0, y: 0, width: img.width, height: img.height });
      const ratio = r ? r.ratio : null;
      if (ratio != null) {
        const ok = ratio >= min - tolerance && ratio <= max + tolerance;
        return mkResult(ok, { ratio, method: 'landmarks', estimated: false },
          { min, max, tolerance },
          ok
            ? `头部占比 ${(ratio * 100).toFixed(1)}%（关键点实测），落在规格 ${spec.name} 区间 ${(min * 100).toFixed(0)}%~${(max * 100).toFixed(0)}% 内`
            : `头部占比 ${(ratio * 100).toFixed(1)}%（关键点实测）超出规格 ${spec.name} 区间 ${(min * 100).toFixed(0)}%~${(max * 100).toFixed(0)}%`,
          { method: 'landmarks', estimated: false, quality: m.quality, notes: m.notes || [] });
      }
    }
  }

  // ---- 路径 1b：显式要求 core 的 bbox 口径（测源图用） ----
  if (opts.method === 'bbox') {
    const alpha = opts.alpha;
    if (!alpha || !alpha.length) {
      return mkResult(false, null, { min, max }, 'method=bbox 需要传入 alpha 前景数组（源图 alpha）');
    }
    const w = opts.width || img.width;
    const h = opts.height || img.height;
    const bbox = alphaBBoxOf(alpha, w, h);
    if (!bbox) return mkResult(false, null, { min, max }, 'alpha 全透明 → 无前景');
    const m = faceLib.headMetricsFromBBox({ bbox, imageWidth: w, imageHeight: h });
    const r = faceLib.ratioWithinWindow(m, { x: 0, y: 0, width: w, height: h });
    const ratio = r ? r.ratio : null;
    if (ratio == null) return mkResult(false, null, { min, max }, 'bbox 口径估算失败');
    const ok = ratio >= min - tolerance && ratio <= max + tolerance;
    return mkResult(ok, { ratio, method: 'bbox-estimate', estimated: true }, { min, max, tolerance },
      `头部占比 ${(ratio * 100).toFixed(1)}%（估算值：alpha 前景包围盒 ${bbox.w}×${bbox.h} × ${faceLib.HEAD_BBOX_RATIO} 系数，core/face.js 口径）`
      + `${ok ? '落在' : '超出'}规格 ${spec.name} 区间 ${(min * 100).toFixed(0)}%~${(max * 100).toFixed(0)}%`,
      { method: 'bbox-estimate', estimated: true, estimatedNote: 'core/face.js bbox 口径（0.30×人像框高），适用于源图，不适用于已裁切的成品', bbox });
  }

  // ---- 路径 2：从成品像素估算（颈部轮廓法） ----
  const mask = buildForegroundMask(img, opts);
  if (!mask) {
    return mkResult(false, null, { min, max },
      '无法测量头部占比：成品既无 alpha 通道，也无法用底色反推前景（环境不支持人脸检测，且图片不是纯色底成品）'
      + '｜注：开发者工具模拟器不支持人脸检测，真机才有实测值',
      { method: 'unavailable', estimated: true, estimatedNote: '未测量（不做臆测）' });
  }
  const est = estimateHeadRatioByNeck(mask.m, img.width, img.height);
  if (!est) {
    return mkResult(false, null, { min, max },
      '无法测量头部占比：前景掩膜可用，但未找到可靠的「头顶行」与「颈部最窄行」（人物可能被裁出画面）',
      { method: 'unavailable', estimated: true, estimatedNote: '未测量（不做臆测）' });
  }
  const ratio = est.headPx / img.height;
  const ok = ratio >= min - tolerance && ratio <= max + tolerance;
  const detail = `头部占比 ${(ratio * 100).toFixed(1)}%（**估算值**：颈部轮廓法，头顶行 ${est.crownY}px、下巴行 ${est.chinY}px、头长 ${est.headPx}px ÷ 图高 ${img.height}px）`
    + `${ok ? '落在' : '超出'}规格 ${spec.name} 区间 ${(min * 100).toFixed(0)}%~${(max * 100).toFixed(0)}%`
    + '｜局限：估算口径，误差约 ±5~8 个百分点，贴近边界时可能误判';
  return mkResult(ok, { ratio, method: 'neck-estimate', estimated: true }, { min, max, tolerance }, detail, {
    method: 'neck-estimate',
    estimated: true,
    estimatedNote: '估算值（颈部轮廓法），非实测；误差约 ±5~8 个百分点',
    crownY: est.crownY,
    chinY: est.chinY,
    headPx: est.headPx,
    maskSource: mask.source,
    notes: est.notes || [],
  });
}

/**
 * 构造成品的前景掩膜（Uint8Array，1=前景）。
 * 优先用 PNG 自带 alpha；否则用「与四角众数底色的差异」反推（纯色底证件照成立）。
 * @returns {{m:Uint8Array, source:string}|null}
 */
function buildForegroundMask(img, opts = {}) {
  const W = img.width;
  const H = img.height;
  const m = new Uint8Array(W * H);

  // ① 自带 alpha（PNG 透明底）
  let hasAlpha = false;
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] < 250) { hasAlpha = true; break; }
  }
  if (hasAlpha) {
    for (let i = 0; i < W * H; i++) m[i] = img.data[i * 4 + 3] > 127 ? 1 : 0;
    return { m, source: 'alpha' };
  }

  // ② 纯色底反推（JPG 成品）
  const dom = dominantCornerColor(img);
  if (!dom.rgb) return null;
  const bg = dom.rgb;
  const tol = opts.bgTolerance != null ? opts.bgTolerance : 42;
  let fgCount = 0;
  for (let i = 0; i < W * H; i++) {
    const p = [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]];
    if (colorDistance(p, bg) > tol) { m[i] = 1; fgCount++; }
  }
  // 前景几乎铺满 → 说明底色反推失败（背景本身是复杂纹理，不是纯色底）
  if (fgCount > W * H * 0.92) return null;
  if (fgCount < W * H * 0.02) return null;
  return { m, source: 'bg-diff' };
}

/**
 * 颈部轮廓法：从前景掩膜估算「头顶行 → 下巴行」。
 * 原理：证件照前景的行宽曲线呈「头顶窄 → 面部变宽 → 颈部收窄 → 肩部变宽」，
 *       颈缩最窄处即下巴位置。
 * @returns {{crownY:number, chinY:number, headPx:number, notes:string[]}|null}
 */
function estimateHeadRatioByNeck(mask, W, H) {
  const rowW = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    let n = 0;
    const off = y * W;
    for (let x = 0; x < W; x++) if (mask[off + x]) n++;
    rowW[y] = n;
  }
  let maxW = 0;
  for (let y = 0; y < H; y++) if (rowW[y] > maxW) maxW = rowW[y];
  if (maxW < 3) return null;

  // 头顶行：前景行宽首次超过「最大宽度的 6%」的行（忽略零星噪点）
  const crownThresh = Math.max(3, Math.round(maxW * 0.06));
  let crownY = -1;
  for (let y = 0; y < H; y++) {
    if (rowW[y] >= crownThresh) { crownY = y; break; }
  }
  if (crownY < 0) return null;

  // 肩线行：行宽最大值所在行（若在头顶附近说明没有明显肩部 → 放弃）
  let yMax = crownY;
  for (let y = crownY; y < H; y++) if (rowW[y] > rowW[yMax]) yMax = y;
  if (yMax - crownY < H * 0.15) return null;

  // 颈缩：在 [crownY + 15% 头区, yMax] 区间里找最窄行（下巴）
  const lo = Math.min(yMax - 1, crownY + Math.round((yMax - crownY) * 0.15));
  let chinY = lo;
  for (let y = lo; y <= yMax; y++) if (rowW[y] < rowW[chinY]) chinY = y;
  // 颈部必须确实是「缩窄」（比肩部窄 25% 以上），否则说明没找到颈部
  if (rowW[chinY] > rowW[yMax] * 0.75) return null;

  const headPx = chinY - crownY;
  if (headPx <= 0) return null;
  return {
    crownY,
    chinY,
    headPx,
    notes: [
      `行宽曲线: 顶 ${crownY}px(宽${rowW[crownY]}) / 颈 ${chinY}px(宽${rowW[chinY]}) / 肩 ${yMax}px(宽${rowW[yMax]})`,
    ],
  };
}

/** alpha>0.5 的前景包围盒（与 core/suit.js 的 alphaBBox 同口径，但不修改 core） */
function alphaBBoxOf(alpha, width, height) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 0.5) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// =====================================================================
// ④ 文件大小
// =====================================================================

/**
 * 断言成品文件大小 ≤ KB 上限。
 * 600dpi 档按产品口径（core/compliance.js）：KB 项降级为提示（advisory），
 * 不阻断、不计入不通过项 —— 这里保持一致：advisory=true 时 ok 恒为 true，
 * 但 severity='advisory' 且 detail 里明确写出超出量。
 * @param {string} file
 * @param {number} maxKb
 * @param {object} [opts] { advisory: boolean }
 */
function assertFileSize(file, maxKb, opts = {}) {
  const abs = path.resolve(file);
  let size;
  try {
    size = fs.statSync(abs).size;
  } catch (e) {
    return mkResult(false, null, maxKb, `读取文件大小失败: ${e.message}`);
  }
  const kb = size / 1024;
  const advisory = !!opts.advisory;
  const over = kb > maxKb;
  if (advisory) {
    return mkResult(true, { kb: Number(kb.toFixed(1)), bytes: size }, maxKb,
      over
        ? `文件 ${kb.toFixed(1)}KB 超过 ${maxKb}KB 上限，但当前为提示项（600dpi 印刷级：KB 上限是 300dpi 口径，不适用）→ 不阻断`
        : `文件 ${kb.toFixed(1)}KB ≤ ${maxKb}KB（提示项）`,
      { advisory: true, severity: over ? 'advisory' : 'ok', over });
  }
  return mkResult(!over, { kb: Number(kb.toFixed(1)), bytes: size }, maxKb,
    over
      ? `文件 ${kb.toFixed(1)}KB 超过上限 ${maxKb}KB（超 ${(kb - maxKb).toFixed(1)}KB）`
      : `文件 ${kb.toFixed(1)}KB ≤ 上限 ${maxKb}KB`,
    { advisory: false, severity: over ? 'fail' : 'ok', over });
}

// =====================================================================
// ⑤ 水印检测
// =====================================================================

/**
 * 断言成品没有叠加文字水印。
 *
 * 【判定依据 —— 两条独立证据，取「或」】
 *   证据 A（**元数据扫描，确定性**）：读 PNG 的 tEXt/iTXt/zTXt 块、JPEG 的 COM/APPn 段，
 *          命中水印关键词（watermark / 水印 / 仅供 / 样张 / sample / preview / demo …）
 *          → 直接判失败。**零误报**，但只能抓「把水印信息写进文件」的粗心实现。
 *   证据 B（**像素启发式**）：纯色底证件照上的文字水印 = 一行**互不相连的笔画**。
 *          故不用「块 = 字形」的模型（汉字/字母由 5~6 块笔画组成，那样建模会**漏报**），
 *          而用「**子行**」模型：
 *            · 子行 = **底边（基线）对齐**的一组连通块（笔画高度可不同：
 *              'S' 的横笔 2px 高、竖笔 14px 高，但都坐在同一基线上）；
 *            · 候选子行须同时满足：
 *              ① ≥3 个笔画块；
 *              ② 同一颜色（平均色互相接近）；
 *              ③ **笔画细长**：min(宽,高) ≤ 0.34×行高（排版学性质：
 *                 文字笔画远细于字高；装饰方格是「厚」的 → 靠这一条排除格纹误报）；
 *              ④ 整行**悬浮于平坦背景**：整行外扩 5% 图高的环带中底色占比 ≥88%
 *                 （发丝/眼镜腿紧邻人像主体，周边不是平坦底色 → 被排除）；
 *              ⑤ 整行宽度 ≥ 3×行高；
 *              ⑥ 行高 ≥ 4px（1~2px 的行是 JPEG 压缩噪点，不是文字）；
 *            · **一次性判据**：候选子行 ≥3 条 → 判为**重复纹理**（格纹/花纹在多处重复），
 *              整图不报水印；<3 条 → 判为文字水印（真文字通常只出现一到两行）。
 *
 * 【实测标定（2026-10-28）】
 *   · 正样本：用 5×7 点阵字体渲染一行 "SAMPLE" → **能检出**（防止「永不报警」的假安全）；
 *   · 负样本：素材/测试截图/acceptance{,_suit}/ 共 22 张真实成品 → **0 误报**。
 *
 * 【局限（必须如实告知，不能当成强保证）】
 *   · 证据 B 是启发式：半透明水印（与底色色差 <42）会漏检；
 *   · 压在**人像身上**（而非平坦背景上）的水印会被「悬浮背景」约束漏掉；
 *   · 与人像主体**相连**的水印会被「主体排除」漏掉；
 *   · 单个字/单笔的水印不会被检出（需要 ≥3 块成行）；
 *   · **斜向平铺**的水印（行位置不固定）可能漏检；
 *   · 原图自带、且恰好满足全部 6 条约束的装饰图案仍可能误报。
 *   故结论应读作「未检出明显文字水印」，AC7 的最终确认仍需人眼过图。
 * @param {string} file
 * @param {object} [opts] 阈值覆盖
 */
function assertNoWatermark(file, opts = {}) {
  const abs = path.resolve(file);
  let img;
  try {
    img = loadPixels(abs);
  } catch (e) {
    return mkResult(false, null, null, `读取成品像素失败: ${e.message}`);
  }

  // ---------- 证据 A：元数据扫描（确定性） ----------
  const meta = scanWatermarkMetadata(abs);
  if (meta.hits.length) {
    return mkResult(false, { metadataHits: meta.hits, metadataSource: meta.source },
      { metadataHits: [] },
      `检出文件元数据中的水印标记：${meta.hits.map((h) => `${h.source}:${h.keyword}`).join(', ')}`
      + '（确定性证据：导出流程把水印信息写进了文件）',
      { method: 'metadata+heuristic', checked: true, evidence: 'metadata' });
  }

  // ---------- 证据 B：像素启发式 ----------
  const dom = dominantCornerColor(img);
  if (!dom.rgb) {
    return mkResult(true, { checked: false }, 'no-watermark',
      '成品为透明底 PNG，四角无基准色可比 → 像素启发式无法检出（透明底另由底色断言把关；元数据已扫描通过）',
      { method: 'metadata+heuristic', checked: true, evidence: 'metadata', estimatedNote: '透明底，跳过像素启发式' });
  }
  const bg = dom.rgb;
  const bgDist = opts.bgTolerance != null ? opts.bgTolerance : 42;
  const W = img.width;
  const H = img.height;

  // 非背景掩膜 + 底色掩膜
  const diff = new Uint8Array(W * H);
  const isBg = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (img.data[i + 3] < 250) { isBg[y * W + x] = 1; continue; }
      const p = [img.data[i], img.data[i + 1], img.data[i + 2]];
      const near = colorDistance(p, bg) <= bgDist;
      isBg[y * W + x] = near ? 1 : 0;
      diff[y * W + x] = near ? 0 : 1;
    }
  }

  // 连通块标记（4 邻域）
  const label = new Int32Array(W * H).fill(-1);
  const blocks = [];
  const stack = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const s = y * W + x;
      if (!diff[s] || label[s] !== -1) continue;
      const id = blocks.length;
      const blk = { id, x0: x, x1: x, y0: y, y1: y, count: 0, r: 0, g: 0, b: 0 };
      stack.length = 0;
      stack.push(s);
      label[s] = id;
      while (stack.length) {
        const cur = stack.pop();
        const cy = (cur / W) | 0;
        const cx = cur - cy * W;
        blk.count++;
        blk.r += img.data[cur * 4];
        blk.g += img.data[cur * 4 + 1];
        blk.b += img.data[cur * 4 + 2];
        if (cx < blk.x0) blk.x0 = cx;
        if (cx > blk.x1) blk.x1 = cx;
        if (cy < blk.y0) blk.y0 = cy;
        if (cy > blk.y1) blk.y1 = cy;
        for (let k = 0; k < 4; k++) {
          let n;
          if (k === 0) n = cx > 0 ? cur - 1 : -1;
          else if (k === 1) n = cx < W - 1 ? cur + 1 : -1;
          else if (k === 2) n = cy > 0 ? cur - W : -1;
          else n = cy < H - 1 ? cur + W : -1;
          if (n < 0) continue;
          if (!diff[n] || label[n] !== -1) continue;
          label[n] = id;
          stack.push(n);
        }
      }
      blk.mean = [Math.round(blk.r / blk.count), Math.round(blk.g / blk.count), Math.round(blk.b / blk.count)];
      blocks.push(blk);
    }
  }

  if (!blocks.length) {
    return mkResult(true, { suspectCount: 0, suspects: [], bgHex: dom.hex, blocks: 0 }, { suspectCount: 0 },
      `未检出文字水印：元数据无水印标记；整图为纯背景色（${dom.hex}），无任何非背景连通块`,
      { method: 'metadata+heuristic', checked: true, evidence: 'both-clean' });
  }

  // 主体 = 最大连通块（人像）
  let subject = blocks[0];
  for (const b of blocks) if (b.count > subject.count) subject = b;
  const subjectId = subject.id;

  const minGlyphCount = opts.minGlyphCount != null ? opts.minGlyphCount : 3;
  const isolationRatio = opts.isolationRatio != null ? opts.isolationRatio : 0.88;
  // 隔离边距：**按图高比例**取（默认 5% 图高）。
  // 为什么不能太小：文字水印画在**开阔背景**上，其四周都是平坦底色；
  //   而人像碎块（发丝/眼镜腿/衣领碎块）虽然也在背景区，但它们**紧邻主体**，
  //   离主体越近、背后的平坦区域越小 → 边距取 5% 图高时这些块被正确排除。
  //   实测：3px 固定边距在 22 张真实成品上误报 1 张；5% 比例 → 误报 0 张，
  //   且文字水印正样本仍能检出。
  const isolationMargin = opts.isolationMargin != null
    ? opts.isolationMargin
    : Math.max(4, Math.round(H * 0.05));
  const maxGlyphHeightRatio = opts.maxGlyphHeightRatio != null ? opts.maxGlyphHeightRatio : 0.12;
  const colorTol = opts.colorTol != null ? opts.colorTol : 60;
  const subRowTol = opts.subRowTol != null ? opts.subRowTol : 3;
  const minRowWidthFactor = opts.minRowWidthFactor != null ? opts.minRowWidthFactor : 3;
  const repeatRowThreshold = opts.repeatRowThreshold != null ? opts.repeatRowThreshold : 3;
  const maxStrokeThinRatio = opts.maxStrokeThinRatio != null ? opts.maxStrokeThinRatio : 0.34;
  const minRowHeight = opts.minRowHeight != null ? opts.minRowHeight : 4;

  /**
   * 「悬浮于平坦背景上」判定。
   * 关键：对**整行**判定，而不是对单个笔画块判定 ——
   *   · 文字的一行里，笔画彼此紧邻（字内笔画），单块的外环带里混着邻笔画的像素
   *     → 按块判会误以为「不是悬浮的」→ 漏报；
   *   · 而整行的外环带（行上方/下方/左右）确实是平坦底色。
   * @param {object} sr 子行 {x0,y0,x1,y1}
   */
  const isRowIsolated = (sr) => {
    const m = isolationMargin;
    let bgCount = 0;
    let total = 0;
    for (let y = sr.y0 - m; y <= sr.y1 + m; y++) {
      if (y < 0 || y >= H) continue;
      for (let x = sr.x0 - m; x <= sr.x1 + m; x++) {
        if (x < 0 || x >= W) continue;
        if (x >= sr.x0 && x <= sr.x1 && y >= sr.y0 && y <= sr.y1) continue; // 跳过行内部
        total++;
        if (isBg[y * W + x]) bgCount++;
      }
    }
    return total > 0 && bgCount / total >= isolationRatio;
  };

  // 子行：**基线（底边）对齐**的一组连通块。
  //   真实文字的一行字母，其各笔画的底边对齐基线（但高度各异：
  //   'S' 的横笔 2px 高、竖笔 14px 高）→ 底边分组能把一行文字聚起来；
  //   而顶边分组做不到（笔画顶边不齐）→ 会漏报。
  //   格纹/花纹：每排格子的底边也对齐 → 聚成很多子行 → 由「一次性判据」排除。
  const minors = blocks.filter((b) => b.id !== subjectId && b.count >= 2);
  const subRows = [];
  for (const b of minors) {
    const bh = b.y1 - b.y0 + 1;
    if (bh > H * maxGlyphHeightRatio) continue;   // 字号约束
    let target = null;
    for (const sr of subRows) {
      if (Math.abs(sr.y1 - b.y1) > subRowTol) continue;      // 底边须对齐（基线）
      const topSpread = Math.max(sr.y0, b.y0) - Math.min(sr.y0, b.y0);
      if (topSpread > H * maxGlyphHeightRatio) continue;     // 顶边高度差须受限
      target = sr;
      break;
    }
    if (target) {
      target.items.push(b);
      target.y0 = Math.min(target.y0, b.y0);
      target.x0 = Math.min(target.x0, b.x0);
      target.x1 = Math.max(target.x1, b.x1);
    } else {
      subRows.push({ y0: b.y0, y1: b.y1, x0: b.x0, x1: b.x1, items: [b] });
    }
  }

  // 候选子行
  const candidates = [];
  for (const sr of subRows) {
    if (sr.items.length < minGlyphCount) continue;
    const rowH = sr.y1 - sr.y0 + 1;
    const rowW = sr.x1 - sr.x0 + 1;
    if (rowH < minRowHeight) continue;                   // 行高须有下限（1~2px 的行是压缩噪点，不是文字）
    if (rowW < rowH * minRowWidthFactor) continue;  // 整行宽度须明显大于行高
    const refColor = sr.items[0].mean;
    const sameColor = sr.items.filter((b) => colorDistance(b.mean, refColor) <= colorTol);
    if (sameColor.length < minGlyphCount) continue;
    // 笔画「细长」判据（排版学性质）：文字的笔画宽度显著小于字高；
    // 而装饰方格/色块是「厚」的（宽高比接近 1）→ 靠这一条排除格纹类误报。
    const thinStrokes = sameColor.filter((b) => {
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      return Math.min(bw, bh) >= 2 && Math.min(bw, bh) <= Math.max(2, Math.round(rowH * maxStrokeThinRatio));
    });
    if (thinStrokes.length < minGlyphCount) continue;
    if (!isRowIsolated(sr)) continue;   // 整行须悬浮于平坦背景
    candidates.push({
      x: sr.x0, y: sr.y0, w: rowW, h: rowH,
      glyphs: thinStrokes.length,
      glyphHeights: thinStrokes.map((b) => b.y1 - b.y0 + 1),
      glyphColors: thinStrokes.map((b) => toHex(b.mean)),
    });
  }

  // 一次性判据：候选子行多 → 重复纹理（格纹/花纹在多处重复；文字只出现一次）
  // 注意：格纹的每一排都可能单独成为候选子行 → 数量远大于文字 → 可靠区分。
  const isTexture = candidates.length >= repeatRowThreshold;
  const suspects = isTexture ? [] : candidates;

  const ok = suspects.length === 0;
  const detail = ok
    ? `未检出文字水印：①元数据无水印标记；②像素启发式：背景基准色 ${dom.hex}，非背景连通块 ${blocks.length} 个（人像主体 ${subject.count}px 已排除），`
      + `成行候选子行 ${candidates.length} 条`
      + (isTexture ? `（≥${repeatRowThreshold} 条 → 判为重复纹理/格纹，非一次性文字）` : '，均未达「≥3 块 + 同色 + 悬浮平坦背景」门槛')
      + '｜局限：启发式检测，半透明 / 压在人像身上 / 与主体相连 / 单字 / 斜向平铺水印会漏检'
    : `检出 ${suspects.length} 处疑似文字水印：`
      + suspects.slice(0, 3).map((s) => `(起点 ${s.x},${s.y} 宽${s.w} 高${s.h}，${s.glyphs} 个笔画块，高度 ${s.glyphHeights.join('/')}px，颜色 ${s.glyphColors.slice(0, 3).join(' ')})`).join(' ')
      + '｜判定依据：背景区存在一次性出现的「同色 + 悬浮平坦背景 + 横向成行」笔画组';
  return mkResult(ok, { suspectCount: suspects.length, suspects: suspects.slice(0, 10), bgHex: dom.hex, blocks: blocks.length, subjectPx: subject.count, candidateRows: candidates.length, isTexture },
    { suspectCount: 0 }, detail,
    { method: 'metadata+heuristic', checked: true, evidence: 'pixel-heuristic', estimatedNote: '像素启发式（子行模型）：不是逐像素基准比对，不能保证检出全部水印' });
}

/**
 * 扫描文件元数据里的水印标记（确定性证据）。
 * 支持 PNG tEXt/iTXt/zTXt 块、JPEG COM 段。
 * @returns {{source:string, hits:Array<{source:string, keyword:string}>}}
 */
function scanWatermarkMetadata(abs) {
  const hits = [];
  const keywords = [
    'watermark', 'water mark', '水印', '仅供', '样张', '示例', 'sample', 'preview', 'demo',
    'test only', 'not for', 'copyright overlay', 'adobe photoshop', 'trial', 'evaluation',
  ];
  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (e) {
    return { source: 'none', hits };
  }
  const lower = buf.toString('latin1').toLowerCase();
  const utf8 = buf.toString('utf8').toLowerCase();

  if (isPngBuffer(buf)) {
    // PNG 文本块
    let off = 8;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      if (dataEnd > buf.length) break;
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const txt = buf.slice(dataStart, dataEnd).toString('latin1').toLowerCase();
        for (const k of keywords) {
          if (txt.includes(k.toLowerCase())) hits.push({ source: 'PNG:' + type, keyword: k });
        }
      }
      off = dataEnd + 4;
      if (type === 'IEND') break;
    }
    return { source: 'png-chunks', hits };
  }

  if (isJpegBuffer(buf)) {
    // JPEG COM 段（注释）与 APPn 段
    let off = 2;
    while (off + 4 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue; }
      const marker = buf[off + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
      const len = buf.readUInt16BE(off + 2);
      if (len < 2) break;
      const seg = buf.slice(off + 4, off + 2 + len).toString('latin1').toLowerCase();
      if (marker === 0xfe || (marker >= 0xe0 && marker <= 0xef)) {
        for (const k of keywords) {
          if (seg.includes(k.toLowerCase())) hits.push({ source: 'JPEG:marker' + marker.toString(16), keyword: k });
        }
      }
      off += 2 + len;
      if (marker === 0xda) break; // 扫描数据开始，后面是压缩像素
    }
    return { source: 'jpeg-segments', hits };
  }

  void lower;
  void utf8;
  return { source: 'none', hits };
}

// =====================================================================
// ⑥ 换装不盖脸
// =====================================================================

/**
 * 断言换装前后**脸部区域**像素基本不变（PRD D2「禁止改动五官」）。
 *
 * 【判定依据】
 *   1. 取「换装前」与「换装后」两张图（须同尺寸，否则先拒绝判定）；
 *   2. 在给定 faceRect（或自动估计的脸部区域）内逐像素比 RGB；
 *   3. 判定：显著变化像素占比 < maxDiffRatio（默认 2%）且平均通道差 < maxMeanDiff（默认 6）。
 *      显著变化定义：任一通道差 > diffThreshold（默认 24，即 ~10% 满量程）。
 *
 * 【faceRect 自动估计的局限】
 *   没有 faceDetect 时无法精确定位五官框；自动估计用「上部中央 1/3 区域」近似，
 *   该区域可能包含头发/额头（换装本就不该覆盖），故**可能误报**；
 *   传入真实 faceRect 才是准确判定。faceRect 缺省时结果标注 estimated=true。
 *
 * 【复用说明】
 *   优先复用 **core/suitDiff.js** 的 compareFaceRegion（owner 2026-10-28 新增），
 *   使断言与产品共用同一套判定口径；该文件不存在时回退到本函数内的独立实现。
 *   两种路径下本文件都**不修改 core/**。
 *
 * @param {string} beforePath 换装前图
 * @param {string} afterPath 换装后图
 * @param {object} [opts] { faceRect:{x,y,w,h}, maxDiffRatio, maxMeanDiff, diffThreshold }
 */
function assertSuitNotCoverFace(beforePath, afterPath, opts = {}) {
  let a;
  let b;
  try {
    a = loadPixels(beforePath);
    b = loadPixels(afterPath);
  } catch (e) {
    return mkResult(false, null, null, `读取换装前后图片失败: ${e.message}`);
  }
  if (a.width !== b.width || a.height !== b.height) {
    return mkResult(false, { before: [a.width, a.height], after: [b.width, b.height] }, 'same size',
      `换装前后尺寸不同（${a.width}×${a.height} vs ${b.width}×${b.height}）→ 无法逐像素比对，请传同规格同 dpi 的两张图`);
  }

  let rect = opts.faceRect || opts.rect || null;
  let estimated = false;
  if (!rect) {
    rect = autoFaceRect(a);
    estimated = true;
    if (!rect) {
      return mkResult(false, null, 'faceRect', '无法自动估计脸部区域（图像异常），请显式传入 faceRect {x,y,w,h}');
    }
  }
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(a.width - 1, Math.round(rect.x + rect.w) - 1);
  const y1 = Math.min(a.height - 1, Math.round(rect.y + rect.h) - 1);
  if (x1 <= x0 || y1 <= y0) {
    return mkResult(false, rect, 'valid faceRect', `faceRect 越界: ${JSON.stringify(rect)}（图 ${a.width}×${a.height}）`);
  }

  const diffThreshold = opts.diffThreshold != null ? opts.diffThreshold : 24;
  const maxDiffRatio = opts.maxDiffRatio != null ? opts.maxDiffRatio : 0.02;
  const maxMeanDiff = opts.maxMeanDiff != null ? opts.maxMeanDiff : 6;

  // 优先复用 core/suitDiff.js 的 compareFaceRegion（与产品同一套口径）
  let changed = 0;
  let total = 0;
  let sumDiff = 0;
  let maxDiff = 0;
  let ratio = 0;
  let meanDiff = 0;
  let usedCore = false;
  if (coreSuitDiff && typeof coreSuitDiff.compareFaceRegion === 'function') {
    const coreRes = coreSuitDiff.compareFaceRegion(
      a.data, b.data,
      { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, imageWidth: a.width, imageHeight: a.height },
      { maxChangedRatio: maxDiffRatio, channelThreshold: diffThreshold },
    );
    usedCore = true;
    changed = coreRes.changed;
    total = coreRes.total;
    maxDiff = coreRes.maxDiff;
    ratio = coreRes.changedRatio;
    // 平均通道差（core 只给 changedRatio 与 maxDiff，这里补算，供判定用）
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * a.width + x) * 4;
        sumDiff += (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
      }
    }
    meanDiff = total ? sumDiff / total : 0;
  } else {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * a.width + x) * 4;
        const dr = Math.abs(a.data[i] - b.data[i]);
        const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
        const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
        const d = Math.max(dr, dg, db);
        sumDiff += (dr + dg + db) / 3;
        if (d > maxDiff) maxDiff = d;
        if (d > diffThreshold) changed++;
        total++;
      }
    }
    ratio = total ? changed / total : 0;
    meanDiff = total ? sumDiff / total : 0;
  }
  const ok = ratio <= maxDiffRatio && meanDiff <= maxMeanDiff;
  const detail = ok
    ? `脸部区域 (${x0},${y0})-(${x1},${y1}) 共 ${total}px：显著变化像素 ${changed}（${(ratio * 100).toFixed(2)}% ≤ ${(maxDiffRatio * 100).toFixed(0)}%），平均通道差 ${meanDiff.toFixed(2)} ≤ ${maxMeanDiff} → 换装未改动五官像素`
    : `脸部区域 (${x0},${y0})-(${x1},${y1}) 共 ${total}px：显著变化像素 ${changed}（${(ratio * 100).toFixed(2)}%，阈值 ${(maxDiffRatio * 100).toFixed(0)}%），平均通道差 ${meanDiff.toFixed(2)}（阈值 ${maxMeanDiff}），最大单像素差 ${maxDiff} → 疑似换装覆盖脸部`;
  return mkResult(ok, { changedPixels: changed, totalPixels: total, ratio: Number(ratio.toFixed(5)), meanDiff: Number(meanDiff.toFixed(3)), maxDiff },
    { maxDiffRatio, maxMeanDiff, diffThreshold },
    detail,
    { method: usedCore ? 'core/suitDiff.compareFaceRegion' : 'pixel-diff(自实现)', estimated, estimatedNote: estimated ? 'faceRect 为自动近似（肤色检测），非精确五官框，可能误报；传入真实 faceRect 更准' : null, faceRect: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } });
}

/**
 * 估计脸部区域（用于换装盖脸比对）。
 * 优先用**肤色检测**（YCbCr 近似，经典 RGB 规则）：在图像上半部分找肤色像素的
 * 包围盒 —— 比「上部中央固定框」准得多，因为证件照的脸就在上半部分居中。
 * 肤色检测失败时回退到「上部中央 1/3 区域」的粗略框（并标注 estimated）。
 * @returns {{x:number,y:number,w:number,h:number, method:string, skinPixels:number}}
 */
function autoFaceRect(img) {
  const w = img.width;
  const h = img.height;
  // 肤色规则（经典）：R>G>B 且 R-G>15、R-B>15、最大最小通道差>15
  const isSkin = (r, g, b) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return r > 95 && g > 40 && b > 20 && mx - mn > 15 && r > g && r > b;
  };
  // 只在上 65% 高度内找（脸不会在图片下半部分）
  const scanH = Math.round(h * 0.65);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  let n = 0;
  // 逐行统计肤色像素数，避免被颈部/手臂等零散肤色拉大包围盒
  const rowCount = new Int32Array(scanH);
  for (let y = 0; y < scanH; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (isSkin(img.data[i], img.data[i + 1], img.data[i + 2])) c++;
    }
    rowCount[y] = c;
  }
  // 取肤色行数 ≥ 峰值 25% 的行区间（脸的主干区域）
  let peak = 0;
  for (let y = 0; y < scanH; y++) if (rowCount[y] > peak) peak = rowCount[y];
  if (peak >= 8) {
    const thr = Math.max(3, Math.round(peak * 0.25));
    for (let y = 0; y < scanH; y++) {
      if (rowCount[y] < thr) continue;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (!isSkin(img.data[i], img.data[i + 1], img.data[i + 2])) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        n++;
      }
    }
  }
  if (maxX > minX && maxY > minY && n >= 200) {
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, method: 'skin-detection', skinPixels: n };
  }
  // 回退：上部中央
  const rw = Math.round(w * 0.42);
  const rh = Math.round(h * 0.3);
  return { x: Math.round((w - rw) / 2), y: Math.round(h * 0.12), w: rw, h: rh, method: 'upper-center-fallback', skinPixels: n };
}

// ---------------------------------------------------------------------
// 水印检测正样本辅助：5×7 点阵字体渲染（仅用于自测构造带文字水印的图）
// ---------------------------------------------------------------------

/** 5×7 点阵字体（每字符 7 行 × 5 列，'1' = 亮点） */
const SELFTEST_FONT_5x7 = {
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/**
 * 在已有的 RGBA 缓冲上绘制一行点阵文字（自测用，模拟叠加式文字水印）。
 * @param {Uint8Array} data RGBA
 * @param {number} w @param {number} h
 * @param {string} text 要绘制的字符（仅支持 SELFTEST_FONT_5x7 里的字母）
 * @param {number} ox 左上角 x @param {number} oy 左上角 y
 * @param {number} scale 每个点阵像素放大几倍
 * @param {number[]} color 文字颜色 RGB
 */
function drawPixelText(data, w, h, text, ox, oy, scale, color) {
  let cursorX = ox;
  for (const ch of text.toUpperCase()) {
    const glyph = SELFTEST_FONT_5x7[ch];
    if (glyph) {
      for (let gy = 0; gy < glyph.length; gy++) {
        for (let gx = 0; gx < glyph[gy].length; gx++) {
          if (glyph[gy][gx] !== '1') continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const x = cursorX + gx * scale + sx;
              const y = oy + gy * scale + sy;
              if (x < 0 || y < 0 || x >= w || y >= h) continue;
              const i = (y * w + x) * 4;
              data[i] = color[0];
              data[i + 1] = color[1];
              data[i + 2] = color[2];
              data[i + 3] = 255;
            }
          }
        }
      }
    }
    cursorX += 6 * scale; // 5 列 + 1 列字距
  }
}

// =====================================================================
// ⑦ 脸部区域干净（不是纯色 / 不是花屏）
// =====================================================================

/**
 * 断言换装**没有覆盖脸部**（PRD D2「禁止改动五官」/ AC6）。
 *
 * 【本函数是 assertSuitNotCoverFace 的「单图版」】
 *   assertSuitNotCoverFace 需要「换装前 + 换装后」两张同尺寸图；
 *   本函数只需**换装后一张图**，用「肤色被西装色取代」判据，
 *   便于在批量验收里对每个换装成品单独跑。
 *
 * 【判定依据 —— 肤色行 vs 西装行的分布】
 *   1. 肤色规则（经典 RGB 规则）找出成品中的肤色像素；
 *   2. 西装模板色规则（暗、冷调：黑 #22252E / 深蓝 #2E3A59 / 灰 #6B7280，
 *      判据与 工具链/suit_pixel_check.py 同款）找出西装像素；
 *   3. 逐行统计 → 肤色行区间 [skinTop, skinBot]；
 *   4. 西装起始行取「**从图底往上连续存在西装像素的那一段**的顶端」
 *      （不能取第一个有西装像素的行 —— **头发**也是暗冷调，会被误判成西装）；
 *   5. 若西装起始行 < 肤色结束行 → 西装盖到了脸部下半（鼻/嘴）。
 *
 * 【实测准确度（2026-10-28，11 张真实 T3 成品 + 合成正负样本）】
 *   · 本函数（单图）检出 7/9 张真盖脸、0 假阳（2 张漏检）；
 *   · assertSuitKeepsFacePixels（有换装前参考图）检出 9/9、0 假阳。
 *   → **有参考图时一律用 assertSuitKeepsFacePixels**；本函数只作无参考图时的筛查。
 *
 * 【局限（必须如实告知）】
 *   · 肤色规则对暖色滤镜/暗光/非东亚肤色可能失效；
 *   · 西装色规则针对本项目 3 套自绘模板（黑/深蓝/灰）调校，换色需重新标定；
 *   · 人物本身穿深色衣服、或脖子裸露且肤色延续到胸部时，可能误报/漏报。
 *
 * @param {string} file 换装后成品
 * @param {object} [opts] { faceRect, maxSuitInFaceRatio, skinMinRows }
 */
function assertSuitDoesNotCoverFace(file, opts = {}) {
  let img;
  try {
    img = loadPixels(file);
  } catch (e) {
    return mkResult(false, null, null, `读取成品像素失败: ${e.message}`);
  }
  const W = img.width;
  const H = img.height;

  const isSkin = (r, g, b) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return r > 95 && g > 40 && b > 20 && mx - mn > 15 && r > g && r > b;
  };
  // 西装模板三色（黑 #22252E / 深蓝 #2E3A59 / 灰 #6B7280）：暗且冷调
  // 判据沿用 工具链/suit_pixel_check.py 的口径：v∈[18,170] ∧ db=b-r∈[-6,60] ∧ dg=g-r∈[-12,20]
  const isSuit = (r, g, b) => {
    const v = (r + g + b) / 3;
    if (v > 170 || v < 18) return false;
    const db = b - r;
    const dg = g - r;
    return db >= -6 && db <= 60 && dg >= -12 && dg <= 20 && !(r > g && r > b);
  };

  // ① 逐行统计肤色 / 西装像素
  const skinRow = new Int32Array(H);
  const suitRow = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    let s = 0;
    let t = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (isSkin(r, g, b)) s++;
      else if (isSuit(r, g, b)) t++;
    }
    skinRow[y] = s;
    suitRow[y] = t;
  }

  // ② 肤色行的有效区间
  const skinMinRows = opts.skinMinRows != null ? opts.skinMinRows : Math.max(2, Math.round(W * 0.02));
  let skinTop = -1;
  let skinBot = -1;
  for (let y = 0; y < H; y++) {
    if (skinRow[y] >= skinMinRows) {
      if (skinTop < 0) skinTop = y;
      skinBot = y;
    }
  }
  if (skinTop < 0) {
    return mkResult(false, null, 'face detected',
      '未在成品中检测到肤色像素 → 无法判定盖脸（可能是肤色规则失效、或人脸已被完全覆盖）'
      + '｜此结果应视为**可疑**，需人工复核',
      { method: 'skin-vs-suit', estimated: true, estimatedNote: '肤色检测失败，无法判定' });
  }

  // ③ 西装的「起始行」：取「从图底往上、连续存在西装像素的那一段」的顶端
  //   （头发也是暗冷调，会被误判成西装；但头发与西装是分离的两段，连续段法可排除）
  let suitTop = -1;
  {
    const isSuitRow = (y) => suitRow[y] >= skinMinRows;
    let y = H - 1;
    while (y >= 0 && !isSuitRow(y)) y--;
    if (y >= 0) {
      let top = y;
      while (top - 1 >= 0 && isSuitRow(top - 1)) top--;
      suitTop = top;
    }
  }

  // ④ 判据 A：**皮肤区下边界的形态** —— 这是区分「西装盖住脸」与「西装在脸下方」的关键。
  //   · 正常（西装在脸下方/领口 V 形）：肤色行宽是**逐行收窄**的（下颌→脖子），
  //     所以肤色结束行处的宽度远小于该区的最大宽度 → 收窄比很小；
  //   · 盖脸（西装横切在脸上）：肤色行宽在结束行处**仍然接近最大宽度**
  //     （因为被切掉的是脸的下半，脸的上半仍很宽）→ 收窄比接近 1。
  //   实测标定（真实成品 22 张 + 合成正/负样本）：
  //     盖脸样本收窄比 0.93；正常样本 0.03~0.16 → 阈值取 0.5。
  let maxSkinRow = 0;
  for (let y = skinTop; y <= skinBot; y++) if (skinRow[y] > maxSkinRow) maxSkinRow = skinRow[y];
  const taperRatio = maxSkinRow ? skinRow[skinBot] / maxSkinRow : 0;
  const maxTaperRatio = opts.maxTaperRatio != null ? opts.maxTaperRatio : 0.5;
  // 「皮肤区末端突然截断」= 收窄比高（脸被横切）
  const abruptCut = taperRatio > maxTaperRatio;
  // 「西装起始行早于肤色结束行」= 西装与皮肤区在纵向重叠
  const overlapsFace = suitTop >= 0 && suitTop < skinBot;
  // ⑤ 判据 B：脸部框内西装像素占比
  let rect = opts.faceRect || opts.rect || null;
  let rectMethod = 'given';
  if (!rect) {
    rect = autoFaceRect(img);
    rectMethod = rect.method;
  }
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(W - 1, Math.round(rect.x + rect.w) - 1);
  const y1 = Math.min(H - 1, Math.round(rect.y + rect.h) - 1);
  let suitInFace = 0;
  let faceTotal = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      faceTotal++;
      if (isSuit(img.data[i], img.data[i + 1], img.data[i + 2])) suitInFace++;
    }
  }
  const suitRatio = faceTotal ? suitInFace / faceTotal : 0;
  const maxSuitInFaceRatio = opts.maxSuitInFaceRatio != null ? opts.maxSuitInFaceRatio : 0.12;

  const coverByRatio = suitRatio > maxSuitInFaceRatio;
  const ok = !abruptCut && !coverByRatio;

  const detail = `肤色行 ${skinTop}~${skinBot}px（末端收窄比 ${taperRatio.toFixed(2)}，阈值 ${maxTaperRatio}）；`
    + `西装起始行 ${suitTop < 0 ? '无' : suitTop + 'px'}；`
    + `脸部框 (${x0},${y0})-(${x1},${y1})（${rectMethod}）内西装像素占比 ${(suitRatio * 100).toFixed(1)}%（阈值 ${(maxSuitInFaceRatio * 100).toFixed(0)}%）`
    + (ok
      ? ' → 换装未覆盖脸部'
      : ` → **判定盖脸**${abruptCut ? `（肤色区末端被横切，收窄比 ${taperRatio.toFixed(2)} > ${maxTaperRatio}）` : ''}`
        + `${coverByRatio ? '（脸部框内西装像素超阈值）' : ''}`);
  return mkResult(ok,
    { skinTop, skinBot, suitTop, taperRatio: Number(taperRatio.toFixed(3)), suitInFaceRatio: Number(suitRatio.toFixed(4)), faceRect: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } },
    { maxSuitInFaceRatio, maxTaperRatio, requireNoOverlap: true },
    detail,
    {
      method: 'skin-vs-suit',
      estimated: rectMethod !== 'given',
      estimatedNote: rectMethod !== 'given'
        ? `脸部框由${rectMethod}自动估计（肤色检测），非精确五官框`
        : null,
    });
}

/**
 * 断言换装**没有改动脸部像素**（PRD D2 / AC6）—— 需要「换装前」参考图。
 *
 * 【判定依据 —— 同一张脸在两张图里的「肤色保持率」】
 *   T1（无换装）与 T3（有换装）走**同一条共享管线**（services/pipeline.ts）、同一规格
 *   → 裁剪几何一致，两图**逐像素对齐**。于是：
 *     ① 在**参考图**上找脸部区域（肤色像素的**连续行段**的包围盒 ——
 *        用连续段而不是全部肤色行，避免脖子/手臂把框拉大）；
 *     ② 只统计参考图里**是肤色**的像素；
 *     ③ 这些像素在换装图里**不再是肤色** → 说明被换装覆盖（改动/遮挡了脸）。
 *   判定：覆盖率 > maxCoveredRatio（默认 8%）→ 判为「换装盖脸」。
 *
 * 【为什么用「肤色保持率」而不是「逐像素差」】
 *   逐像素差会把底色变化（T1 白底 vs T3 蓝底）、JPEG 重压缩噪声全算进来 → 无法归因。
 *   「参考图是肤色、换装图不是肤色」这一条**只对脸部被覆盖**敏感，归因干净。
 *
 * 【局限】
 *   · 依赖两张图**几何对齐**（同规格同 dpi 同源图）；否则结果无意义；
 *   · 肤色规则失效时（暖光/滤镜/非东亚肤色）可能漏检；
 *   · 若人物原本就戴着深色口罩/围巾，参考图该处不是肤色 → 不计入 → 不误报。
 *
 * @param {string} referencePath 换装前参考图（如 T1 成品）
 * @param {string} afterPath 换装后成品（T3）
 * @param {object} [opts] { maxCoveredRatio, faceRect }
 */
function assertSuitKeepsFacePixels(referencePath, afterPath, opts = {}) {
  let ref;
  let aft;
  try {
    ref = loadPixels(referencePath);
    aft = loadPixels(afterPath);
  } catch (e) {
    return mkResult(false, null, null, `读取换装前后图片失败: ${e.message}`);
  }
  if (ref.width !== aft.width || ref.height !== aft.height) {
    return mkResult(false, { reference: [ref.width, ref.height], after: [aft.width, aft.height] }, 'same size',
      `换装前后尺寸不同（${ref.width}×${ref.height} vs ${aft.width}×${aft.height}）→ 无法逐像素比对`);
  }
  const isSkin = (r, g, b) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return r > 95 && g > 40 && b > 20 && mx - mn > 15 && r > g && r > b;
  };

  // ① 参考图上的连续肤色行段 → 脸框
  const W = ref.width;
  const H = ref.height;
  const row = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (isSkin(ref.data[i], ref.data[i + 1], ref.data[i + 2])) c++;
    }
    row[y] = c;
  }
  let peak = 0;
  for (let y = 0; y < H; y++) if (row[y] > peak) peak = row[y];
  const thr = Math.max(3, Math.round(peak * 0.25));
  let best = null;
  let segStart = -1;
  for (let y = 0; y < H; y++) {
    if (row[y] >= thr) {
      if (segStart < 0) segStart = y;
      let end = y;
      while (end + 1 < H && row[end + 1] >= thr) end++;
      const len = end - segStart + 1;
      if (!best || len > best.len) best = { start: segStart, end, len };
      y = end;
      segStart = -1;
    }
  }
  if (!best) {
    return mkResult(false, null, 'face detected',
      '参考图中未找到连续肤色区域 → 无法判定（可能是肤色规则失效）',
      { method: 'skin-retention', estimated: true, estimatedNote: '参考图肤色检测失败' });
  }
  let minX = W;
  let maxX = -1;
  for (let y = best.start; y <= best.end; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (!isSkin(ref.data[i], ref.data[i + 1], ref.data[i + 2])) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (maxX < minX) {
    return mkResult(false, null, 'face detected', '参考图肤色区域像素为空 → 无法判定',
      { method: 'skin-retention', estimated: true });
  }
  const rect = { x: minX, y: best.start, w: maxX - minX + 1, h: best.end - best.start + 1 };

  // ② 脸框内：参考图是肤色 → 换装图是否还是肤色
  let skinInRef = 0;
  let covered = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = (y * W + x) * 4;
      if (!isSkin(ref.data[i], ref.data[i + 1], ref.data[i + 2])) continue;
      skinInRef++;
      const j = (y * aft.width + x) * 4;
      if (!isSkin(aft.data[j], aft.data[j + 1], aft.data[j + 2])) covered++;
    }
  }
  const ratio = skinInRef ? covered / skinInRef : 0;
  const maxCoveredRatio = opts.maxCoveredRatio != null ? opts.maxCoveredRatio : 0.08;
  const ok = ratio <= maxCoveredRatio;
  const detail = `脸部框 (${rect.x},${rect.y})-(${rect.x + rect.w - 1},${rect.y + rect.h - 1})（参考图连续肤色段，${skinInRef} 肤色像素）中，`
    + `换装后**不再是肤色**的有 ${covered} 个 = ${(ratio * 100).toFixed(1)}%（阈值 ${(maxCoveredRatio * 100).toFixed(0)}%）`
    + (ok ? ' → 脸部像素基本未被换装覆盖' : ' → **换装覆盖了脸部像素**（AC6/D2 违规）');
  return mkResult(ok,
    { skinInRef, covered, coveredRatio: Number(ratio.toFixed(4)), faceRect: rect },
    { maxCoveredRatio },
    detail,
    { method: 'skin-retention', estimated: false });
}

/**
 * 断言成品脸部区域**不是纯色**（抠图失败/空白图）且**不是花屏**（噪点/马赛克）。
 *
 * 【判定依据】
 *   在脸部区域（faceRect 或自动估计）内计算灰度统计量：
 *   · 纯色判定：区域灰度标准差 < minStd（默认 3）→ 内容为纯色 → FAIL；
 *   · 花屏判定：区域**相邻像素梯度**的均值过高（> maxGrad，默认 26）
 *     且该梯度的**高频占比**过高（> highFreqRatio，默认 0.5）→ 判为噪点/花屏 → FAIL。
 *   依据：真实脸部区域既有平滑皮肤（梯度低）也有五官边缘（梯度高），
 *         整体梯度均值处于中段；纯色图梯度≈0；花屏图梯度几乎处处接近满量程。
 *
 * 【局限】人脸特写（大头照）梯度均值也可能偏高，可能误判为花屏；
 *         判为 FAIL 时 detail 会给出实际统计量供人工复核。
 *
 * @param {string} file
 * @param {object} [opts] { faceRect, minStd, maxGrad, highFreqRatio }
 */
function assertFaceRegionClean(file, opts = {}) {
  let img;
  try {
    img = loadPixels(file);
  } catch (e) {
    return mkResult(false, null, null, `读取成品像素失败: ${e.message}`);
  }
  let rect = opts.faceRect || opts.rect || null;
  let estimated = false;
  if (!rect) {
    rect = autoFaceRect(img);
    estimated = true;
  }
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(img.width - 1, Math.round(rect.x + rect.w) - 1);
  const y1 = Math.min(img.height - 1, Math.round(rect.y + rect.h) - 1);
  if (x1 <= x0 || y1 <= y0) {
    return mkResult(false, rect, 'valid faceRect', `faceRect 越界: ${JSON.stringify(rect)}`);
  }

  const minStd = opts.minStd != null ? opts.minStd : 3;
  const maxGrad = opts.maxGrad != null ? opts.maxGrad : 26;
  const highFreqRatio = opts.highFreqRatio != null ? opts.highFreqRatio : 0.5;

  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let gradSum = 0;
  let gradCount = 0;
  let highFreq = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.width + x) * 4;
      const L = luma(img.data[i], img.data[i + 1], img.data[i + 2]);
      n++; sum += L; sumSq += L * L;
      if (x < x1) {
        const j = i + 4;
        const L2 = luma(img.data[j], img.data[j + 1], img.data[j + 2]);
        const g = Math.abs(L - L2);
        gradSum += g; gradCount++;
        if (g > 40) highFreq++;
      }
    }
  }
  const mean = n ? sum / n : 0;
  const std = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;
  const gradMean = gradCount ? gradSum / gradCount : 0;
  const hfRatio = gradCount ? highFreq / gradCount : 0;

  const isFlat = std < minStd;
  const isNoisy = gradMean > maxGrad && hfRatio > highFreqRatio;
  const ok = !isFlat && !isNoisy;

  let detail = `脸部区域 (${x0},${y0})-(${x1},${y1})：灰度均值 ${mean.toFixed(1)}，标准差 ${std.toFixed(2)}，相邻像素梯度均值 ${gradMean.toFixed(2)}，高频像素占比 ${(hfRatio * 100).toFixed(1)}%`;
  if (isFlat) detail += ` → 判定为纯色/空白（标准差 ${std.toFixed(2)} < ${minStd}），抠图或合成可能失败`;
  else if (isNoisy) detail += ` → 判定为花屏/噪点（梯度均值 ${gradMean.toFixed(2)} > ${maxGrad} 且高频占比 ${(hfRatio * 100).toFixed(1)}% > ${(highFreqRatio * 100).toFixed(0)}%）`;
  else detail += ' → 区域有正常内容，非纯色、非花屏';

  return mkResult(ok, { mean: Number(mean.toFixed(2)), std: Number(std.toFixed(3)), gradMean: Number(gradMean.toFixed(3)), highFreqRatio: Number(hfRatio.toFixed(4)) },
    { minStd, maxGrad, highFreqRatio }, detail,
    { method: 'variance+gradient', estimated, estimatedNote: estimated ? 'faceRect 为自动近似（上部中央区域）' : null });
}

// =====================================================================
// ⑧ 组合断言（成品全量体检）
// =====================================================================

/**
 * 对一张成品跑一组业务断言，返回各项结果。
 * @param {string} file
 * @param {object} o { specId, dpi, bgHex, maxKb, advisorySize, faceRect, expectWatermarkFree }
 */
function assertProduct(file, o = {}) {
  const results = [];
  const specId = o.specId || 'one-inch';
  const dpi = o.dpi || 300;
  results.push({ name: 'assertPixelSize', ...assertPixelSize(file, specId, dpi) });
  if (o.bgHex != null) results.push({ name: 'assertBackgroundColor', ...assertBackgroundColor(file, o.bgHex, o.bgTolerance) });
  if (o.maxKb != null) results.push({ name: 'assertFileSize', ...assertFileSize(file, o.maxKb, { advisory: !!o.advisorySize }) });
  if (o.checkHeadRatio !== false) results.push({ name: 'assertHeadRatio', ...assertHeadRatio(file, specId, o.headTolerance || 0, { landmarks: o.landmarks, alpha: o.alpha }) });
  if (o.expectWatermarkFree !== false) results.push({ name: 'assertNoWatermark', ...assertNoWatermark(file) });
  if (o.checkFaceRegion !== false) results.push({ name: 'assertFaceRegionClean', ...assertFaceRegionClean(file, { faceRect: o.faceRect }) });
  const fail = results.filter((r) => !r.ok);
  return {
    file,
    pass: fail.length === 0,
    passCount: results.length - fail.length,
    failCount: fail.length,
    results,
    failed: fail.map((f) => ({ name: f.name, detail: f.detail })),
  };
}

// =====================================================================
// CLI
// =====================================================================

const HELP = `
业务断言库（纯 Node，不依赖 IDE）

用法:
  node 工具链/assert_business.js --assert <名称> [参数]
  node 工具链/assert_business.js --selftest

断言名称与参数:
  --assert pixel-size       --file <成品> --spec <specId> [--dpi 300]
  --assert bg-color         --file <成品> --expect <#RRGGBB|transparent> [--tol 12]
  --assert head-ratio       --file <成品> --spec <specId> [--tol 0]
  --assert file-size        --file <成品> --max-kb <n> [--advisory]
  --assert no-watermark     --file <成品>
  --assert suit-not-cover-face --before <换装前> --after <换装后> [--rect x,y,w,h]
  --assert suit-cover-face     --file <换装后成品> [--rect x,y,w,h]
  --assert suit-keep-face      --reference <换装前> --after <换装后>   # 肤色保持率口径
  --assert face-region-clean --file <成品> [--rect x,y,w,h]
  --assert product          --file <成品> [--spec one-inch] [--dpi 300] [--expect #RRGGBB] [--max-kb 200]
                             # 一次跑完整套业务断言（像素/底色/大小/头占比/水印/脸部干净）

通用:
  --json          以 JSON 输出结果
  --selftest      用 素材/真实头像/ + 手工构造成品自测全部断言
  --help          显示本帮助

规格 id: ${specLib.SPECS.map((s) => `${s.id}(${s.name})`).join(', ')}

退出码: 0 = 通过；1 = 断言失败；2 = 用法/环境错误
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function parseRect(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !isFinite(n))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function oneLine(name, r) {
  return `${r.ok ? 'PASS' : 'FAIL'} ${name.padEnd(24)} ${r.detail}`;
}

function runCli(argv) {
  const a = parseArgs(argv);
  if (a.help || (!a.assert && !a.selftest)) {
    console.log(HELP);
    return a.help ? 0 : 2;
  }
  if (a.selftest) return runSelfTest();

  const name = String(a.assert);
  let r;
  switch (name) {
    case 'pixel-size':
      r = assertPixelSize(a.file, a.spec || 'one-inch', Number(a.dpi || 300));
      break;
    case 'bg-color':
      r = assertBackgroundColor(a.file, a.expect || '#FFFFFF', Number(a.tol || 12));
      break;
    case 'head-ratio':
      r = assertHeadRatio(a.file, a.spec || 'one-inch', Number(a.tol || 0));
      break;
    case 'file-size':
      r = assertFileSize(a.file, Number(a.maxkb || 200), { advisory: !!a.advisory });
      break;
    case 'no-watermark':
      r = assertNoWatermark(a.file);
      break;
    case 'suit-not-cover-face':
      r = assertSuitNotCoverFace(a.before, a.after, { faceRect: parseRect(a.rect) });
      break;
    case 'suit-cover-face':
      r = assertSuitDoesNotCoverFace(a.file, { faceRect: parseRect(a.rect) });
      break;
    case 'suit-keep-face':
      r = assertSuitKeepsFacePixels(a.reference, a.after, { faceRect: parseRect(a.rect) });
      break;
    case 'face-region-clean':
      r = assertFaceRegionClean(a.file, { faceRect: parseRect(a.rect) });
      break;
    case 'product': {
      const spec = specLib.getSpec(a.spec || 'one-inch');
      const res = assertProduct(a.file, {
        specId: a.spec || 'one-inch',
        dpi: Number(a.dpi || 300),
        bgHex: a.expect || null,
        maxKb: a.maxkb ? Number(a.maxkb) : (spec ? spec.maxKb : null),
      });
      // 汇总成一行结论 + 逐条明细
      if (!a.json) {
        for (const item of res.results) {
          console.log(`  ${item.ok ? 'PASS' : 'FAIL'} ${item.name.padEnd(22)} ${item.detail}`);
        }
        console.log(`${res.pass ? 'PASS' : 'FAIL'} product                      ${res.passCount}/${res.passCount + res.failCount} 条业务断言通过`);
      }
      process.exit(res.pass ? 0 : 1);
    }
    default:
      console.error(`未知断言: ${name}\n`);
      console.log(HELP);
      return 2;
  }
  if (a.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(oneLine(name, r));
  }
  return r.ok ? 0 : 1;
}

// =====================================================================
// 自测（用真实素材 + 手工构造成品）
// =====================================================================

/** 构造一张纯色底的「伪成品」，用于验证断言的判定方向 */
function makeSolidProduct(file, w, h, hex) {
  const rgb = parseHex(hex);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  // 用自研 PNG 编码写盘：zlib + 最小 chunk 写入
  writePng(file, w, h, data);
  return file;
}

/** 最小 PNG 编码器（真彩色 RGBA，无滤波） */
function writePng(file, w, h, rgba) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);
  const chunks = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcBuf) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(sig, mk('IHDR', ihdr), mk('IDAT', idat), mk('IEND', Buffer.alloc(0)));
  fs.writeFileSync(file, Buffer.concat(chunks));
}

let _crcTable = null;
function crc32(buf) {
  if (!_crcTable) {
    _crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      _crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/** 构造带「脸部纹理」的伪成品：中央画一个明暗渐变椭圆，模拟人脸 */
function makeFaceProduct(file, w, h, bgHex) {
  const bg = parseHex(bgHex);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
  }
  const cx = w / 2;
  const cy = h * 0.38;
  const rx = w * 0.26;
  const ry = h * 0.3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        const t = (y - (cy - ry)) / (2 * ry);
        const base = 120 + 100 * t;
        // 加横向纹理（模拟五官/皮肤细节，避免被判纯色）
        const tex = 20 * Math.sin(x / 3) + 12 * Math.sin(y / 5);
        const i = (y * w + x) * 4;
        data[i] = Math.max(0, Math.min(255, base + tex));
        data[i + 1] = Math.max(0, Math.min(255, base * 0.85 + tex));
        data[i + 2] = Math.max(0, Math.min(255, base * 0.75 + tex));
      }
    }
  }
  writePng(file, w, h, data);
  return file;
}

/**
 * 构造一张「几何已知」的合成证件照：头部椭圆（顶点=头顶，底=下巴）+ 肩部梯形。
 * 用于**验证颈部轮廓法估算器**：已知真实头占比，可核对估算误差。
 * @param {string} file
 * @param {number} w @param {number} h
 * @param {string} bgHex
 * @param {number} headRatio 真实头占比（0~1），即 (下巴-头顶)/图高
 */
function makeSyntheticIdPhoto(file, w, h, bgHex, headRatio) {
  const bg = parseHex(bgHex);
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255;
  }
  const headPx = Math.round(h * headRatio);
  const crownY = Math.round(h * 0.06);            // 头顶留白
  const chinY = crownY + headPx;
  const cx = w / 2;
  const headRx = w * 0.3;
  const headRy = headPx / 2;
  const headCy = crownY + headRy;
  const neckHalfW = headRx * 0.36;                 // 颈部宽度（明显窄于头）
  const shoulderTop = chinY + Math.round(headPx * 0.22);

  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - cx) / headRx;
      const dy = (y - headCy) / headRy;
      if (dx * dx + dy * dy <= 1) {
        // 脸部：肤色 + 纵向渐变 + 轻微纹理（避免被判纯色）
        const t = (y - crownY) / headPx;
        const base = 150 + 70 * t;
        const tex = 12 * Math.sin(x / 4) + 8 * Math.sin(y / 6);
        put(x, y, base + tex, base * 0.82 + tex, base * 0.7 + tex);
        continue;
      }
      // 颈部
      if (y >= chinY - Math.round(headPx * 0.08) && y < shoulderTop && Math.abs(x - cx) <= neckHalfW) {
        put(x, y, 168, 138, 122);
        continue;
      }
      // 肩部：从颈部宽度渐变到全宽
      if (y >= shoulderTop) {
        const t = (y - shoulderTop) / Math.max(1, h - shoulderTop);
        const halfW = neckHalfW + (w / 2 - neckHalfW) * Math.min(1, t * 2.2);
        if (Math.abs(x - cx) <= halfW) {
          const shade = 60 + 40 * t;
          put(x, y, shade, shade * 0.9, shade * 0.85);
        }
      }
    }
  }
  writePng(file, w, h, data);
  return { file, crownY, chinY, headPx, trueRatio: headPx / h };
}

function runSelfTest() {
  const tmp = path.join(ROOT, '素材', '测试截图', '_assert_selftest');
  fs.mkdirSync(tmp, { recursive: true });
  const cases = [];
  const add = (name, r, expectOk) => {
    cases.push({ name, ok: !!r.ok, expectOk, detail: r.detail });
  };

  // --- 真实素材：能解码、尺寸可读 ---
  const real = path.join(ROOT, '素材', '真实头像', '111.jpg');
  let decoded = null;
  try {
    decoded = loadPixels(real);
  } catch (e) { /* 下面会记失败 */ }
  cases.push({
    name: 'selftest:解码真实素材',
    ok: !!decoded && decoded.width === 600 && decoded.height === 798,
    expectOk: true,
    detail: decoded ? `111.jpg 解码为 ${decoded.width}×${decoded.height}` : '解码失败',
  });

  // --- ① 像素尺寸 ---
  const good = makeSolidProduct(path.join(tmp, 'good_295x413.png'), 295, 413, '#FFFFFF');
  add('assertPixelSize(正确尺寸)', assertPixelSize(good, 'one-inch', 300), true);
  add('assertPixelSize(错误尺寸)', assertPixelSize(path.join(tmp, 'good_295x413.png'), 'two-inch', 300), false);

  // --- ② 底色 ---
  const blue = makeSolidProduct(path.join(tmp, 'blue.png'), 295, 413, '#438EDB');
  add('assertBackgroundColor(白底对白)', assertBackgroundColor(good, '#FFFFFF', 12), true);
  add('assertBackgroundColor(蓝底对白→FAIL)', assertBackgroundColor(blue, '#FFFFFF', 12), false);
  add('assertBackgroundColor(蓝底对蓝)', assertBackgroundColor(blue, '#438EDB', 12), true);
  // 真实成品（有 JPEG 噪点 + 人物）
  const realProduct = path.join(ROOT, '素材', '测试截图', 'acceptance', '111_result.jpg');
  if (fs.existsSync(realProduct)) {
    add('assertBackgroundColor(真实成品白底)', assertBackgroundColor(realProduct, '#FFFFFF', 12), true);
  }

  // --- ③ 头部占比 ---
  // (a) 无 alpha 无关键点、且是纯色图 → 无法判定（必须 FAIL，不能假通过）
  add('assertHeadRatio(纯色图无法测量→FAIL)', assertHeadRatio(good, 'one-inch', 0), false);
  // (b) 几何已知的合成证件照：真实头占比 0.66 → 估算应落在区间内
  const syn = makeSyntheticIdPhoto(path.join(tmp, 'syn_66.png'), 295, 413, '#438EDB', 0.66);
  const r66 = assertHeadRatio(path.join(tmp, 'syn_66.png'), 'one-inch', 0);
  add('assertHeadRatio(合成证件照 真实66%→估算落区间→PASS)', r66, true);
  const estPct = r66.actual ? (r66.actual.ratio * 100).toFixed(1) : 'N/A';
  const errPct = r66.actual ? (Math.abs(r66.actual.ratio - syn.trueRatio) * 100).toFixed(1) : 'N/A';
  console.log(`   [几何核对] 合成图真实头占比 ${(syn.trueRatio * 100).toFixed(1)}%（头顶${syn.crownY}px/下巴${syn.chinY}px），`
    + `估算 ${estPct}%，估算误差 ${errPct} 个百分点`);
  // (c) 真实头占比 0.35（头太小）→ 估算应低于区间 → FAIL
  makeSyntheticIdPhoto(path.join(tmp, 'syn_35.png'), 295, 413, '#438EDB', 0.35);
  add('assertHeadRatio(合成证件照 真实35%→超出区间→FAIL)', assertHeadRatio(path.join(tmp, 'syn_35.png'), 'one-inch', 0), false);
  // (d) 真实头占比 0.85（头太大）→ 估算应超出上限 → FAIL
  makeSyntheticIdPhoto(path.join(tmp, 'syn_85.png'), 295, 413, '#438EDB', 0.85);
  add('assertHeadRatio(合成证件照 真实85%→超出上限→FAIL)', assertHeadRatio(path.join(tmp, 'syn_85.png'), 'one-inch', 0), false);

  // --- ④ 文件大小 ---
  add('assertFileSize(小文件)', assertFileSize(good, 200), true);
  add('assertFileSize(advisory 超限不阻断)', assertFileSize(realProduct, 1, { advisory: true }), true);

  // --- ⑤ 水印 ---
  add('assertNoWatermark(纯色图)', assertNoWatermark(good), true);
  const faceProd = makeFaceProduct(path.join(tmp, 'face.png'), 295, 413, '#438EDB');
  add('assertNoWatermark(带人脸纹理图)', assertNoWatermark(faceProd), true);
  // 正样本（关键）：画一行**真实文字**水印 → 必须检出（否则是「永不报警」的假安全）
  {
    const wmFile = path.join(tmp, 'watermarked.png');
    const wmData = new Uint8Array(295 * 413 * 4);
    for (let i = 0; i < 295 * 413; i++) {
      wmData[i * 4] = 0x43; wmData[i * 4 + 1] = 0x8e; wmData[i * 4 + 2] = 0xdb; wmData[i * 4 + 3] = 255;
    }
    drawPixelText(wmData, 295, 413, 'SAMPLE', 30, 360, 2, [255, 255, 255]);
    writePng(wmFile, 295, 413, wmData);
    const rWm = assertNoWatermark(wmFile);
    add('assertNoWatermark(真实文字水印→必须检出→FAIL)', rWm, false);
    console.log(`   [正样本] 文字水印检出 ${rWm.actual && rWm.actual.suspectCount ? rWm.actual.suspectCount + ' 处' : '未检出'}`);
  }

  // --- ⑥ 换装不盖脸 ---
  const before = makeFaceProduct(path.join(tmp, 'before.png'), 295, 413, '#438EDB');
  const after = makeFaceProduct(path.join(tmp, 'after.png'), 295, 413, '#438EDB');
  add('assertSuitNotCoverFace(完全相同→PASS)', assertSuitNotCoverFace(before, after, { faceRect: { x: 80, y: 60, w: 130, h: 150 } }), true);
  // 在脸部区域画一块深色（模拟西装盖脸）
  {
    const img = loadPixels(after);
    for (let y = 60; y < 200; y++) {
      for (let x = 90; x < 200; x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = 34; img.data[i + 1] = 37; img.data[i + 2] = 46;
      }
    }
    writePng(path.join(tmp, 'after_covered.png'), img.width, img.height, img.data);
  }
  add('assertSuitNotCoverFace(脸部被覆盖→FAIL)', assertSuitNotCoverFace(before, path.join(tmp, 'after_covered.png'), { faceRect: { x: 80, y: 60, w: 130, h: 150 } }), false);

  // --- ⑦ 脸部区域干净 ---
  add('assertFaceRegionClean(纯色→FAIL)', assertFaceRegionClean(good, { faceRect: { x: 80, y: 60, w: 130, h: 150 } }), false);
  add('assertFaceRegionClean(有纹理→PASS)', assertFaceRegionClean(faceProd, { faceRect: { x: 80, y: 60, w: 130, h: 150 } }), true);

  // --- ⑥b 换装盖脸（肤色保持率口径）---
  // 构造：参考图（蓝底 + 肤色椭圆脸） vs 换装图（西装色块盖住脸下半）
  {
    const W = 295;
    const H = 413;
    const refData = new Uint8Array(W * H * 4);
    const aftData = new Uint8Array(W * H * 4);
    const bg = [0x43, 0x8e, 0xdb];
    for (let i = 0; i < W * H; i++) {
      refData[i * 4] = bg[0]; refData[i * 4 + 1] = bg[1]; refData[i * 4 + 2] = bg[2]; refData[i * 4 + 3] = 255;
      aftData[i * 4] = bg[0]; aftData[i * 4 + 1] = bg[1]; aftData[i * 4 + 2] = bg[2]; aftData[i * 4 + 3] = 255;
    }
    // 肤色脸：椭圆（肤色 200,160,130）
    const cx = 147;
    const cy = 150;
    const rx = 60;
    const ry = 85;
    const putSkin = (buf, x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = (y * W + x) * 4;
      buf[i] = 200; buf[i + 1] = 160; buf[i + 2] = 130; buf[i + 3] = 255;
    };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) {
          putSkin(refData, x, y);
          putSkin(aftData, x, y);
        }
      }
    }
    const refFile = path.join(tmp, 'suit_ref.png');
    writePng(refFile, W, H, refData);
    // 换装图：西装色（32,31,35）从 y=180 起铺满下半张脸
    const coveredFile = path.join(tmp, 'suit_covered.png');
    const coveredData = new Uint8Array(aftData);
    for (let y = 180; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (coveredData[i] === 200 && coveredData[i + 1] === 160) {
          coveredData[i] = 32; coveredData[i + 1] = 31; coveredData[i + 2] = 35;
        }
      }
    }
    writePng(coveredFile, W, H, coveredData);
    // 不盖脸的换装图：西装只铺 y=260 以下（脸下方）
    const okFile = path.join(tmp, 'suit_ok.png');
    const okData = new Uint8Array(aftData);
    for (let y = 260; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (okData[i] === 200 && okData[i + 1] === 160) {
          okData[i] = 32; okData[i + 1] = 31; okData[i + 2] = 35;
        }
      }
    }
    writePng(okFile, W, H, okData);
    add('assertSuitKeepsFacePixels(未盖脸→PASS)', assertSuitKeepsFacePixels(refFile, okFile), true);
    add('assertSuitKeepsFacePixels(盖住下半脸→FAIL)', assertSuitKeepsFacePixels(refFile, coveredFile), false);
    add('assertSuitDoesNotCoverFace(未盖脸→PASS)', assertSuitDoesNotCoverFace(okFile), true);
    add('assertSuitDoesNotCoverFace(盖脸→FAIL)', assertSuitDoesNotCoverFace(coveredFile), false);
  }

  // 汇总
  console.log('===== 业务断言库自测 =====');
  let fail = 0;
  for (const c of cases) {
    const good2 = c.ok === c.expectOk;
    if (!good2) fail++;
    console.log(`${good2 ? '✓' : '✗'} ${c.name}  [期望 ${c.expectOk ? 'PASS' : 'FAIL'}，实际 ${c.ok ? 'PASS' : 'FAIL'}]`);
    console.log(`   ${c.detail}`);
  }
  console.log(`\n自测用例 ${cases.length} 条，判定错误 ${fail} 条`);
  console.log(fail === 0 ? '✅ 业务断言库自测通过' : '❌ 业务断言库自测未通过');
  return fail === 0 ? 0 : 1;
}

// =====================================================================

module.exports = {
  // 断言
  assertPixelSize,
  assertBackgroundColor,
  assertHeadRatio,
  assertFileSize,
  assertNoWatermark,
  assertSuitNotCoverFace,
  assertSuitDoesNotCoverFace,
  assertSuitKeepsFacePixels,
  assertFaceRegionClean,
  assertProduct,
  // 工具（供其它脚本复用）
  parseHex,
  toHex,
  colorDistance,
  dominantCornerColor,
  alphaBBoxOf,
  loadPixels,
  makeSolidProduct,
  makeFaceProduct,
  writePng,
  drawPixelText,
  SELFTEST_FONT_5x7,
  // 常量
  SPECS: specLib.SPECS,
  BG: specLib.BG,
};

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
