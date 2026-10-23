'use strict';
// 端侧抠图模型规格表 + 预处理/后处理 + 权重校验（纯 JS、框架无关、可单测）
//
// 【为什么要有这个文件 —— 任务 #3 的第一个真实缺陷】
// 原 planned 的端侧模型是 RMBG-1.4，但它的许可是 **非商业使用**：
//   BRIA 官方 Model Card 原文："released under a Creative Commons license for
//   non-commercial use. Commercial use is subject to a commercial agreement with BRIA."
// 本项目是面向公众的产品小程序、且已规划付费档 → 属于商业使用，不能直接用。
// 故 2026-10-23 owner 拍板：**换可商用模型**。许可信息因此被写进代码（而不仅是文档），
// 防止后人照着旧文档把非商用权重接进来。
//
// 选型（许可均经核实）：
//   MODNet   (ZHKKKe/MODNet)        Apache-2.0  ✅ 可商用 · 512×512 · 归一化 [-1,1] · 输出 soft alpha [0,1]
//   U2Netp   (xuebinqin/U-2-Net)    Apache-2.0  ✅ 可商用 · 320×320 · ImageNet 归一化 · 输出需 min/max 归一化
//   BiRefNet (ZhengPeng7/BiRefNet)  MIT         ✅ 可商用 · 1024×1024 · ImageNet 归一化 · 输出 logits 需 sigmoid
//
// ⚠️ 易混淆点（务必与上面区分）：
//   RMBG-2.0 虽**采用 BiRefNet 架构**，但其权重由 BRIA 私有数据训练，
//   **仅限非商业使用**（BiRefNet 官方 README 明确标注）。
//   「架构 MIT」≠「所有该架构的权重都能商用」，接模型前必须逐个核权重许可。
//
// 【为什么预处理必须参数化 —— 第二个真实缺陷】
// 原 mattingLocal.preprocess 硬编码 ImageNet mean/std + 1024 尺寸。
// 这对 MODNet 是**错的**：MODNet 要求 (x/255 - 0.5)/0.5 → 归一化到 [-1,1]，输入 512。
// 沿用 ImageNet 参数会让模型输出完全失真（不报错、只是结果很差 —— 最难排查的那类 bug）。
// 故把「输入尺寸 / 归一化 / 输出后处理」全部收进规格表，由模型自己声明。

// ===================== 归一化方案 =====================
// imagenet : (x/255 - mean) / std，mean/std 取 torchvision 标准值
// minus1to1: (x/255 - 0.5) / 0.5  → [-1, 1]
// zeroone  : x / 255               → [0, 1]
// none     : x / 255 后不再变换（等价于 zeroone，语义上用于「模型自带归一化」）
const NORMALIZE_KINDS = { imagenet: 'imagenet', minus1to1: 'minus1to1', zeroone: 'zeroone', none: 'none' };

// ===================== 输出后处理方案 =====================
// matte  : 模型已输出 0~1 的 soft alpha，直接 resize 回原尺寸
// sigmoid: 模型输出 logits，需 sigmoid 映射到 0~1（BiRefNet 属此类）
// minmax : 模型输出未归一化的显著图，需按本帧 min/max 拉伸到 0~1（U2Net 属此类）
// raw    : 原样 resize（用于自定义模型，风险自负）
const OUTPUT_KINDS = { matte: 'matte', sigmoid: 'sigmoid', minmax: 'minmax', raw: 'raw' };

// ===================== 模型规格表 =====================
// approxBytes 只用于「下载前给用户预估体积 + 磁盘空间预检」，不用于校验（真实大小可能微调）。
// sha256 留空表示「未固定权重」，此时只校验字节数（见 verifyWeight 注释）。
const MODEL_SPECS = {
  'modnet-q8': {
    id: 'modnet-q8',
    family: 'modnet',
    label: 'MODNet（8bit 量化）',
    source: 'https://github.com/ZHKKKe/MODNet',
    license: 'Apache-2.0',
    commercialOk: true,
    inputSize: 512,
    layout: 'NCHW',
    inputName: 'input',
    normalize: { kind: NORMALIZE_KINDS.minus1to1, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
    output: { kind: OUTPUT_KINDS.matte },
    approxBytes: 7 * 1024 * 1024,
    note: '证件照首选：soft alpha 对发丝边缘友好；q8 量化后约 7MB，是端侧体积与质量的平衡点',
  },
  'modnet-fp32': {
    id: 'modnet-fp32',
    family: 'modnet',
    label: 'MODNet（fp32）',
    source: 'https://github.com/ZHKKKe/MODNet',
    license: 'Apache-2.0',
    commercialOk: true,
    inputSize: 512,
    layout: 'NCHW',
    inputName: 'input',
    normalize: { kind: NORMALIZE_KINDS.minus1to1, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5] },
    output: { kind: OUTPUT_KINDS.matte },
    approxBytes: 26 * 1024 * 1024,
    note: '精度略优于 q8，但体积 26MB；仅在 q8 边缘质量实测不足时考虑',
  },
  'u2netp': {
    id: 'u2netp',
    family: 'u2net',
    label: 'U2-Netp（轻量）',
    source: 'https://github.com/xuebinqin/U-2-Net',
    license: 'Apache-2.0',
    commercialOk: true,
    inputSize: 320,
    layout: 'NCHW',
    inputName: 'input',
    normalize: { kind: NORMALIZE_KINDS.imagenet, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
    output: { kind: OUTPUT_KINDS.minmax },
    approxBytes: 4.7 * 1024 * 1024,
    note: '体积最小；但属显著目标分割，输出更接近硬 mask，发丝不如 matting 类模型',
  },
  'birefnet-1024': {
    id: 'birefnet-1024',
    family: 'birefnet',
    label: 'BiRefNet（1024，云端规格）',
    source: 'https://github.com/ZhengPeng7/BiRefNet',
    license: 'MIT',
    commercialOk: true,
    inputSize: 1024,
    layout: 'NCHW',
    inputName: 'input',
    normalize: { kind: NORMALIZE_KINDS.imagenet, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
    output: { kind: OUTPUT_KINDS.sigmoid },
    approxBytes: 0, // 云端模型，不参与端侧体积预估
    edgeOnly: true, // 仅用于云端推理；端侧跑 1024 需 5.5GB 显存，手机不可行
    note: '精度最高（发丝保持最好），但 1024 推理需约 5.5GB 显存 → 只能放在云端 GPU',
  },
};

// 端侧默认模型（未配置权重时仍走经典基线，这里只是「配了权重后用哪个规格」）
const DEFAULT_EDGE_MODEL = 'modnet-q8';

function listModelSpecs() {
  return Object.keys(MODEL_SPECS).map((k) => MODEL_SPECS[k]);
}

function getModelSpec(id) {
  if (!id) return null;
  return MODEL_SPECS[id] || null;
}

// ===================== 预处理 =====================
// 入参 spec 可以是：
//   - 规格对象（推荐）
//   - 数字（向后兼容旧调用：preprocess(rgba,w,h,1024) → 按 ImageNet + 该尺寸）
// 输出：Float32Array，NCHW，长度 3*size*size
function preprocess(rgba, w, h, spec) {
  const s = normalizeSpec(spec);
  if (!s) throw new Error('preprocess: 缺少模型规格或尺寸');
  const size = s.inputSize;
  const src = resizeBilinearRGBA(rgba, w, h, size, size);
  const { mean, std, kind } = s.normalize;
  const out = new Float32Array(3 * size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        // 注意：输入是 RGBA，按顺序取 R/G/B；若模型要求 BGR 需在此处换序（本项目模型均要求 RGB）
        const v = src[si + c] / 255;
        let nv;
        if (kind === NORMALIZE_KINDS.none) nv = v;
        else nv = (v - mean[c]) / std[c];
        out[(c * size + y) * size + x] = nv;
      }
    }
  }
  return out;
}

// 把各种入参形态归一成完整规格对象（容错 + 向后兼容）
function normalizeSpec(spec) {
  if (!spec) return null;
  if (typeof spec === 'number') {
    // 旧签名：只给了 size → 按 ImageNet 归一化（与原 mattingLocal.preprocess 行为一致）
    return {
      inputSize: spec,
      normalize: { kind: NORMALIZE_KINDS.imagenet, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
      output: { kind: OUTPUT_KINDS.matte },
    };
  }
  if (typeof spec !== 'object') return null;
  const size = spec.inputSize;
  if (!(size > 0)) return null;
  const nk = (spec.normalize && spec.normalize.kind) || NORMALIZE_KINDS.imagenet;
  const mean = (spec.normalize && spec.normalize.mean) || [0.485, 0.456, 0.406];
  const std = (spec.normalize && spec.normalize.std) || [0.229, 0.224, 0.225];
  const ok = (spec.output && spec.output.kind) || OUTPUT_KINDS.matte;
  if (nk === NORMALIZE_KINDS.none) {
    return { inputSize: size, normalize: { kind: nk, mean: [0, 0, 0], std: [1, 1, 1] }, output: { kind: ok } };
  }
  return { inputSize: size, normalize: { kind: nk, mean, std }, output: { kind: ok } };
}

// ===================== 后处理 =====================
// raw: 模型输出（长度 size*size）；返回 0~1 的 alpha（长度 outW*outH）
function postprocess(raw, spec, outW, outH) {
  const s = normalizeSpec(spec);
  if (!s) throw new Error('postprocess: 缺少模型规格或尺寸');
  const size = s.inputSize;
  if (!raw || raw.length < size * size) throw new Error('postprocess: 模型输出长度不足');
  const src = raw.length === size * size ? raw : raw.subarray(0, size * size);
  let a;
  const kind = s.output.kind;
  if (kind === OUTPUT_KINDS.sigmoid) {
    a = new Float32Array(size * size);
    for (let i = 0; i < a.length; i++) a[i] = sigmoid(src[i]);
  } else if (kind === OUTPUT_KINDS.minmax) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < src.length; i++) { if (src[i] < mn) mn = src[i]; if (src[i] > mx) mx = src[i]; }
    const span = mx - mn;
    a = new Float32Array(size * size);
    // 全常量图（span≈0）→ 全部置 0，避免出现 NaN；此时 quality 会很低，交由路由判上云
    for (let i = 0; i < a.length; i++) a[i] = span > 1e-8 ? (src[i] - mn) / span : 0;
  } else if (kind === OUTPUT_KINDS.raw) {
    a = Float32Array.from(src);
  } else {
    // matte：已 0~1，但仍夹一次，防量化模型输出轻微越界
    a = new Float32Array(size * size);
    for (let i = 0; i < a.length; i++) a[i] = Math.max(0, Math.min(1, src[i]));
  }
  return resizeBilinear(a, size, size, outW, outH);
}

// ===================== 权重校验（纯逻辑，可单测） =====================
// 为什么校验与下载分开：sha256 在小程序里靠 wx.getFileSystemManager().getFileInfo
// 的 digestAlgorithm 拿（core 不能依赖运行时），所以这里只做「比对」，不做「计算」。
// verifyWeight({ size, sha256 }, spec) → { ok, reason, checks: { size: bool, sha: bool|null } }
function verifyWeight(meta, spec) {
  if (!meta || !spec) return { ok: false, reason: '缺少 meta 或 spec', checks: { size: false, sha: null } };
  const checks = { size: false, sha: null };
  // 字节数校验：规格声明了 approxBytes 时，允许 ±20% 容差（量化/导出工具会造成合理波动）
  if (spec.approxBytes > 0 && typeof meta.size === 'number') {
    const ratio = meta.size / spec.approxBytes;
    checks.size = ratio > 0.8 && ratio < 1.2;
    if (!checks.size) {
      return { ok: false, reason: `权重体积异常：${meta.size} 字节，规格期望约 ${spec.approxBytes}`, checks };
    }
  } else {
    checks.size = true; // 未声明体积 → 跳过
  }
  // sha256 校验：规格与实测都有值时才比对（未固定权重时跳过，只靠体积兜底）
  if (spec.sha256 && meta.sha256) {
    checks.sha = String(spec.sha256).toLowerCase() === String(meta.sha256).toLowerCase();
    if (!checks.sha) return { ok: false, reason: '权重 sha256 不匹配，疑似损坏或被替换', checks };
  }
  return { ok: true, reason: '', checks };
}

// 缓存文件名：带 spec.id，便于多模型共存与灰度切换；不要带 URL（URL 换 CDN 时缓存仍有效）
function resolveWeightFileName(spec) {
  if (!spec || !spec.id) return null;
  return `matting-${spec.id}.onnx`;
}

// 是否需要下载：缓存不存在 / 体积对不上 / 校验失败过 → 都需重下
// 入参：{ exists, size } 由平台层读取文件系统后传入
function shouldDownload(cached, spec) {
  if (!cached || !cached.exists) return { need: true, reason: '本地无缓存' };
  const v = verifyWeight({ size: cached.size }, spec);
  return v.ok ? { need: false, reason: '' } : { need: true, reason: v.reason };
}

// ===================== 是否启用端侧模型的决策（纯逻辑，可单测） =====================
// 为什么抽成纯函数：降级判断散落在平台层（wx 下载 / session 创建）里就没法单测，
// 而「什么时候该用模型、什么时候该退回经典基线」恰恰是最容易写错、也最需要护栏的部分。
//
// 入参：
//   config  : { enabled, weightUrl, modelId }
//   runtime : { hasOrt }   —— 是否注入了推理运行时（onnxruntime）
//   cached  : { exists, size, sha256 }
//   spec    : 模型规格对象
// 返回：{ action, reason, spec }
//   action 取值：
//     'use-cached' → 用本地缓存权重建 session
//     'download'   → 需要先下载权重
//     'classical'  → 走经典基线（含所有不可用/未配置的情况）
function resolveModelPlan({ config = {}, runtime = {}, cached = {}, spec = null } = {}) {
  const classical = (reason) => ({ action: 'classical', reason, spec: null });
  if (!config.enabled) return classical('端侧模型未启用（config.enabled=false）');
  if (!runtime.hasOrt) return classical('未注入推理运行时（onnxruntime），无法加载模型');
  if (!config.weightUrl) return classical('未配置权重下载地址（weightUrl 为空）');
  const s = spec || getModelSpec(config.modelId);
  if (!s) return classical(`未知模型规格：${config.modelId}`);
  if (s.edgeOnly) return classical(`${s.id} 为云端专用规格（端侧跑不动），已退回经典基线`);
  if (!cached || !cached.exists) return { action: 'download', reason: '本地无权重缓存', spec: s };
  const v = verifyWeight({ size: cached.size, sha256: cached.sha256 }, s);
  if (!v.ok) return { action: 'download', reason: `缓存权重不可用，需重新下载（${v.reason}）`, spec: s };
  return { action: 'use-cached', reason: '', spec: s };
}

// 下载失败退避：连续失败后进入冷却，避免「每次处理都重试下载」白耗用户流量。
// 入参 lastFailAt(ms 时间戳) / failCount / now / cooldownMs / maxFail
// 返回 { retry: bool, reason }
function shouldRetryDownload({ lastFailAt = 0, failCount = 0, now = 0, cooldownMs = 30 * 60 * 1000, maxFail = 3 } = {}) {
  if (failCount <= 0) return { retry: true, reason: '' };
  if (failCount >= maxFail) {
    return { retry: false, reason: `已连续失败 ${failCount} 次，停止重试（本会话内改用经典基线）` };
  }
  const elapsed = now - lastFailAt;
  if (elapsed < cooldownMs) {
    const waitSec = Math.ceil((cooldownMs - elapsed) / 1000);
    return { retry: false, reason: `下载失败冷却中，${waitSec} 秒后再试` };
  }
  return { retry: true, reason: '' };
}

// ===================== 内部工具（与 mattingLocal 同实现，避免循环依赖） =====================
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function resizeBilinearRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * sy, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * sx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c];
        const cc = src[(y1 * sw + x0) * 4 + c], d = src[(y1 * sw + x1) * 4 + c];
        out[(y * dw + x) * 4 + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return out;
}

function resizeBilinear(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const sx = sw / dw, sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = y * sy, y0 = Math.floor(sy0), y1 = Math.min(sh - 1, y0 + 1), fy = sy0 - y0;
    for (let x = 0; x < dw; x++) {
      const sx0 = x * sx, x0 = Math.floor(sx0), x1 = Math.min(sw - 1, x0 + 1), fx = sx0 - x0;
      const a = src[y0 * sw + x0], b = src[y0 * sw + x1], c = src[y1 * sw + x0], d = src[y1 * sw + x1];
      out[y * dw + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

module.exports = {
  MODEL_SPECS, DEFAULT_EDGE_MODEL, NORMALIZE_KINDS, OUTPUT_KINDS,
  listModelSpecs, getModelSpec, normalizeSpec,
  preprocess, postprocess,
  verifyWeight, resolveWeightFileName, shouldDownload,
  resolveModelPlan, shouldRetryDownload,
  // 内部工具导出以便单测
  resizeBilinear, resizeBilinearRGBA,
};
