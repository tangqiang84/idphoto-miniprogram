// 原图质量评估（PRD A3 / AC3）
// 纯函数：输入「端侧下采样后的 RGBA 像素」+ 原图尺寸，输出质量提示列表。
// 端侧负责把图片画到小画布（默认 64×64）取像素；算法本身框架无关、可在 Node 单测。
//
// 检测项（与 owner 决策一致：均为「建议性提示、不阻断导出」，类比 T1-21 构图不足）：
//   1) 分辨率：原图 < 600×800 → 提示清晰度不足建议重拍（AC3 硬标准）。
//   2) 背景复杂度：取图像「边框 ring 区域」（排除中心人物）的灰度拉普拉斯方差；
//      纯色背景方差≈0，花纹/玻璃/树林等复杂背景方差大 → 提示抠图可能不干净。
//   3) 光线：整图平均亮度；过暗(<DARK_LIMIT)或过曝(>OVER_LIMIT) → 提示重拍。
//
// 阈值初值按经验设定，真实照片 JPEG 压缩噪声会让纯色背景也有小幅方差，
// 故 BG_THRESHOLD 留有余量；真机可据实测微调（见《开发任务台账》#36）。

const MIN_W = 600;
const MIN_H = 800;
const BG_THRESHOLD = 150; // 背景复杂度（拉普拉斯方差）上限，纯色背景远低于此
const DARK_LIMIT = 45; // 平均亮度下限（偏暗）
const OVER_LIMIT = 235; // 平均亮度上限（过曝）

// RGBA → 灰度（Rec.601）
function toGray(rgba, n) {
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const gr = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    g[i] = 0.299 * r + 0.587 * gr + 0.114 * b;
  }
  return g;
}

// 边框 ring 区域的拉普拉斯方差 = 背景复杂度指标。
// ring：距任一边 < margin 的像素（margin 取短边的 15%），避开居中的人物主体。
function backgroundComplexity(gray, w, h) {
  const margin = Math.max(1, Math.round(Math.min(w, h) * 0.15));
  let sum = 0;
  let sum2 = 0;
  let cnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const onRing =
        x < margin || x >= w - margin || y < margin || y >= h - margin;
      if (!onRing) continue;
      const c = gray[y * w + x];
      const lap =
        4 * c -
        gray[y * w + x - 1] -
        gray[y * w + x + 1] -
        gray[(y - 1) * w + x] -
        gray[(y + 1) * w + x];
      sum += lap;
      sum2 += lap * lap;
      cnt++;
    }
  }
  if (cnt === 0) return 0;
  const mean = sum / cnt;
  return sum2 / cnt - mean * mean;
}

function meanLuminance(gray, n) {
  let s = 0;
  for (let i = 0; i < n; i++) s += gray[i];
  return s / n;
}

/**
 * 评估原图质量。
 * @param {Uint8ClampedArray} rgba 下采样后的 RGBA 像素（长度 = w*h*4）
 * @param {number} w 采样图宽
 * @param {number} h 采样图高
 * @param {number} srcW 原图宽
 * @param {number} srcH 原图高
 * @returns {{level:string, tips:Array<{level:string,code:string,text:string}>, metrics:object}}
 */
function assessQuality(rgba, w, h, srcW, srcH) {
  const n = w * h;
  const tips = [];

  // 1) 分辨率
  if (!(srcW >= MIN_W && srcH >= MIN_H)) {
    tips.push({
      level: 'warn',
      code: 'lowres',
      text: `原图分辨率偏低（${srcW}×${srcH}），建议重拍更高清的照片`,
    });
  }

  const gray = toGray(rgba, n);

  // 2) 背景复杂度
  const bg = backgroundComplexity(gray, w, h);
  if (bg > BG_THRESHOLD) {
    tips.push({
      level: 'warn',
      code: 'complexbg',
      text: '背景较复杂，抠图边缘可能不干净；勾选「上云增强」可改用云端精修（推荐）或换纯色背景重拍',
    });
  }

  // 3) 光线
  const bright = meanLuminance(gray, n);
  if (bright < DARK_LIMIT) {
    tips.push({
      level: 'warn',
      code: 'dark',
      text: '画面偏暗，建议到光线明亮处重拍',
    });
  } else if (bright > OVER_LIMIT) {
    tips.push({
      level: 'warn',
      code: 'over',
      text: '画面过曝，建议避免强光直射重拍',
    });
  }

  return {
    level: tips.length ? 'warn' : 'ok',
    tips,
    metrics: {
      srcW,
      srcH,
      bgScore: Math.round(bg),
      brightness: Math.round(bright),
    },
  };
}

module.exports = {
  assessQuality,
  MIN_W,
  MIN_H,
  BG_THRESHOLD,
  DARK_LIMIT,
  OVER_LIMIT,
};
