// 证件照规格库（纯数据 + 查询，无平台依赖）
// 尺寸单位 mm；像素按 dpi 计算： round(mm / 25.4 * dpi)
//
// 【数值裁决说明】2026-10-23 owner 拍板：以「目标机构官方公开口径」为唯一准则
// （原任务 #8 / 问题台账 #13）。PRD 正文 8.1 原写的护照 354×472、驾照 378×504
// 系网传错值，已按官方口径更正并回写 PRD。
// 每条规格带 source 字段标注官方来源，便于日后随官方更新维护（PRD 8.1「随官方更新维护」）。
//
// 头部占比口径：官方同时用「头部宽度 mm」「头部长度 mm」两个物理量表述，
// 本库统一换算为「头长占照片高度的比例」区间（headHeightRatioMin/Max），
// 与端侧 faceDetect 的实测口径（下巴到头顶 / 图高）一致。

const DPI_STD = 300; // 基础档（免费）
const DPI_HD = 600; // 高清档（付费明示）

// 允许底色（标准值）
// 蓝底有两个真实行业色值，场景不同不可混用：
//   blue       #438EDB = R67 G142 B219  标准深蓝（公安蓝）：护照 / 考研 / 公考
//   blueLight  #00BFF3 = R0  G191 B243  浅蓝（天蓝）：四六级 / 学信网 / 普通话
const BG = {
  white: '#FFFFFF',
  blue: '#438EDB', // 标准深蓝（公安蓝）R67 G142 B219
  blueLight: '#00BFF3', // 浅蓝（天蓝）R0 G191 B243
  red: '#FF0000', // 标准红底 R255 G0 B0
  gray: '#C0C0C0', // 标准灰底 R192 G192 B192
};

const SPECS = [
  {
    id: 'one-inch',
    name: '一寸',
    widthMm: 25, heightMm: 35,
    bg: ['white', 'blue', 'blueLight', 'red'],
    maxKb: 200,
    headHeightRatioMin: 0.61,
    headHeightRatioMax: 0.71,
    note: '最常用：简历、社保、学生证等',
    source: '行业通用：25×35mm @300dpi = 295×413px；头部约占 2/3',
  },
  {
    id: 'small-one-inch',
    name: '小一寸',
    widthMm: 22, heightMm: 32,
    bg: ['white', 'blue', 'blueLight', 'red'],
    maxKb: 200,
    headHeightRatioMin: 0.59,
    headHeightRatioMax: 0.69,
    note: '驾驶证、体检等',
    source: '公安部令172号：驾驶人相片 32mm×22mm，头宽 14~16mm、头长 19~22mm（@300dpi = 260×378px）',
  },
  {
    id: 'driver-license',
    name: '驾驶证',
    widthMm: 22, heightMm: 32,
    bg: ['white'],
    maxKb: 200,
    headHeightRatioMin: 0.59,
    headHeightRatioMax: 0.69,
    note: '交管 12123 专用：白底、22×32mm',
    source: '《机动车驾驶证申领和使用规定》(公安部令172号) 第十二条：照片 32mm×22mm，头宽 14~16mm、头长 19~22mm，白底',
  },
  {
    id: 'two-inch',
    name: '二寸',
    widthMm: 35, heightMm: 49,
    bg: ['white', 'blue', 'blueLight', 'red'],
    maxKb: 200,
    headHeightRatioMin: 0.61,
    headHeightRatioMax: 0.71,
    note: '毕业证、简历、部分签证',
    source: '行业通用：35×49mm @300dpi = 413×579px；头部约占 2/3',
  },
  {
    id: 'small-two-inch',
    name: '小二寸',
    widthMm: 35, heightMm: 45,
    bg: ['white', 'blue', 'blueLight'],
    maxKb: 200,
    headHeightRatioMin: 0.61,
    headHeightRatioMax: 0.71,
    note: '护照（中国）、部分签证',
    source: '行业通用：35×45mm @300dpi = 413×531px；国内主流用法头部约占 2/3（申根/日本签证另要求头长 32~36mm，偏大）',
  },
  {
    id: 'big-one-inch',
    name: '大一寸',
    widthMm: 33, heightMm: 48,
    bg: ['white', 'blue', 'blueLight', 'red'],
    maxKb: 200,
    headHeightRatioMin: 0.61,
    headHeightRatioMax: 0.71,
    note: '护照、签证、公务员考试',
    source: '行业通用：33×48mm @300dpi = 390×567px',
  },
  {
    id: 'big-two-inch',
    name: '大二寸',
    widthMm: 35, heightMm: 53,
    bg: ['white', 'blue', 'blueLight'],
    maxKb: 200,
    headHeightRatioMin: 0.61,
    headHeightRatioMax: 0.71,
    note: '简历、部分资格考试',
    source: '行业通用：35×53mm @300dpi = 413×626px',
  },
  {
    id: 'passport-cn',
    name: '中国护照',
    widthMm: 33, heightMm: 48,
    bg: ['white'],
    maxKb: 200,
    headHeightRatioMin: 0.58,
    headHeightRatioMax: 0.69,
    note: '白底，头长 28~33mm',
    source: '国家移民管理局《出入境证件相片照相指引》：33mm×48mm，头宽 21~24mm、头长 28~33mm（≈58%~69% 图高），白底',
  },
  {
    id: 'visa-us',
    name: '美国签证',
    widthMm: 50.8, heightMm: 50.8, // 2×2 英寸精确值：50.8mm → 300dpi = 600×600px（官方硬指标）
    bg: ['white'],
    maxKb: 240,
    headHeightRatioMin: 0.49,
    headHeightRatioMax: 0.69,
    note: '2×2 inch 正方形，白底，600×600px',
    source: '美国国务院 DS-160：2×2 英寸（50.8×50.8mm）@300dpi = 600×600px；头高 25~35mm（≈49%~69%），文件 54~240KB',
  },
];

function mmToPx(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}

function getSpec(id) {
  return SPECS.find((s) => s.id === id) || null;
}

function listSpecs() {
  return SPECS.map((s) => ({
    id: s.id,
    name: s.name,
    note: s.note,
    widthMm: s.widthMm,
    heightMm: s.heightMm,
    bg: s.bg,
    maxKb: s.maxKb,
    source: s.source,
  }));
}

function getPixelSize(specOrId, dpi = DPI_STD) {
  const spec = typeof specOrId === 'string' ? getSpec(specOrId) : specOrId;
  if (!spec) return null;
  return {
    width: mmToPx(spec.widthMm, dpi),
    height: mmToPx(spec.heightMm, dpi),
    dpi,
  };
}

// 底色中文名（页面与预审提示用）
const BG_LABELS = {
  white: '白底',
  blue: '标准深蓝 #438EDB',
  blueLight: '浅蓝 #00BFF3',
  red: '红底',
  gray: '灰底',
};

// 规格下拉项展示文案：名称（官方像素 · 用途）
function specLabel(specOrId, dpi = DPI_STD) {
  const spec = typeof specOrId === 'string' ? getSpec(specOrId) : specOrId;
  if (!spec) return '';
  const px = getPixelSize(spec, dpi);
  const pxText = px ? `${px.width}×${px.height}px` : '';
  return `${spec.name}（${pxText} · ${spec.note}）`;
}

module.exports = {
  SPECS, BG, BG_LABELS, DPI_STD, DPI_HD,
  mmToPx, getSpec, listSpecs, getPixelSize, specLabel,
};
