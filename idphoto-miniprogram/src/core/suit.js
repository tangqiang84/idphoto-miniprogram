'use strict';
// T3 换装端侧贴图合成（owner 2026-10-23 决策：端侧贴图合成 MVP 路线）
// 输入：抠图结果（rgba + alpha）+ 自绘透明 PNG 西装模板 + 头肩定位
// 输出：合成后 RGBA（不修改输入）
// 注意：本模块只做几何贴合合成，不改五官（PRD D2 由人工自检兜底，D3 强制弹窗在页面层）

// 由抠图 alpha 计算人像包围盒（alpha>0.5 视为前景）
// 返回 {x, y, w, h}；无前景返回 null
function alphaBBox(alpha, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
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

// 收紧版人像包围盒（问题台账 #69，2026-10-27）：
// alphaBBox 的 min/max 口径会被**零星噪声前景**撑爆——实测 111.jpg 云端 alpha 把左右
// 两侧背景各判出一溜 >0.5 的前景 → bbox 满宽（600px）；123.png 几乎整图判成前景。
// 撑爆的 bbox 直接毁掉下游：suitPlacement 宽=1.5×bbox.w 爆出画布、headH=0.3×bbox.h 高估、
// place.y 冲过下巴盖脸。
// 收紧策略：列/行投影取「最长有效连续段」——
//   · 列有效：该列前景占比 ≥ COL_FILL（人体躯干列满足，侧向一溜墙渍不满足）
//   · 行有效：该行前景占比 ≥ ROW_FILL（头发行满足，顶部孤立斑点不满足）
//   · 连续段内容忍 ≤2% 长度的间隙（头发/衣领镂空不切段）
const COL_FILL = 0.15;
const ROW_FILL = 0.12;

function longestSegment(counts, n, minFill) {
  let best = null, cur = null, gap = 0;
  const gapMax = Math.max(2, Math.round(n * 0.02));
  for (let i = 0; i < n; i++) {
    if (counts[i] >= minFill) {
      if (!cur) cur = { s: i, e: i };
      else cur.e = i;
      gap = 0;
    } else if (cur) {
      gap++;
      if (gap > gapMax) {
        if (!best || cur.e - cur.s > best.e - best.s) best = cur;
        cur = null;
      }
    }
  }
  if (cur && (!best || cur.e - cur.s > best.e - best.s)) best = cur;
  return best;
}

function tightBBox(alpha, width, height) {
  if (!alpha || !width || !height) return null;
  const colCount = new Int32Array(width);
  const rowCount = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] > 0.5) { colCount[x]++; rowCount[y]++; }
    }
  }
  const colMin = height * COL_FILL;
  const rowMin = width * ROW_FILL;
  const cs = longestSegment(colCount, width, colMin);
  const rs = longestSegment(rowCount, height, rowMin);
  if (!cs || !rs) return null;
  // 段内回填真实 min/max（段是连续区间，直接用段端点；列段给 x 范围，行段给 y 范围）
  return { x: cs.s, y: rs.s, w: cs.e - cs.s + 1, h: rs.e - rs.s + 1 };
}

// 肩线法头长估计（问题台账 #69，2026-10-27 下午；仅用于换装定位）
//
// 【为什么加】estimate 路径 headLengthPx = bbox.h × 0.30 假设「头占人体框 30%」，
// 该假设只在标准半身构图成立：
//   · 胸像特写（人占满图）：头占 50%+ → headH 严重低估 → place.y 冲到眼睛上盖脸
//     （实测 images(3)：真实头长 ≈189，estimate 只给 99.9，V 领顶点盖住眼睛）
//   · 远景/全身：头占 15% → headH 高估 → place.y 低于颈根（西装悬空）
// face.js 的 estimate 口径不能动（T4 合规检测占比计算依赖它），故在换装链路单开一路。
//
// 【方法】人体 alpha 行宽曲线：头顶行窄（头宽）→ 到肩线突跳（肩宽 ≈ 1.6×+ 头宽）。
// 肩线 y ≈ 颈根/下颌线，headH = 肩线 y − bbox.y。对构图自适应（胸像/半身/远景都准）。
// 抗噪：行宽用「该行 alpha>0.5 计数」（侧向零星噪声撑不宽一行）；
//       头顶宽取 bbox.y 起 20% 高度的**最大**行宽（含爆炸发——贴头皮短发头顶行
//       可能只有 30px，取中位数会被脸宽（100px+）秒触发，实测 111.jpg 被改坏；
//       取段内最大 = 头发完全展开后的头宽，贴头皮/爆炸头都稳）；
//       突变行需持续 3 行（抗镂空）。
// 兜底：找不到突变（爆炸头头顶宽≈肩宽）→ 返回 null，调用方回退 estimate。
function estimateHeadByShoulder(alpha, width, height, bbox) {
  if (!alpha || !bbox || !width || !height) return null;
  // 每行前景计数（alpha>0.5）
  const rowCount = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let n = 0;
    for (let x = 0; x < width; x++) if (alpha[y * width + x] > 0.5) n++;
    rowCount[y] = n;
  }
  // 头顶宽：bbox.y 起 max(8, 20% bbox.h) 行内的最大行宽
  const scanEnd = Math.min(height, bbox.y + Math.max(8, Math.round(bbox.h * 0.2)));
  let headW = 0;
  for (let y = bbox.y; y < scanEnd; y++) if (rowCount[y] > headW) headW = rowCount[y];
  if (!(headW > 0)) return null;
  // 肩线：从头往下找第一处行宽 > 1.6×头顶宽 且持续 3 行
  const thr = headW * 1.6;
  const yStart = Math.min(height - 1, bbox.y + Math.round(headW * 0.8)); // 头顶段下方至少 0.8 头宽处才开始找（脸本身比头顶宽不了 1.6 倍）
  let run = 0;
  for (let y = yStart; y < height; y++) {
    if (rowCount[y] > thr) {
      run++;
      if (run >= 3) {
        const shoulderY = y - 2;
        const headH = shoulderY - bbox.y;
        // 合理性：头长应在 [0.5×头顶宽, 4×头顶宽]（头长≈头顶宽/0.75，容差放大）
        if (headH >= headW * 0.5 && headH <= headW * 4) return { headH, shoulderY, headW };
        return null;
      }
    } else {
      run = 0;
    }
  }
  return null;
}

// 西装模板放置框（几何贴合规则，纯函数可单测）
// bbox  : 人像包围盒 {x,y,w,h}（建议用 tightBBox 收紧后的）
// headH : 头长（faceDetect 人脸框高；无 faceDetect 时由调用方传 bbox.h*0.30 估算）
// chinY : 下巴 y（measureHeadMetrics 的 metrics.chinY；landmarks 为实测、estimate 为 bbox.y+headH）
// maxW  : 放置框宽度上限（画布宽，防 bbox 被噪声撑宽后 1.5× 爆出画布）
//
// 【#69 修复】原口径 place.y = bbox.y + 0.85×headH 在 estimate 路径下**必然盖脸**：
//   estimate 的 headH=0.3×bbox.h（bbox.h 是人体高），place.y−chinY = 0.255×bbox.h − 0.3×bbox.h
//   = −0.045×bbox.h < 0 → 西装顶永远冲过下巴 4.5% 人体高（实测 111.jpg 盖 30px、123.png 盖 19px）。
//   该 0.85 系数只在 headH=真实头高（landmarks 路径）时成立，与 estimate 的口径不匹配。
// 新口径：**chinY 锚定**——西装顶 = 下巴 + 0.10×headH（脖子根），与 headH 的来源解耦；
//   西装高从放置顶**延伸到人体框底**（原 0.55×bbox.h 盖不住原衣，111.jpg 整件衬衫外露）。
function suitPlacement(bbox, headH, chinY, maxW) {
  if (!bbox || !headH || headH <= 0) throw new Error('suitPlacement: 缺少 bbox/headH');
  const chin = (typeof chinY === 'number' && chinY > bbox.y && chinY < bbox.y + bbox.h)
    ? chinY
    : bbox.y + headH; // 无 chinY 时按 estimate 定义（chinY = crownY + headLengthPx）
  const top = chin + headH * 0.10;
  const bottom = bbox.y + bbox.h;
  const w = Math.min(bbox.w * 1.5, typeof maxW === 'number' && maxW > 0 ? maxW : bbox.w * 1.5);
  const h = Math.max(headH * 0.5, bottom - top); // 至少半个头长，防止 bbox 病态时高度塌掉
  return {
    x: bbox.x + bbox.w / 2 - w / 2,
    y: top,
    w,
    h,
  };
}

// 贴图合成：将模板（tplW×tplH RGBA，领口居中于顶部）放置到 place 框
// 仅覆盖人体区域（alpha>0.5）且模板不透明的像素；其余像素原样保留；返回新 RGBA
//
// 【2026-10-23 owner 决策 600dpi 开放】采样方式由「最近邻」改为「双线性」：
//   模板源分辨率固定 400×400，而放置框尺寸随工作图缩放 ——
//   300dpi 工作图（长边 800）放置框约 500px，400→500 放大尚可；
//   600dpi 工作图（长边可达 1600）放置框可达 1400px+，最近邻会出现明显锯齿与色块。
//   双线性在两个方向都做插值，放大后边缘平滑，代价仅是每像素多几次乘加（可接受）。
// 注意：alpha 通道单独插值会���致半透明边界的颜色渗染（premultiplied 问题），
//   故对 RGB 与 A 分别插值后按 A 加权混合，避免出现黑边。
function suitCompose(rgba, alpha, width, height, tpl, tplW, tplH, place) {
  if (!rgba || !alpha || !tpl) throw new Error('suitCompose: 缺少 rgba/alpha/tpl');
  const out = new Uint8ClampedArray(rgba);
  const x0 = Math.max(0, Math.round(place.x));
  const y0 = Math.max(0, Math.round(place.y));
  const x1 = Math.min(width, Math.round(place.x + place.w));
  const y1 = Math.min(height, Math.round(place.y + place.h));
  if (x1 <= x0 || y1 <= y0) return out;
  // 模板坐标映射：放置框 → 模板像素（双线性）
  const rx = tplW / place.w;
  const ry = tplH / place.h;
  const sampleTpl = (fx, fy) => {
    const cx = Math.min(tplW - 1, Math.max(0, fx));
    const cy = Math.min(tplH - 1, Math.max(0, fy));
    const x0i = Math.floor(cx), y0i = Math.floor(cy);
    const x1i = Math.min(tplW - 1, x0i + 1), y1i = Math.min(tplH - 1, y0i + 1);
    const tx = cx - x0i, ty = cy - y0i;
    const i00 = (y0i * tplW + x0i) * 4, i01 = (y0i * tplW + x1i) * 4;
    const i10 = (y1i * tplW + x0i) * 4, i11 = (y1i * tplW + x1i) * 4;
    const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty, w11 = tx * ty;
    return {
      r: tpl[i00] * w00 + tpl[i01] * w01 + tpl[i10] * w10 + tpl[i11] * w11,
      g: tpl[i00 + 1] * w00 + tpl[i01 + 1] * w01 + tpl[i10 + 1] * w10 + tpl[i11 + 1] * w11,
      b: tpl[i00 + 2] * w00 + tpl[i01 + 2] * w01 + tpl[i10 + 2] * w10 + tpl[i11 + 2] * w11,
      a: tpl[i00 + 3] * w00 + tpl[i01 + 3] * w01 + tpl[i10 + 3] * w10 + tpl[i11 + 3] * w11,
    };
  };
  for (let y = y0; y < y1; y++) {
    const fy = (y - place.y + 0.5) * ry - 0.5;
    for (let x = x0; x < x1; x++) {
      const di = y * width + x;
      if (alpha[di] <= 0.5) continue; // 只贴人体区域
      const fx = (x - place.x + 0.5) * rx - 0.5;
      const t = sampleTpl(fx, fy);
      const ta = t.a / 255;
      if (ta <= 0.001) continue; // 模板透明处不覆盖
      const di4 = di * 4;
      // alpha 加权混合：避免半透明边界把背景黑色渗进前景
      const inv = 1 - ta;
      out[di4] = t.r * ta + out[di4] * inv;
      out[di4 + 1] = t.g * ta + out[di4 + 1] * inv;
      out[di4 + 2] = t.b * ta + out[di4 + 2] * inv;
    }
  }
  return out;
}

module.exports = { alphaBBox, tightBBox, estimateHeadByShoulder, suitPlacement, suitCompose };
