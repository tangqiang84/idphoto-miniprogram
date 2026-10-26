// 相纸尺寸库（纯数据 + 排版计算，无平台依赖）
// 尺寸单位 mm；像素按 dpi 计算： round(mm / 25.4 * dpi)
//
// 【SSOT 说明】本库是「冲印排版」功能（PRD K 模块 / T6 工具）相纸尺寸的单一事实来源，
// 与《相纸尺寸口径对照表.md》互为溯源，与 specLibrary.js（证件照规格）并列。
// 改尺寸须三处同步：① 本库 ② 《相纸尺寸口径对照表.md》 ③ 《产品功能清单》T6 章节。
//
// 关键区分：
//   - paperWidthMm/paperHeightMm ＝ 整张纸尺寸
//   - printWidthMm/printHeightMm ＝ 可打印区 / 成像区（regular 留边 2–3mm；mini 为成像区，远小于纸）
//   - tileable ＝ 能否平铺多张（instax / SELPHY 方形贴纸为 false，每版仅 1 张）
//   - dpi ＝ 输出分辨率（regular/SELPHY=300；ZINK≈313；instax 为模拟胶片，按成像区×300 合成）

const DEFAULT_MARGIN_MM = 3; // 拼版边距
const DEFAULT_GAP_MM = 2; // 拼版间距

// 复用规格库的 mm 尺寸与像素换算
// eslint-disable-next-line
const { getSpec, mmToPx: _mmToPx } = (() => {
  try {
    return require('./specLibrary');
  } catch (e) {
    return { getSpec: () => null, mmToPx: (mm, dpi) => Math.round((mm / 25.4) * dpi) };
  }
})();

function mmToPx(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}

const PAPERS = [
  // ===== 常规冲印纸（去冲印店 / 家用喷墨 / 热升华），英寸制，可平铺 =====
  {
    id: 'paper-5in', name: '5寸', category: 'regular',
    paperWidthMm: 127, paperHeightMm: 89,
    printWidthMm: 124, printHeightMm: 86,
    dpi: 300, tileable: true,
    note: '最小常用',
    source: '行业 R 系列 5×3.5″；冲印店出货 127×89mm（留边约 2–3mm）。详见《相纸尺寸口径对照表.md》',
  },
  {
    id: 'paper-6in', name: '6寸(4R)', category: 'regular',
    paperWidthMm: 152, paperHeightMm: 102,
    printWidthMm: 148, printHeightMm: 98,
    dpi: 300, tileable: true,
    note: '最主流',
    source: '行业 R 系列 6×4″=152×102mm（4R）；冲印店出货，留边约 2–3mm',
  },
  {
    id: 'paper-6in-plus', name: '大6寸', category: 'regular',
    paperWidthMm: 152, paperHeightMm: 114,
    printWidthMm: 148, printHeightMm: 110,
    dpi: 300, tileable: true,
    note: '',
    source: '行业 R 系列 6×4.5″=152×114mm',
  },
  {
    id: 'paper-7in', name: '7寸', category: 'regular',
    paperWidthMm: 178, paperHeightMm: 127,
    printWidthMm: 174, printHeightMm: 123,
    dpi: 300, tileable: true,
    note: '',
    source: '行业 R 系列 7×5″=178×127mm',
  },
  {
    id: 'paper-8in', name: '8寸', category: 'regular',
    paperWidthMm: 203, paperHeightMm: 152,
    printWidthMm: 199, printHeightMm: 148,
    dpi: 300, tileable: true,
    note: '',
    source: '行业 R 系列 8×6″=203×152mm',
  },
  {
    id: 'paper-10in', name: '10寸', category: 'regular',
    paperWidthMm: 254, paperHeightMm: 203,
    printWidthMm: 250, printHeightMm: 199,
    dpi: 300, tileable: true,
    note: '',
    source: '行业 R 系列 10×8″=254×203mm',
  },
  {
    id: 'paper-12in', name: '12寸', category: 'regular',
    paperWidthMm: 305, paperHeightMm: 254,
    printWidthMm: 301, printHeightMm: 250,
    dpi: 300, tileable: true,
    note: '',
    source: '行业 R 系列 12×10″=305×254mm',
  },

  // ===== 迷你打印机纸 =====
  {
    id: 'instax-mini', name: 'instax mini', category: 'mini',
    paperWidthMm: 86, paperHeightMm: 54,
    printWidthMm: 62, printHeightMm: 46, // 成像区
    dpi: 300, tileable: false, // 一次成像，大白边不可拼版
    note: '每版仅 1 张，四周白边不可裁掉用于拼版',
    source: '富士官方 instax 页：纸 86×54mm / 成像 62×46mm（银盐一次成像，模拟胶片无数字 dpi）',
  },
  {
    id: 'instax-square', name: 'instax SQUARE', category: 'mini',
    paperWidthMm: 86, paperHeightMm: 72,
    printWidthMm: 62, printHeightMm: 62,
    dpi: 300, tileable: false,
    note: '每版仅 1 张',
    source: '富士官方 instax 页：纸 86×72mm / 成像 62×62mm',
  },
  {
    id: 'instax-wide', name: 'instax WIDE', category: 'mini',
    paperWidthMm: 108, paperHeightMm: 86,
    printWidthMm: 99, printHeightMm: 62,
    dpi: 300, tileable: false,
    note: '每版仅 1 张，横构图',
    source: '富士官方 instax 页：胶卷 108×86mm / 成像 99×62mm（横）',
  },
  {
    id: 'selphy-card', name: 'SELPHY 卡片', category: 'mini',
    paperWidthMm: 54, paperHeightMm: 86,
    printWidthMm: 50, printHeightMm: 84,
    dpi: 300, tileable: true, // 小留边，可平铺
    note: '佳能 CP1300',
    source: '佳能 SELPHY CP1300 官方规格：卡片 54×86mm / 可打印 50×84mm / 300dpi',
  },
  {
    id: 'selphy-l', name: 'SELPHY L', category: 'mini',
    paperWidthMm: 89, paperHeightMm: 119,
    printWidthMm: 85, printHeightMm: 117,
    dpi: 300, tileable: true,
    note: '佳能 CP1300',
    source: '佳能 SELPHY CP1300 官方规格：L 89×119mm / 可打印 85×117mm / 300dpi',
  },
  {
    id: 'selphy-postcard', name: 'SELPHY 明信片', category: 'mini',
    paperWidthMm: 100, paperHeightMm: 148,
    printWidthMm: 94, printHeightMm: 144,
    dpi: 300, tileable: true,
    note: '佳能 CP1300',
    source: '佳能 SELPHY CP1300 官方规格：明信片 100×148mm / 可打印 94×144mm / 300dpi',
  },
  {
    id: 'selphy-sticker-square', name: 'SELPHY 方形贴纸', category: 'mini',
    paperWidthMm: 50, paperHeightMm: 50,
    printWidthMm: 48, printHeightMm: 48,
    dpi: 300, tileable: false, // 单张贴纸
    note: '每版仅 1 张',
    source: '佳能 SELPHY 方形贴纸：50×50mm / 可打印 48×48mm / 300dpi',
  },
  {
    id: 'zink-2x3', name: 'ZINK 2×3', category: 'mini',
    paperWidthMm: 76, paperHeightMm: 51,
    printWidthMm: 74, printHeightMm: 49,
    dpi: 313, tileable: true,
    note: '惠普 Sprocket / 佳能 IVY / 柯达 Mini2',
    source: '惠普 Sprocket / 佳能 IVY / 柯达 Mini2 参数：ZINK 2×3″=76×51mm / 可打印约 74×49mm / ~313dpi',
  },
  {
    id: 'zink-2.3x3.4', name: 'ZINK 2.3×3.4', category: 'mini',
    paperWidthMm: 87, paperHeightMm: 58,
    printWidthMm: 85, printHeightMm: 56,
    dpi: 313, tileable: true,
    note: '惠普 Sprocket Plus',
    source: '惠普 Sprocket Plus 参数：ZINK 2.3×3.4″=87×58mm / 可打印约 85×56mm / ~313dpi',
  },
];

function getPaper(id) {
  return PAPERS.find((p) => p.id === id) || null;
}

function listPapers() {
  return PAPERS.map((p) => ({
    id: p.id, name: p.name, category: p.category,
    paperWidthMm: p.paperWidthMm, paperHeightMm: p.paperHeightMm,
    printWidthMm: p.printWidthMm, printHeightMm: p.printHeightMm,
    dpi: p.dpi, tileable: p.tileable, note: p.note, source: p.source,
  }));
}

// 整张纸输出像素（按纸尺寸 × dpi）
function sheetPixelSize(paperOrId) {
  const paper = typeof paperOrId === 'string' ? getPaper(paperOrId) : paperOrId;
  if (!paper) return null;
  return {
    width: mmToPx(paper.paperWidthMm, paper.dpi),
    height: mmToPx(paper.paperHeightMm, paper.dpi),
  };
}

// 单方向平铺数：在 (areaW×areaH) 内排 (photoW×photoH)，含 margin 与 gap
function tilingInRect(areaW, areaH, photoW, photoH, margin, gap) {
  const innerW = areaW - 2 * margin;
  const innerH = areaH - 2 * margin;
  if (innerW <= 0 || innerH <= 0) return { cols: 0, rows: 0, count: 0 };
  const cols = Math.floor((innerW + gap) / (photoW + gap));
  const rows = Math.floor((innerH + gap) / (photoH + gap));
  return { cols: Math.max(cols, 0), rows: Math.max(rows, 0), count: cols * rows };
}

// 在给定面积与照片尺寸下，尝试 4 种朝向组合，返回排得最多的方案
function bestTiling(areaW, areaH, photoW, photoH, margin, gap) {
  const combos = [
    { paperRotated: false, photoRotated: false },
    { paperRotated: true, photoRotated: false },
    { paperRotated: false, photoRotated: true },
    { paperRotated: true, photoRotated: true },
  ];
  let best = { count: 0, cols: 0, rows: 0, paperRotated: false, photoRotated: false };
  for (const c of combos) {
    const aW = c.paperRotated ? areaH : areaW;
    const aH = c.paperRotated ? areaW : areaH;
    const pW = c.photoRotated ? photoH : photoW;
    const pH = c.photoRotated ? photoW : photoH;
    const t = tilingInRect(aW, aH, pW, pH, margin, gap);
    if (t.count > best.count) {
      best = { count: t.count, cols: t.cols, rows: t.rows, paperRotated: c.paperRotated, photoRotated: c.photoRotated };
    }
  }
  return best;
}

// 排版主入口：给定相纸 + 证件照规格，返回拼版方案
// opts: { marginMm, gapMm }
function planLayout(paperId, specId, opts = {}) {
  const paper = getPaper(paperId);
  const spec = getSpec(specId);
  if (!paper || !spec) return null;

  const margin = opts.marginMm != null ? opts.marginMm : DEFAULT_MARGIN_MM;
  const gap = opts.gapMm != null ? opts.gapMm : DEFAULT_GAP_MM;
  const dpi = paper.dpi;

  const spMm = { w: spec.widthMm, h: spec.heightMm }; // 证件照 mm 尺寸（来自 specLibrary）

  if (!paper.tileable) {
    // 不可拼版（instax / 方形贴纸）：每版至多 1 张，选能放下的朝向
    const fit = bestTiling(paper.printWidthMm, paper.printHeightMm, spMm.w, spMm.h, 0, 0);
    const count = Math.min(fit.count, 1);
    return {
      paperId, specId, dpi,
      tileable: false,
      count, cols: count, rows: count > 0 ? 1 : 0,
      paperRotated: fit.paperRotated,
      photoRotated: fit.photoRotated,
      photoFootprintMm: fit.photoRotated ? { w: spMm.h, h: spMm.w } : { w: spMm.w, h: spMm.h },
      sheetPx: sheetPixelSize(paper),
      note: count === 0
        ? '该相纸成像区小于所选证件照，无法容纳，请换更大相纸或更小规格'
        : '该相纸每版仅 1 张，四周白边不可裁掉用于拼版',
    };
  }

  const best = bestTiling(paper.printWidthMm, paper.printHeightMm, spMm.w, spMm.h, margin, gap);
  const pw = best.photoRotated ? spMm.h : spMm.w;
  const ph = best.photoRotated ? spMm.w : spMm.h;
  return {
    paperId, specId, dpi,
    tileable: true,
    count: best.count,
    cols: best.cols, rows: best.rows,
    paperRotated: best.paperRotated,
    photoRotated: best.photoRotated,
    photoFootprintPx: { w: mmToPx(pw, dpi), h: mmToPx(ph, dpi) },
    sheetPx: sheetPixelSize(paper),
  };
}

module.exports = {
  PAPERS, DEFAULT_MARGIN_MM, DEFAULT_GAP_MM,
  mmToPx, getPaper, listPapers, sheetPixelSize, planLayout,
};
