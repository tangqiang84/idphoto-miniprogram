'use strict';
// 颜色输入解析与背景形态归一化（纯函数，框架无关，Node 可单测）
//
// 【为什么在 core 层做】
//   1) 底色以 HEX 字符串在页面/服务层之间流转（renderService.bgHex、compliance 的 measured.bg），
//      但用户手输 / 扫码 / 复制粘贴进来的可能是 '#438EDB'、'#438edb'、'rgb(67,142,219)'、'67,142,219'
//      四种写法 —— 各页面各写一套正则必然漂移，且 'rgb(300,0,0)' 这类越界值会被静默当成黑色。
//      故统一收口到这里：**解析失败一律返回 null，绝不猜默认值**。
//   2) 渐变底（PRD 需求项）需要 bgHex 支持 null | string | {type:'gradient',...} 三种形态。
//      core 层的合成函数（matting.composite）过去只认字符串；本模块提供 resolveBackground
//      把三种形态归一化，**合成层按对象处理**（见 sampleGradient / matting.composite）。
//
// 【不做什么】不做色彩空间转换（不做 sRGB↔线性 RGB、不做 CMYK），不做取色器。

const HEX6 = /^#([0-9a-fA-F]{6})$/;
const HEX3 = /^#([0-9a-fA-F]{3})$/;
const RGB_FN = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i;
const RGB_CSV = /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/;

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function toHex(r, g, b) {
  const h = (n) => n.toString(16).toUpperCase().padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}

/**
 * 解析用户输入的颜色。
 * 支持：#RRGGBB / #RGB / rgb(r,g,b) / r,g,b（大小写不敏感，允许空格）
 * @param {string} str
 * @returns {{hex:string, rgb:number[]}|null} 非法一律 null（不猜默认值）
 */
function parseColorInput(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;

  let m = HEX6.exec(s);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return { hex: toHex(r, g, b), rgb: [r, g, b] };
  }

  m = HEX3.exec(s);
  if (m) {
    // #RGB → #RRGGBB（每位重复一次）
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    return { hex: toHex(r, g, b), rgb: [r, g, b] };
  }

  m = RGB_FN.exec(s);
  if (!m) m = RGB_CSV.exec(s);
  if (m) {
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    // 越界（如 rgb(300,0,0)）→ 非法，不静默截断
    if (r > 255 || g > 255 || b > 255) return null;
    return { hex: toHex(r, g, b), rgb: [r, g, b] };
  }

  return null;
}

/**
 * 归一化底色形态。接受三种输入：
 *   · null / undefined  → { type:'transparent' }   （透明底 PNG 导出）
 *   · string（HEX）      → { type:'solid', hex, rgb }
 *   · {type:'gradient', from, to, angle} → { type:'gradient', from:{hex,rgb}, to:{hex,rgb}, angle }
 * 非法输入 → { type:'invalid', reason }
 *
 * ⚠️ 合成层适配说明：matting.composite 已按本模块的返回结构处理 solid / gradient；
 *    若新增别的底色形态，需要同时改本模块 + matting.composite + sampleGradient 三处。
 */
function resolveBackground(bg) {
  if (bg === null || bg === undefined) {
    return { type: 'transparent', hex: null, rgb: null };
  }
  if (typeof bg === 'string') {
    const c = parseColorInput(bg);
    if (!c) return { type: 'invalid', reason: 'unparsable_color', hex: null, rgb: null };
    return { type: 'solid', hex: c.hex, rgb: c.rgb };
  }
  if (typeof bg === 'object' && bg.type === 'gradient') {
    const from = parseColorInput(bg.from);
    const to = parseColorInput(bg.to);
    if (!from) return { type: 'invalid', reason: 'bad_gradient_from', hex: null, rgb: null };
    if (!to) return { type: 'invalid', reason: 'bad_gradient_to', hex: null, rgb: null };
    let angle = 0;
    if (bg.angle !== undefined && bg.angle !== null) {
      if (typeof bg.angle !== 'number' || !isFinite(bg.angle)) {
        return { type: 'invalid', reason: 'bad_gradient_angle', hex: null, rgb: null };
      }
      angle = bg.angle;
    }
    return {
      type: 'gradient',
      from: { hex: from.hex, rgb: from.rgb },
      to: { hex: to.hex, rgb: to.rgb },
      angle,
    };
  }
  return { type: 'invalid', reason: 'unsupported_background', hex: null, rgb: null };
}

/**
 * 渐变取色：给定归一化后的 gradient 描述与像素坐标，返回该点颜色 [r,g,b]。
 * angle 约定（度）：0 = 从左到右，90 = 从上到下（即 CSS 之外的简化约定，页面需显式告知用户）。
 */
function sampleGradient(desc, x, y, w, h) {
  const rad = (desc.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // 投影到渐变轴：t ∈ [0,1]
  const proj = (x + 0.5) * dx + (y + 0.5) * dy - Math.min(0, dx * w) - Math.min(0, dy * h);
  const span = Math.abs(dx) * w + Math.abs(dy) * h;
  let t = span > 0 ? proj / span : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const a = desc.from.rgb;
  const b = desc.to.rgb;
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

module.exports = {
  parseColorInput,
  resolveBackground,
  sampleGradient,
  toHex,
  clamp255,
};
