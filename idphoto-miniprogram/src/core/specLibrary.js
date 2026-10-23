// 证件照规格库（纯数据 + 查询，无平台依赖）
// 尺寸单位 mm；像素按 dpi 计算： round(mm / 25.4 * dpi)
// 数据来源：国内常用证件照标准（一寸/二寸/护照/签证等），见 PRD 规格库章节。

const DPI_STD = 300; // 基础档（免费）
const DPI_HD = 600; // 高清档（付费明示）

// 允许底色（标准值）
const BG = {
  white: '#FFFFFF',
  blue: '#438EDB', // 标准蓝底
  red: '#FF0000', // 标准红底
  gray: '#C0C0C0', // 标准灰底（PRD 8.1：R192 G192 B192）
};

const SPECS = [
  {
    id: 'one-inch',
    name: '一寸',
    widthMm: 25, heightMm: 35,
    bg: ['white', 'blue', 'red'],
    maxKb: 100,
    headHeightRatio: 0.66,
    note: '最常用：简历、社保、学生证等',
  },
  {
    id: 'small-one-inch',
    name: '小一寸',
    widthMm: 22, heightMm: 32,
    bg: ['white', 'blue', 'red'],
    maxKb: 100,
    headHeightRatio: 0.66,
    note: '驾驶证、体检等',
  },
  {
    id: 'two-inch',
    name: '二寸',
    widthMm: 35, heightMm: 49,
    bg: ['white', 'blue', 'red'],
    maxKb: 200,
    headHeightRatio: 0.66,
    note: '毕业证、简历、部分签证',
  },
  {
    id: 'small-two-inch',
    name: '小二寸',
    widthMm: 35, heightMm: 45,
    bg: ['white', 'blue'],
    maxKb: 200,
    headHeightRatio: 0.66,
    note: '护照（中国）、部分签证',
  },
  {
    id: 'big-one-inch',
    name: '大一寸',
    widthMm: 33, heightMm: 48,
    bg: ['white', 'blue', 'red'],
    maxKb: 200,
    headHeightRatio: 0.67,
    note: '护照、签证、公务员考试',
  },
  {
    id: 'big-two-inch',
    name: '大二寸',
    widthMm: 35, heightMm: 53,
    bg: ['white', 'blue'],
    maxKb: 200,
    headHeightRatio: 0.66,
    note: '简历、部分资格考试',
  },
  {
    id: 'passport-cn',
    name: '中国护照',
    widthMm: 33, heightMm: 48,
    bg: ['white'],
    maxKb: 200,
    headHeightRatio: 0.7,
    note: '白底，头部占 70% 左右',
  },
  {
    id: 'visa-us',
    name: '美国签证',
    widthMm: 51, heightMm: 51,
    bg: ['white'],
    maxKb: 240,
    headHeightRatio: 0.5,
    headHeightRatioMax: 0.69,
    note: '2x2 inch 正方形，白底',
  },
];

function mmToPx(mm, dpi) {
  return Math.round((mm / 25.4) * dpi);
}

function getSpec(id) {
  return SPECS.find((s) => s.id === id) || null;
}

function listSpecs() {
  return SPECS.map((s) => ({ id: s.id, name: s.name, note: s.note }));
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

module.exports = { SPECS, BG, DPI_STD, DPI_HD, mmToPx, getSpec, listSpecs, getPixelSize };
