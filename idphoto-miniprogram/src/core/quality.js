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
//
// 【2026-10-28 新增：脸部遮挡 / 眼镜反光启发式（PRD 12 章 EC2）】
// ⚠️⚠️ 重要声明：本模块**没有**任何 CV 模型能力，做不到真正的「看懂」头发遮耳、
//    镜片反光。下面给出的是**可解释的像素统计启发式**，用途只有一个：
//    在提交前给用户一句「疑似有 X，建议确认」的提示，把注意力引到需要人工看的点上。
//    · 阈值是经验初值，**未经真实证件照图集校准**，上线前必须用真图回归；
//    · 宁可漏报不可误报：判不准就返回 unknown，绝不硬判 warn（冤枉用户 = 弃用工具）；
//    · 不要把返回的 status 当作「权威识别结论」对外宣称，只作提示。

const MIN_W = 600;
const MIN_H = 800;
const BG_THRESHOLD = 150; // 背景复杂度（拉普拉斯方差）上限，纯色背景远低于此
const DARK_LIMIT = 45; // 平均亮度下限（偏暗）
const OVER_LIMIT = 235; // 平均亮度上限（过曝）

// ---- 遮挡/反光启发式的阈值（经验初值，需真图校准） ----
const OCC = {
  // 暗像素判定：暗阈值 = min(绝对上限, 面部中位亮度 × 相对系数)
  // 相对系数保证深肤色人脸不被整片判成「暗」；绝对上限保证浅肤色人脸下的头发判得出来。
  DARK_REL: 0.55,
  DARK_ABS: 130,
  // 发量遮挡耳眉：侧条里的暗像素要「成片 + 上下贯通 + 顶到脸廓边缘」
  HAIR_DARK_RATIO: 0.45, // 眉眼带内暗像素占比下限
  HAIR_RUN_TOP: 0.45, // 暗色竖向连续段须上探到脸框顶部 45% 以内（即贯通相当高度）
  HAIR_COL_RATIO: 0.5, // 侧条中满足「贯通」的列占比下限
  HAIR_EDGE_COLS: 2, // 脸廓外缘多少列内要有一个「贯通」的列（= 头发连到背景那一侧）
  // 眼镜反光：眼部带内的**局部**高亮斑块
  GLARE_DELTA: 55, // 高亮相对该区域中位亮度的超出量
  GLARE_MIN_AREA: 0.002, // 斑块最小面积占比（低于此视为压缩噪点）
  GLARE_MAX_AREA: 0.25, // 斑块最大面积占比（超过此视为整体过曝，不是镜片反光）
  GLARE_MAX_BBOX_W: 0.55, // 斑块包围盒宽上限（占区域宽）——必须是「局部」而非整片
  GLARE_MAX_BBOX_H: 0.6, // 斑块包围盒高上限（占区域高）
  // 面部区域亮度标准差低于此值 → 图像退化（纯色/过曝一片），判不准
  FLAT_STD: 1.0,
};

// 眉眼水平带（相对脸框高度的比例）：0.28~0.58 覆盖眉毛到眼睛下缘
const EYE_BAND_TOP = 0.28;
const EYE_BAND_BOT = 0.58;
// 侧条宽度（相对脸框宽度）：左右各 16%
const SIDE_STRIP = 0.16;


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

// ---------- 遮挡/反光启发式的内部工具 ----------

/** 取区域内灰度的中位数（比均值抗离群点） */
function regionMedian(gray, w, x0, y0, x1, y1) {
  const vals = [];
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      vals.push(gray[y * w + x]);
    }
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** 区域灰度标准差（判断区域是否是「一片死平」的退化输入） */
function regionStd(gray, w, x0, y0, x1, y1) {
  const vals = [];
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) vals.push(gray[y * w + x]);
  }
  if (vals.length < 4) return 0;
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / vals.length;
  let s2 = 0;
  for (const v of vals) s2 += (v - mean) * (v - mean);
  return Math.sqrt(s2 / vals.length);
}

/** 在二值掩码上找连通块（4 邻域），返回 {area, minX, minY, maxX, maxY} 列表 */
function connectedComponents(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let sp = 0;
    stack[sp++] = i;
    seen[i] = 1;
    let area = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // 4 邻域
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    comps.push({ area, minX, minY, maxX, maxY });
  }
  return comps;
}

/**
 * 检查脸部遮挡类问题（PRD 12 章 EC2：发量遮挡耳眉 / 眼镜反光）。
 *
 * ⚠️⚠️ 这**不是** CV 识别，是**启发式像素统计**。它只能给出一句「疑似…，建议确认」的提示，
 *    绝不能当作权威结论。阈值（OCC.*）全部是经验初值，**必须用真实证件照图集校准**后才可依赖；
 *    判不准时一律返回 status:'unknown'，宁可漏报不可误报。
 *
 * 判定逻辑（两条都可解释）：
 *   1) 发量遮挡耳眉（'hair_cover'）：
 *      以脸部核心区的灰度中位数为「肤色基准」，推出暗像素阈值；
 *      脸框左右两条侧条（SIDE_STRIP 宽）在「眉眼水平带」内的暗像素占比要高（HAIR_DARK_RATIO），
 *      且这些暗像素必须是**从脸框上缘垂下来的连续暗柱**（tallRun），
 *      —— 说明它是头发主体延伸下来的，而不是眉毛/阴影之类的小块暗区。
 *   2) 眼镜反光（'glare'）：
 *      眼部区域灰度中位数 + GLARE_DELTA 以上的「局部高亮斑块」：
 *      既要是**连通的小块**（面积占比在 GLARE_MIN_AREA~GLARE_MAX_AREA 之间），
 *      又要**包围盒足够小**（不能是整片过曝），才判为疑似镜片反光。
 *
 * @param {Uint8ClampedArray} rgba 像素（长度 = w*h*4），坐标系与 faceRect 一致
 * @param {number} w 宽
 * @param {number} h 高
 * @param {{x:number,y:number,w:number,h:number}} faceRect 脸部矩形（像素坐标）
 * @returns {{status:'ok'|'warn'|'unknown', items:Array<{code:string,label:string,advice:string}>, reason:string, notes:string[]}}
 */
function checkFaceOcclusion(rgba, w, h, faceRect) {
  const notes = [];
  const unknown = (reason) => ({ status: 'unknown', items: [], reason, notes });

  if (!rgba || !w || !h || !rgba.length) return unknown('no_pixels');
  // 缓冲区必须至少装得下 w*h 个 RGBA 像素，否则后面的取值会读到 undefined
  if (rgba.length < w * h * 4) return unknown('pixel_buffer_too_small');
  if (!faceRect || typeof faceRect !== 'object') return unknown('no_face_rect');
  const fx = Math.round(faceRect.x);
  const fy = Math.round(faceRect.y);
  const fw = Math.round(faceRect.w);
  const fh = Math.round(faceRect.h);
  if (!(fw > 0) || !(fh > 0)) return unknown('no_face_rect');
  if (fx < 0 || fy < 0 || fx + fw > w || fy + fh > h) return unknown('face_rect_out_of_bounds');
  // 太小就没法做统计（阈值全是按「脸至少几十像素」的经验值定的）
  if (fw < 16 || fh < 16) return unknown('face_too_small');

  const gray = toGray(rgba, w * h);

  // 脸部核心区（避开左右侧条与上下边缘）→ 肤色亮度基准
  const coreX0 = fx + Math.round(0.2 * fw);
  const coreX1 = fx + Math.round(0.8 * fw);
  const coreY0 = fy + Math.round(0.2 * fh);
  const coreY1 = fy + Math.round(0.8 * fh);
  const faceMedian = regionMedian(gray, w, coreX0, coreY0, coreX1, coreY1);
  if (faceMedian == null) return unknown('no_face_region');
  // 「整张图一片死平」= 没有可判读的信息（纯色图 / 严重过曝）→ 判不准，不硬判 warn
  // 注意：判据用**整个脸框**而不是脸部核心区 —— 核心区（脸颊）本来就均匀，
  // 若拿它判平坦，正常人脸会被误判成「退化输入」。
  const faceStd = regionStd(gray, w, fx, fy, fx + fw, fy + fh);
  if (faceStd < OCC.FLAT_STD) {
    return unknown('flat_face_region');
  }

  const items = [];

  // ---------- 1. 发量遮挡耳眉 ----------
  const darkThr = Math.min(OCC.DARK_ABS, faceMedian * OCC.DARK_REL);
  const bandY0 = fy + Math.round(EYE_BAND_TOP * fh);
  const bandY1 = fy + Math.round(EYE_BAND_BOT * fh);
  const stripW = Math.max(1, Math.round(SIDE_STRIP * fw));
  const sides = [
    { name: 'left', x0: fx, x1: fx + stripW },
    { name: 'right', x0: fx + fw - stripW, x1: fx + fw },
  ];
  for (const side of sides) {
    let bandPix = 0;
    let darkPix = 0;
    let tallCol = 0;
    let colCount = 0;
    for (let x = side.x0; x < side.x1; x++) {
      colCount++;
      // 该列在眉眼带内的暗像素数
      let colDark = 0;
      for (let y = bandY0; y < bandY1; y++) {
        if (y < 0 || y >= h) continue;
        bandPix++;
        if (gray[y * w + x] < darkThr) {
          darkPix++;
          colDark++;
        }
      }
      // 「垂下来的连续暗柱」：找出该列在眉眼带里那一段连续暗像素的**顶端**，
      // 若顶端已上探到脸框顶部附近（HAIR_RUN_TOP 比例以内）→ 是头发主体延伸下来的，
      // 而不是眉毛/阴影之类的小块暗区。
      let bestRun = 0;
      let bestTop = bandY1;
      let runStart = -1;
      for (let y = fy; y < bandY1; y++) {
        const isDark = gray[y * w + x] < darkThr;
        if (isDark) {
          if (runStart < 0) runStart = y;
        } else if (runStart >= 0) {
          // 这一段暗像素结束：若它与眉眼带相交，记为候选
          if (y > bandY0 && y - runStart > bestRun) {
            bestRun = y - runStart;
            bestTop = runStart;
          }
          runStart = -1;
        }
      }
      if (runStart >= 0 && bandY1 - runStart > bestRun) {
        bestRun = bandY1 - runStart;
        bestTop = runStart;
      }
      const reachedTop = bestTop <= fy + Math.round(OCC.HAIR_RUN_TOP * fh);
      if (colDark > 0 && reachedTop && bestRun >= Math.round(0.15 * fh)) tallCol++;
    }
    const darkRatio = bandPix > 0 ? darkPix / bandPix : 0;
    const tallRatio = colCount > 0 ? tallCol / colCount : 0;
    if (darkRatio >= OCC.HAIR_DARK_RATIO && tallRatio >= OCC.HAIR_COL_RATIO) {
      items.push({
        code: 'hair_cover',
        label: '疑似发量遮挡耳眉',
        advice: '发型可能挡住了耳朵或眉毛，建议收起头发后重拍（此提示为像素启发式判断，请自行确认）',
      });
      notes.push(
        `${side.name} 侧：眉眼带暗像素占比 ${(darkRatio * 100).toFixed(0)}%，贯通暗柱列占比 ${(tallRatio * 100).toFixed(0)}%`,
      );
      break; // 两侧都命中也只报一条
    }
  }

  // ---------- 2. 眼镜反光 ----------
  const eyeX0 = fx + Math.round(0.22 * fw);
  const eyeX1 = fx + Math.round(0.78 * fw);
  const eyeY0 = bandY0;
  const eyeY1 = bandY1;
  const eyeW = eyeX1 - eyeX0;
  const eyeH = eyeY1 - eyeY0;
  if (eyeW >= 4 && eyeH >= 4) {
    const eyeMedian = regionMedian(gray, w, eyeX0, eyeY0, eyeX1, eyeY1);
    if (eyeMedian != null) {
      if (eyeMedian >= 240) {
        notes.push('眼部区域整体接近过曝，无法判断是否存在镜片反光');
      } else {
        const brightThr = eyeMedian + OCC.GLARE_DELTA;
        const mask = new Uint8Array(w * h);
        let brightCount = 0;
        for (let y = eyeY0; y < eyeY1; y++) {
          for (let x = eyeX0; x < eyeX1; x++) {
            if (gray[y * w + x] >= brightThr) {
              mask[y * w + x] = 1;
              brightCount++;
            }
          }
        }
        const areaRatio = brightCount / (eyeW * eyeH);
        if (areaRatio >= OCC.GLARE_MIN_AREA && areaRatio <= OCC.GLARE_MAX_AREA) {
          const comps = connectedComponents(mask, w, h);
          const local = comps.find(
            (c) =>
              c.area / (eyeW * eyeH) >= OCC.GLARE_MIN_AREA &&
              c.area / (eyeW * eyeH) <= OCC.GLARE_MAX_AREA &&
              (c.maxX - c.minX + 1) <= OCC.GLARE_MAX_BBOX_W * eyeW &&
              (c.maxY - c.minY + 1) <= OCC.GLARE_MAX_BBOX_H * eyeH,
          );
          if (local) {
            items.push({
              code: 'glare',
              label: '疑似眼镜反光',
              advice: '镜片可能有反光遮挡眼部，建议调整角度或摘下眼镜重拍（此提示为像素启发式判断，请自行确认）',
            });
            notes.push(`眼部高亮斑块占区域 ${(areaRatio * 100).toFixed(1)}%，最大 ${local.area}px`);
          }
        }
      }
    }
  }

  if (items.length) {
    return { status: 'warn', items, reason: items[0].code, notes };
  }
  return { status: 'ok', items: [], reason: 'ok', notes };
}

module.exports = {
  assessQuality,
  checkFaceOcclusion,
  MIN_W,
  MIN_H,
  BG_THRESHOLD,
  DARK_LIMIT,
  OVER_LIMIT,
  OCC,
};

